---
name: "godot-agent-sandbox"
description: "Use when building, editing, testing or playtesting a Godot game, or setting up the Godot agent environment, via JPrier/GodotAgentSandbox (gck, headless builds, browser runtime)."
---

# Godot Agent Sandbox

The kit at https://github.com/JPrier/GodotAgentSandbox lets an agent build Godot games. Headless Godot runs on the server, where it builds, validates and tests. The game renders in a browser through the Godot web runtime. A bridge server (REST + WebSocket on :8790) connects the two.

Every new sandbox starts empty, so set the kit up first. It is fast.

## 1. Set up (about 10–15 s)

1. Attach the repo with push access if it isn't already (`add_repo` JPrier/GodotAgentSandbox), then clone it:
   `git clone https://github.com/JPrier/GodotAgentSandbox ~/GodotAgentSandbox && cd ~/GodotAgentSandbox`
2. Run `scripts/bootstrap.sh`. It installs Godot 4.7.2 and the web export templates (only about 20 MB, fetched with HTTP range requests), installs the Node dependencies, and starts the server.
   - Never pipe it through `| tail` or `| head`. The background server holds the pipe open and the call hangs.
   - To also clone and register an existing game repo: `scripts/bootstrap.sh --project <git-url> --id <id>`. The flags can be repeated.
   - Add `--web-editor` only when interactive scene editing in the browser editor is needed.
3. `gck` is linked into `~/.local/bin`; use `node cli/gck.js` if that's not on PATH. Godot is at `~/.local/bin/godot`.
4. Read the repo's `CLAUDE.md`. It is the authoritative, up-to-date guide; prefer it when it differs from this skill.

## 2. Get a live browser session

The user's browser usually can't reach a cloud sandbox. Give yourself one instead:
`node scripts/headless-player.js <id> > /tmp/player-<id>.log 2>&1 &`

If the server runs somewhere the user can reach (their VM, or Docker), give them `gck play-url <id>` instead.

## 3. Create or adopt a game

- New game from the template: `gck new <id>`. This makes a git repo in `~/.gck/projects/<id>`, runs a first build, and starts auto-builds.
- Existing project: `gck adopt <id> <path>`. This installs the `addons/agent_bridge` addon, registers the `AgentBridge` autoload, adds a `Web` export preset, and forces the Compatibility renderer for web.

## 4. Working loop

1. Edit files in the project directory. Saving triggers import → validate → export `.pck` → git commit → browser hot reload, all automatically.
2. For a synchronous result, run `gck build <id> [--tests]`. It exits 1 on failure. Fix every error in `steps.validate.errors` and `failures`; each one has `file:line`.
3. Run tests:
   - `gck test <id>` runs them headless on the server (fast).
   - `gck test <id> --browser` runs them in the real web runtime.
4. Verify behaviour live, then view screenshots with the Read tool:
   - `gck shot <id> -o /tmp/s.png`
   - `gck state <id>`, which returns the game's `get_agent_state()` hooks
   - `gck input <id> --action <name> --frames 20` (also `--key Space` or `--mouse x,y`)
   - `gck eval <id> "<expr>"`, `gck tree <id> --depth 2`, `gck logs <id> --errors`
5. A broken build never replaces the running one. The browser keeps the last good build and shows the errors.

Run `gck help` for the full command list. For MCP, use `claude mcp add godot -e GCK_URL=http://localhost:8790 -- node ~/GodotAgentSandbox/mcp/server.js`; screenshots come back as images.

## Writing games so agents can test them

- Expose state on scenes or autoloads:
  `func get_agent_state() -> Dictionary: return {"hp": hp, ...}`
- Write tests in `tests/test_*.gd` with `extends GameTest`, using `test_*` methods that may `await`.
  - Scene and timing helpers: `load_scene`, `wait_frames`, `wait_physics_frames`, `wait_seconds`.
  - Input helpers: `hold_action`, `tap_action`, `press_key`.
  - Assertions: `assert_true/false/eq/ne/near/gt/lt/not_null/has_node`.
- Use InputMap actions for controls so `gck input --action` and `hold_action` can drive them.

## Gotchas

- Web uses the Compatibility renderer (WebGL2). Keep `renderer/rendering_method="gl_compatibility"`, and avoid Forward+-only features.
- C# projects can't export to web. GDExtension needs the dlink templates.
- `eval` uses a Godot `Expression`, so no assignments or statements.
  - Use `obj.set("prop", v)` and `obj.call("m", ...)` instead.
  - Read constants with `scene.get_script().get_script_constant_map()["NAME"]`.
  - Available variables: `tree`, `root`, `scene`, `bridge`.
- Headless or native sessions can't take screenshots. Use the browser or the headless player.
- After changing `addon/agent_bridge/` in the kit, run `gck update-bridge <id>` for each project.
- A build takes about 10–30 s, mostly Godot start-up. For quick tweaks use `gck set-prop` or `eval` live, then make the real change in files.

## Saving work (the sandbox is ephemeral)

- Build commits are local only. When the user wants a game kept, push it to its own GitHub repo: attach the repo with `add_repo`, `git remote add origin ...`, then push and open a PR as the user prefers.
- Kit bug fixes go to JPrier/GodotAgentSandbox on a branch with a PR. Run `node test/e2e.js` first; all checks must pass.
- Before finishing, make sure nothing important exists only inside the sandbox.