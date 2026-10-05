# Agent guide (read this first in a new chat/session)

This repo is a reusable environment for building Godot games: headless Godot on the server,
rendering in a browser, connected by the bridge server. See README.md for the architecture.
The `godot-agent-sandbox` skill (`.claude/skills/godot-agent-sandbox/SKILL.md`) has the full workflow;
users can also save it as a personal skill so sessions without this repo know how to start.

## Setting up a fresh sandbox (≈10 s)

```bash
scripts/bootstrap.sh                                   # Godot 4.7.2 + web templates + deps + server on :8790
scripts/bootstrap.sh --project <git-url> --id <id>     # also clone + adopt a game repo (repeatable)
node scripts/headless-player.js <id> > /tmp/player.log 2>&1 &   # live browser session for the agent
```
- Don't pipe bootstrap through `| tail`/`| head`: the background server keeps the pipe open and the call hangs.
- `gck` is linked into `~/.local/bin`; otherwise use `node cli/gck.js`.
- Godot binary is `~/.local/bin/godot` (export `GODOT_BIN` if needed). Projects live in `~/.gck/projects/<id>`
  (template-created) or `~/.gck/repos/<id>` (adopted via bootstrap).

## Working loop

1. Edit files in the project directory. Saving triggers import → validate → export → git commit → browser reload.
   Or run `gck build <id>` to get the result synchronously (exit code 1 on failure).
2. Fix every error reported with `file:line` in `steps.validate.errors/failures`.
3. `gck test <id>` (headless, fast) and `gck test <id> --browser` (real web runtime).
4. Check behaviour live: `gck shot <id> -o /tmp/s.png` (then view the image), `gck state <id>`,
   `gck input <id> --action <name> --frames 20`, `gck eval <id> "<expr>"`, `gck logs <id> --errors`.
5. Commit/push the game repo yourself when the user wants it on GitHub (build commits are local).

## Gotchas

- Web builds use the **Compatibility renderer**; keep `renderer/rendering_method="gl_compatibility"`.
- `eval` uses Godot `Expression`: no assignment or statements. Use `obj.set("prop", value)`, `obj.call(...)`.
  Constants: `scene.get_script().get_script_constant_map()["NAME"]`. Variables: `tree`, `root`, `scene`, `bridge`.
- Headless/native sessions can't screenshot; the browser (or headless player) can.
- Add `get_agent_state()` to scenes/autoloads to expose game-specific state to `gck state`.
- Tests: `tests/test_*.gd`, `extends GameTest`, methods `test_*`, may `await`. See README.
- After changing `addon/agent_bridge/`, run `gck update-bridge <id>` for each project.
- Kit self-test: `node test/e2e.js` (creates a throwaway project; needs Chromium, set CHROME_PATH if not auto-found).
