# Godot Agent Sandbox

A reusable environment for building Godot games with a cloud AI agent. The agent edits and builds on a server, and the game renders and is playtested in your browser. You don't need a GPU VM per user, and the same setup works for any number of games.

```
 ┌──────────── server (cloud / VM / sandbox) ────────────┐        ┌──────── your browser ─────────┐
 │ agent ──edits──► game repos (git)                     │        │  /play/<id>  shell page        │
 │   │               │ file watcher                       │        │   ├─ status · console · buttons│
 │   │               ▼                                    │  WS    │   └─ iframe: Godot web runtime │
 │   │   headless Godot: import → validate → tests → .pck ├───────►│        (engine cached, only    │
 │   │               │ git snapshot of every good build   │        │         the .pck reloads)      │
 │   ▼               ▼                                    │◄───────┤  AgentBridge autoload answers: │
 │ gck CLI / MCP ─► bridge server (REST + WebSocket) ─────┤ screenshots, state, logs, errors,│
 │                                                        │ input, eval, test results        │
 └────────────────────────────────────────────────────────┘        └────────────────────────────────┘
```

**Why this shape:**
- **Rendering happens in the browser.** Godot's web runtime (WebAssembly + WebGL2, Compatibility renderer) draws the game on your machine, so the server needs no GPU.
- **The server owns the source of truth.** Real files, git history, and headless Godot for import, validation, tests and export. That sidesteps the browser filesystem, IndexedDB persistence and export limitations.
- **Hot reload is cheap.** The engine `.wasm`/`.js` are served with immutable URLs and cached once per Godot version. Each build is just a new `.pck` (tens of KB to a few MB), and the iframe restarts on it in about a second.
- **Broken builds never replace a working one.** If validation fails, the browser keeps running the last good build and shows the errors with `file:line`.

## Quick start

```bash
git clone https://github.com/JPrier/GodotAgentSandbox && cd GodotAgentSandbox
scripts/bootstrap.sh              # Godot + web templates + deps + server, ~10s on a fast link
gck new my-game                   # starter game, git repo, first build
# open http://<host>:8790/play/my-game
```

`bootstrap.sh` is idempotent. Its options:
- `--web-editor` also installs the browser-based Godot editor (served at `/editor/`).
- `--project <git-url> [--id name]` clones and adopts existing games, and can be repeated.
- `--threads` adds the threaded web templates.
- `--no-start` installs without starting the server.

The Godot version is set with `GODOT_VERSION`, default `4.7.2`. Only the web parts of the 1.2 GB template archive are downloaded, using HTTP range requests (about 20 MB).

### Persistent server (recommended for real use)

```bash
docker build -t godot-agent-sandbox .
docker run -d -p 8790:8790 -v gck:/data -e GCK_TOKEN=change-me godot-agent-sandbox
# open http://host:8790/?token=change-me
```

### Ephemeral sandbox (e.g. a Claude chat)

Your browser usually can't reach a sandbox. The agent can give itself a live browser session there instead:

```bash
scripts/bootstrap.sh --project https://github.com/you/your-game
node scripts/headless-player.js your-game &   # headless Chromium on /play/your-game
gck shot your-game -o shot.png                # the agent can see the game now
```

## Using an existing game

```bash
gck adopt my-game /path/to/godot/project
```

This copies `addons/agent_bridge/` into the project, registers the `AgentBridge` autoload, and adds a `Web` export preset if there isn't one. If the project uses Forward+/Mobile, it also forces the Compatibility renderer for web only, because those renderers don't run in browsers. Game code is not touched. After upgrading the kit, run `gck update-bridge my-game`.

## Agent interface

Three equivalent ways in:

- **CLI:** `gck help`. Every command prints JSON and exits non-zero on failure.
- **MCP:** for Claude Code and other MCP agents. Screenshots are returned as images.
  `claude mcp add godot -e GCK_URL=http://localhost:8790 -- node /path/to/mcp/server.js`
- **HTTP/WebSocket:** described below.

| What | CLI | Runs |
|---|---|---|
| Build: import, validate, (tests), export `.pck`, git commit, hot-reload browsers | `gck build <id> [--tests]` | server |
| Validate every script/scene with `file:line` errors | `gck validate <id>` | server |
| Run `tests/test_*.gd` | `gck test <id> [filter] [--browser]` | server or browser |
| Screenshot of what's rendering | `gck shot <id> -o out.png` | browser |
| Game state (`get_agent_state()` hooks) | `gck state <id>` | browser |
| Scene tree, get/set/call, Godot `Expression` eval | `gck tree / get / set-prop / call / eval` | browser |
| Input (actions, keys, mouse; hold N frames) | `gck input <id> --action jump --frames 10` | browser |
| Merged logs: build, console, structured errors | `gck logs <id> --errors --follow` | both |
| Standalone shareable web export | `gck export <id> [--release]` | server |
| Git history of good builds | `gck history <id>` | server |

Saving any file in a project triggers an automatic build. That means an agent working on the server just edits files. An agent elsewhere can use `gck push / pull / ls`, or the files API.

### Writing tests

