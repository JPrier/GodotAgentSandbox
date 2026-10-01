# Quick game test prompt

Paste this into a new Claude chat (with GitHub access to this repo) to smoke-test the whole setup:

---

Clone https://github.com/JPrier/GodotAgentSandbox and follow its CLAUDE.md.

1. Run `scripts/bootstrap.sh`, then `gck new dodge` and start `node scripts/headless-player.js dodge > /tmp/player.log 2>&1 &`.
2. Turn the starter into a tiny "Dodge" game: red squares fall from the top at increasing speed, the player
   moves left/right with the existing actions, touching a square ends the run, a Label shows survival time,
   and pressing `ui_accept` restarts after game over. Keep it to plain Node2D/Polygon2D, no assets.
3. Expose `get_agent_state()` with `{alive, time, hazards}` and add `tests/test_dodge.gd` covering:
   hazards spawn over time, collision sets `alive=false`, restart resets the timer.
4. Iterate until `gck build dodge --tests` passes, then verify live in the browser session:
   `gck state dodge`, hold `move_left` for 30 frames with `gck input`, and take `gck shot dodge -o /tmp/dodge.png`.
   Look at the screenshot and fix anything that looks wrong.
5. Report: test results, the final screenshot, the build/hot-reload times, and anything in the kit that
   was confusing or broken (fix kit bugs in this repo and commit them).

---

Expected: about 10 s of setup, then a few build/test iterations of ~15 s each.
