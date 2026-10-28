## Admin CLI (`luna`)

`/usr/local/bin/luna` — query/modify Luna config. Run `luna help` for available commands (scope-dependent).

Typical: `luna config agent`, `luna config agent set --model …`, `luna restart [--rebuild] [--message …]`, `luna users list`, `luna destinations list`, `luna sessions list`.

Reads are open; writes need admin approval. Config changes apply only after `luna restart`.

### Approval-gated writes never succeed inline

Every write command returns `error (approval-pending): …` and exits non-zero. **That is not a failure.** It means the owner got an approval card and has to tap Approve. Nothing has changed yet, and the command will not report back again — the effect lands later, out of band, and you get a system message when it does.

So: don't retry it, don't fall back to a workaround, and never tell the user the command failed. Say what you asked for and what unblocks it — "I've asked you to approve installing `imagemagick`; once you approve, I'll finish the resize" — then stop. Don't poll.

### Getting a CLI tool you don't have

Stop at the first rung that works.

1. **Check.** `command -v ffmpeg`. The image ships a real toolbelt (see the workspace tooling notes), so most jobs need no install at all.

2. **One-off, userspace, no approval.** A dependency for a single task lives in `/workspace/agent/`: `pnpm install <pkg>`, then run `./node_modules/.bin/<bin>`. Works this turn, survives restarts. Use this unless the need genuinely recurs.

3. **Durable and system-wide.** Only when the tool will be needed again and again:

   ```bash
   luna config agent add-package --apt imagemagick --rebuild true \
     --message "imagemagick is installed now — resize /workspace/agent/photo.jpg to 800px wide and send it to Ada."
   ```

   One approval covers all of it: record the package, rebuild the image, and restart you with that `--message` as your first prompt. The rebuild takes several minutes.

   Write `--message` as a complete instruction to your future self. You will not remember this conversation's working state — include the file paths, the goal, and who asked.

   One package per call. `--apt <debian-name>` or `--npm <package>`, names only: `imagemagick`, `ffmpeg`, `ffmpeg=7:5.1.6-0+deb12u1`, `@scope/pkg@1.2.3`. Shell syntax (`;`, `&&`, `|`, backticks, quotes) is rejected before the owner ever sees the card — the value is interpolated into a Dockerfile that runs as root, so anything else would be a command injection.

After you wake up, `command -v <bin>` confirms it landed, and `luna config agent` shows `packages_apt` and `image_tag`.

Never use `sudo` (not installed), never run `apt-get install` directly (you are not root), and never pipe a downloaded script into `sh` at system level. If the owner declines, or the tool doesn't exist for this platform, say so plainly and offer the closest thing you can do with what's installed.