```gdscript
# tests/test_player.gd
extends GameTest

func test_jump_leaves_ground():
    var level = await load_scene("res://levels/level_1.tscn")
    await tap_action("jump")
    await wait_physics_frames(10)
    assert_lt(level.get_node("Player").position.y, 500.0, "player rose")
```

Helpers available in tests:
- **Scene and timing:** `load_scene`, `wait_frames`, `wait_physics_frames`, `wait_seconds`.
- **Input:** `hold_action`, `tap_action`, `press_key`.
- **Assertions:** `assert_true/false/eq/ne/near/gt/lt/not_null/has_node`.
- **Hooks:** `before_each` and `after_each`.

The same tests run headless in CI and inside the real browser runtime.

### Exposing game state

Add this to any scene or autoload, and `gck state` returns it:

```gdscript
func get_agent_state() -> Dictionary:
    return {"hp": hp, "level": level_name, "enemies": enemies.size()}
```

## Web editor round trip

The web editor stores projects in browser IndexedDB, so the server stays the source of truth:

1. Download `GET /api/projects/<id>/source.zip` and import it in the editor's project manager.
2. Edit in the editor.
3. Use **Project → Tools → Download Project Source**, then upload the zip with `curl -X POST --data-binary @project.zip http://host:8790/api/projects/<id>/source.zip`. Add `?delete=1` to mirror deletions.

Uploaded changes are committed to git and auto-built. Use the web editor only for interactive scene editing; the lightweight loop is agent edits plus the exported runtime.

## HTTP API

All endpoints are under `/api`. If `GCK_TOKEN` is set, they require `Authorization: Bearer <token>`, `?token=`, or the cookie set by visiting a page with `?token=`.

```
GET  /health                         GET  /projects                POST /projects {id,name}
POST /projects/adopt {id,path}       GET  /projects/:id            PATCH /projects/:id {autoBuild,autoCommit,validateOnBuild,testOnBuild}
POST /projects/:id/build {tests,force,reload}   GET /projects/:id/builds/:n
POST /projects/:id/validate          POST /projects/:id/test {filter, where: headless|browser}
POST /projects/:id/export {release}  POST /projects/:id/reload     POST /projects/:id/update-bridge
POST /projects/:id/command {cmd,args,session,timeoutMs}             POST /projects/:id/screenshot {max_width}
GET  /projects/:id/logs?since=&level=error&source=                  GET /projects/:id/sessions
GET  /projects/:id/history           GET|PUT|DELETE /projects/:id/files?path=
GET|POST /projects/:id/source.zip
```

WebSockets:
- `/ws/browser?project=` is used by the shell.
- `/ws/game?project=` is for native or headless games: run with `AGENT_BRIDGE_URL=ws://host:8790/ws/game?project=<id>`.
- `/ws/agent?project=` streams events (logs, builds, sessions) and also accepts `{id,cmd,args}`.

Bridge commands (sent with `gck cmd <id> <name> '<json>'`):
- **Inspect:** `ping`, `info`, `state`, `tree`, `get`, `logs`, `screenshot`.
- **Modify and drive:** `set`, `call`, `eval`, `input`, `wait`.
- **Scene and time control:** `change_scene`, `reload_scene`, `pause`, `time_scale`.
- **Tests:** `run_tests`.
- **Shell:** `shell.reload`, `shell.info`.

## Configuration (env)

`GCK_HOME` (default `~/.gck`) · `GCK_PORT` (8790) · `GCK_TOKEN` · `GODOT_BIN` · `GODOT_TEMPLATES_DIR` · `GCK_WEB_TEMPLATE` (`web_nothreads_debug`) · `GCK_EXPORT_PRESET` (`Web`) · `GCK_KEEP_BUILDS` (10) · `GCK_DEBOUNCE_MS` (700) · `GCK_COMMAND_TIMEOUT_MS` (30000)

## Known limitations

- **Renderer:** web builds use the Compatibility renderer (WebGL2). Forward+-only effects (SDFGI, volumetric fog, etc.) won't appear.
- **Threads:** single-threaded templates are the default, so they work everywhere without cross-origin isolation. Threaded templates (`--threads`, `GCK_WEB_TEMPLATE=web_debug`) need the COOP/COEP headers the server already sends.
- **GDExtension and C#:** GDExtension needs the `dlink` templates. C# projects can't export to web in Godot 4.
- **Build time:** a build takes about 10–15 s, mostly Godot editor start-up for import and export. Live tweaks via `set-prop` and `eval` are instant.
- **Headless screenshots:** headless/native sessions can't screenshot (no renderer). Use a browser or the headless player.
- **Security:** a project's scripts execute on the server during validate and tests. Only host code you trust, and set `GCK_TOKEN` when the server is reachable from a network.

## Layout

```
server/      bridge server (Node, deps: ws, adm-zip)
addon/       agent_bridge Godot addon (autoload, validator, test runner, GameTest)
web/         browser shell + engine host page
cli/gck.js   agent CLI          mcp/server.js   MCP server
template/    starter game       scripts/        install, bootstrap, headless player, zip range fetcher
test/e2e.js  end-to-end test (real Godot + real Chromium)
```
