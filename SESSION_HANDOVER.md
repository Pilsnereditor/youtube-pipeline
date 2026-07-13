# Session Handover — youtube-pipeline (gageditor.com)

Drop this into a fresh conversation to continue cheaply. It captures everything done, what's live vs pending, the open issue, and how to work in this repo.

---

## The one open issue (start here)

A single scheduled **browser-mode** upload keeps failing to get **scheduled** on YouTube (it uploads as a private draft, but the schedule doesn't apply). Latest error was: "The video edit page did not load the visibility editor in time."

Two expert code audits found the likely root causes, now fixed in code:
- The video-ID reader accepted 6–20 chars; real YouTube IDs are exactly **11**, so it could grab a wrong/partial ID → edit page pointed at a nonexistent video → editor never loads. **Fixed:** now requires exactly 11 chars (`extractVideoId` in `server/services/puppet.js`).
- "Still processing" was a hard failure that burned the 3-retry budget. **Fixed:** now *defers and keeps retrying automatically* until YouTube finishes processing (`processPost` catch in `server/services/scheduler.js`).

**Still needed to confirm for certain:** the real failure screenshot from the VPS at `data/profiles/<profile>/puppet_reschedule_error.png` (or `puppet_upload_error.png`). Nobody can verify live-YouTube DOM behavior from the Claude sandbox — that screenshot is the ground truth.

**Recovery for the current stuck video:** delete its private draft in YouTube Studio → Cancel the failed row in gageditor → re-schedule fresh (so it runs the fixed code).

---

## Session update — 2026-07-12 (bugs 1–3 + thumbnail feedback)

Three user-reported issues (all on **user 2 / browser mode**; user 1 "pilsner" unaffected). Fixes are **logic- and syntax-verified only** — not run against live YouTube. The new toasts will surface any real failure on the first live run after deploy. **Not deployed yet** (needs push + `git pull` + `pm2 restart`).

**Bug 1 — Upload queue stuck on "Uploading…" forever.**
Root cause: the file uploaded fine (100%), but when the in-dialog schedule didn't stick, the enforce-schedule step defers + auto-retries every 3 min until YouTube finishes processing — and that deferral path only sent `schedule:status` (a log line), never `schedule:complete`/`error`, so the frontend's fixed 20% "Uploading…" bar never cleared.
Fix: scheduler now broadcasts a new `schedule:deferred` message; frontend (`handleWSMessage`) flips the bar to "Uploaded ✓ — waiting for YouTube to apply the schedule…" and hides it, then reloads. Files: `server/services/scheduler.js`, `public/app.js`.
NOTE: this fixes the *display*. Whether the schedule actually applies on user 2 still needs the live `puppet_reschedule_error.png` + pm2 logs to confirm the underlying DOM issue.

**Bug 2 — Premiere auto-comment shows "saved" but never appears on YouTube.**
Root cause (timing, not DOM): `checkPendingComments` had `OR sp.is_premiere = 1`, so it tried to comment immediately after upload — but a premiere isn't commentable until it airs (pre-air page is a countdown/live-chat, no comment box). With only 3 retries over ~2.5h, the budget was exhausted long before a premiere scheduled days out aired → marked `error`, comment never posted. The edit modal (PUT route) also fired the comment on save with no feedback.
Fix: (a) scheduler gates premiere comments on air time (`scheduled_at <= @now`) like normal videos; (b) PUT route only posts immediately if the video is already live (`isLiveNow`), else leaves it `pending` for the scheduler to post at air time; (c) comments now report back via `comment:updated` WS toast (success / disabled / failed). Browser comment/thumbnail posts now run under `withChannelLock`. Files: `server/services/scheduler.js`, `server/routes/schedule.js`, `public/app.js`.

**Bug 3 — Change thumbnail on a published video from Publishing Details modal.**
Was already implemented (clickable thumbnail → upload → Save Changes → PUT route pushes to YouTube via `updateThumbnailBrowser`). Only gap: browser-mode push was fire-and-forget/silent. Fix: wrapped it in `withChannelLock` and added a `thumbnail:updated` WS toast (success/fail). Added a `setScheduleBroadcast(broadcast)` injector to the schedule route, wired in `server/index.js`. Files: `server/routes/schedule.js`, `server/index.js`, `public/app.js`.

**New WS message types** (frontend handles all three in `handleWSMessage`): `schedule:deferred`, `comment:updated` `{ok, message}`, `thumbnail:updated` `{ok, message}`.

**Upload flow reworked — commit schedule MID-UPLOAD (⚠️ needs a live run).** Per user request, `uploadVideoBrowser` (puppet.js) no longer waits for the byte-upload to reach 100% before clicking Schedule. New order: fill Details→Elements→Checks→Visibility + set date/time (unchanged, already ran during upload) → wait for the Schedule/Save button to become ENABLED (checks passed; `waitForFunction` on disabled/aria-disabled, up to ~4 min) → click it (video becomes Pending/Scheduled while still uploading) → then KEEP THE BROWSER OPEN, monitoring `document.body` for "uploading NN%" until the bytes finish, and only then `browser.close()`. This removes the old in-dialog 100%-wait loop. Safety: it only closes when confident the upload is gone (indicator seen then absent 3 polls), else waits up to a 5-min fallback / 60-min cap — it never closes while an upload indicator is visible, so it will not abort the transfer. Because the still-open uploads dialog ALSO shows "uploading NN%", the same monitor covers a failed/ignored Schedule click. **This is the single most critical + fragile function and cannot be tested from the sandbox — test ONE video via VNC first** (watch it go Pending mid-upload, confirm bytes finish, confirm the browser closes only after). Easy to revert (isolated to uploadVideoBrowser). Progress % now: 8 start → 10 uploading → 15 scheduling → 15-78 "Scheduled ✓ — uploading X%" → 80 uploaded ✓ → 90 comment → 100.

**Upload progress feature (added).** The Upload Queue bar now shows real % + stage instead of a fixed 20%. `uploadVideoBrowser` (puppet.js) parses YouTube's dialog `NN%` during the completion-monitor loop and calls `opts.onProgress(percent, label)`; the raw 0-100% is mapped into the 12-70% band of the overall bar. `processPost` (scheduler.js) broadcasts `schedule:progress {percent, label, channel, title}` via an `emitProgress` helper (8% start → upload % → 80% uploaded ✓ → 90% posting comment), then `schedule:complete` → 100%. Frontend `handleWSMessage` handles `schedule:progress` by updating `activeUploadProgress` width + `activeUploadPct` label, but only when the bar is already visible (so the channel filter from `schedule:uploading` is respected). Files: `server/services/puppet.js`, `server/services/scheduler.js`, `public/app.js`. NOTE: the % text comes from YouTube's own label — if the format differs it falls back to "Uploading video…" with no number; needs a live run to confirm the exact label.

**Also fixed:** `loadThumbnails()` → `loadMediaThumbnails()` in `handleSchedPostThumbUpload` (public/app.js) — the wrong name threw a ReferenceError after a successful thumbnail upload, showing a false "Failed to upload thumbnail". **Also:** pipeline control grid layout — added `min-width:0` to `.pipeline-control-grid`/`.control-col` and form inputs in `public/index.css` so the form column stops bloating and crushing the Target Channels column.

**⚠️ Mounted-folder write hazard confirmed again:** the Read/Write/Edit file tools **truncated** app.js and scheduler.js mid-write this session. Recovered from git. Reliable method: edit a copy in `/tmp`, `node --check` (`--input-type=module` for ES modules), then `cat /tmp/x > dest` in bash with a line-count + marker-grep + syntax verify/retry loop. Do NOT trust a bare Edit/Write on this mount.

**Review follow-ups (two independent AI reviews + test run).** All 25 sandbox-safe unit tests pass (defer-requeue, atomic-claim, channel-lock, extract-id, date-verify, isolation slots/profiles/proxy/webshare). Reviews found no critical/major defects in the new logic. Two review-driven fixes applied on top:
- `server/routes/schedule.js` — thumbnail update now routes on **`upload_mode === 'browser'` FIRST**, then falls back to `hasToken` (API). Previously it checked `hasToken` first, so a browser-mode channel with a stale/expired oauth token would wrongly hit the API path and 500. (Same `hasToken`-first pattern still exists in the reschedule/details block ~line 234 — pre-existing, not yet changed.)
- `server/services/puppet.js` `updateThumbnailBrowser` — added a **conservative save check**: after clicking Save it throws only if YouTube shows a visible error dialog (too large / invalid / failed). It does NOT require a positive "saved" signal (avoids false failures), but stops the `thumbnail:updated {ok:true}` toast from firing on a rejected save.

Known minor items left (low priority): (a) a premiere longer than ~2.5h could still exhaust the 3-retry comment budget (retries key off premiere START, not END); (b) clearing a comment posts no toast; (c) `comment_next_retry_at` isn't reset when a comment is re-edited; (d) `schedule:deferred` lacks the channel-filter guard that `schedule:uploading` has.

---

## VNC + upload reliability overhaul (2 expert AI reviews, implemented — ⚠️ needs live run)

Fixes the two User-2 symptoms: (A) remote Chrome login stuck on "Connecting"/black screen; (B) scheduled video sticks on "Starting upload…" and never uploads. Two domain-expert agents (VNC/X11/infra + Puppeteer/concurrency) produced specs; implemented centrally. All 4 files pass `node --check`; sandbox unit tests still green (channel-lock, defer-requeue, atomic-claim). Browser/VNC behavior itself is NOT testable from the sandbox — **test live**. Not deployed yet.

**`server/services/vnc.js`** — root cause of "Connecting" was *return-before-ready* + stale X11 locks + non-awaitable kills:
- Added `killProcAsync` (awaitable SIGTERM→SIGKILL, resolves on real exit), `cleanX11Locks` (rm `/tmp/.X{N}-lock` + `/tmp/.X11-unix/X{N}`), `spawnTracked`+`assertAlive` (fail-fast on immediate death), `waitForPort`/`waitForFile` (readiness gates), and `selfHealSlotsOnStartup()` run once at module load.
- Launch is now a gated chain: Xvfb (`-nolisten tcp`) → wait for X socket → openbox → Chrome → wait CDP port → x11vnc (`-localhost`) → wait vnc port → websockify (target `127.0.0.1:` not `localhost:`) → wait ws port. `ws_port` only returned after websockify is confirmed listening. Partial-failure path tears everything down + cleans locks.
- `stopVncSession` now awaits `killProcAsync` for all children + kills orphan Chrome by `remote-debugging-port=${cdpPort}` + cleans locks (fixes the killProc race that left Chrome holding the profile SingletonLock → the "upload never starts" case).
- SLOTS vncPorts shifted 5999-6002 → **5910-5913** (old 6000 collided with X11 `:0`; Xvfb TCP 6099-6102 removed via `-nolisten tcp`).

**`server/index.js`** — `/websockify` TCP proxy: added a 5s CONNECT timeout (→504) cleared on connect (it's an idle timeout; leaving it armed would kill the live stream); 502 on error. Stops the ~75s hang when websockify is dead.

**`server/services/puppet.js`** — the "scheduled → stuck → never uploads" core fix:
- `withChannelLock(channelId, fn, opts)` now runs fn via `guardedChannelRun` with a **liveness watchdog**: `idleMs` (opt-in; abort if no heartbeat) + `hardCapMs` (always-on backstop, default 30 min). On trip it calls `abortChannelBrowser` (killOrphanedChrome + closeBrowserSession) and only rejects AFTER the browser is dead — so the hung op can't hold the lock forever AND the next queued op won't collide on the same locked profile (fixes both the deadlock and my earlier critique of a bare reject). Existing callers are unchanged (ignore `{heartbeat}`, get the 30-min backstop).
- `killOrphanedChrome`: Linux `pgrep` narrowed to `chrome.*<escaped path>` (was matching any process containing the profile path).
- Removed the duplicate `stopVncSessionForProfile` in `uploadVideoBrowser` (closeBrowserSession already does it).
- Bounded the one unbounded await: `page.waitForFileChooser({ timeout: 30000 })`.
- (Deliberately did NOT do the experts' larger reach-dialog IIFE restructure — watchdog + fileChooser timeout already bound every step; avoided restructuring the most fragile path untested.)

**`server/services/scheduler.js`** — the upload call now passes `({ heartbeat }) => …`, wires `heartbeat()` into BOTH `onProgress` and `logFn` (dense liveness proof), and passes `{ idleMs: 8 min, hardCapMs: 90 min }` — 8-min idle catches a genuine stall fast; 90-min cap is above the ~65-min legit worst case (mid-upload monitor) so a slow-but-progressing large upload is never killed.

**One-time VPS cleanup before first restart** (clears existing bad state): kill lingering chrome/Xvfb/x11vnc/websockify, `rm -f /tmp/.X{99,100,101,102}-lock /tmp/.X11-unix/X{99,100,101,102}`, then `git pull` + `pm2 restart`. Do it when the queue is quiet (the pkill will abort any in-flight upload).

---

## Hard environment constraints (important)

- **Cannot test against live YouTube Studio / VNC / real Google login from the Claude sandbox.** All browser-automation fixes are reasoned + unit-tested for *logic* only. Do NOT claim "100% fixed" for browser-DOM behavior — say "logic verified, needs a live run."
- **The mounted project folder is unreliable for writes** (it truncated a file once). Always write via: build in `/tmp`, `node --check --input-type=module`, then `cat /tmp/x > dest` with a verify+retry loop (byte count + parse + marker grep). Git index also got corrupted once.
- **Sandbox can't reach GitHub or the VPS** (proxy blocks it). Push happens via antigravity on the user's machine; deploy is manual on the VPS.
- `better-sqlite3` is Windows-native → can't `require` it in the Linux sandbox. Test DB logic with Python's `sqlite3` against `server/db/schema.sql` instead (see `scratch/test_*.py`).

## Deploy (user does this)
1. antigravity: "Commit and push my changes to GitHub."
2. VPS (when queue is quiet): `cd /var/www/youtube-pipeline && git pull origin main && pm2 restart youtube-pipeline`
- Latest commit as of handover: `7ceb11d` (11-char ID + defer/requeue).
- Optional nginx (prevents 502 on long reschedules): add `proxy_read_timeout 300s;` `proxy_send_timeout 300s;` in the `location /` block, then `sudo nginx -t && sudo systemctl reload nginx`.

---

## What was done this session (all committed)

**Reschedule reliability (browser mode):**
- Time field is a dropdown — now selects the matching option instead of typing+Escape (which reverted it).
- Date verification now checks the field shows the requested day+month+year (catches the "scheduled to a wrong/later date" bug), not just "changed".
- Reschedule retries transient browser errors (detached frame etc.) with a fresh browser.
- Visibility-editor wait is patient: pierces shadow DOM + reloads a few times.

**Scheduler robustness (`server/services/scheduler.js`):**
- Atomic per-channel claim (two uploads can't start on one channel → prevents detached-frame collisions).
- Per-channel lock (`withChannelLock` in puppet.js) serializes same-channel reschedules/uploads; different channels stay parallel.
- Deferrals (channel busy / still processing) re-queue as **pending** without burning retries.
- After upload, if it wasn't actually scheduled, it enforces the schedule on the edit page — and never re-uploads a duplicate (uses saved `youtube_video_id`).

**Multi-user isolation (3 users, must not see each other):**
- Per-user parallel VNC login sessions with a slot pool (`server/services/vnc.js`), websockify routed per user (`server/index.js`), per-user profile namespacing (`channels.js`), VNC teardown scoped to the channel's profile.
- Admin **Proxy Distribution** UI (Users tab) + endpoints (`proxyPool.js`) to assign proxies per user (e.g. 10/5/5).
- Webshare API key is now per-user (was globally shared).

**Security:**
- C1: localhost auto-login backdoor now off unless `ALLOW_LOCAL_ADMIN=true`.
- C2: `/api/channels/debug-db` locked to admins.
- H4: strong auto-generated+persisted session secret, `trust proxy`, `httpOnly`/`sameSite`/auto-secure cookies.

**Cosmetic:** "Refined Aurora" theme (deeper desaturated purple, card depth, softer glow) — `public/index.css` tokens only.

**Tests (re-runnable):** `scratch/test_*.mjs` (node) and `scratch/test_*.py` (python) — slot allocation, proxy distribution/isolation, profile naming, webshare per-user, atomic claim, defer re-queue, channel lock, 11-char ID extraction. ~45 checks, all passing.

## Still pending (lower priority, from BUG_REPORT.md)
- M1: `user_id INTEGER DEFAULT 1` footgun across schema.
- M2/M3: API-mode timezone shift + premiere-forced-private (only bite if a channel uses API mode; current channels are browser mode).
- M4: startup self-heal resets all users' in-flight posts (benign).
- Optional: make reschedule fully asynchronous (removes 502-on-timeout fragility) — bigger backend+frontend change.

## Key files
- `server/services/puppet.js` — all Puppeteer/browser automation (upload, reschedule, VNC, sync).
- `server/services/scheduler.js` — cron processing, retries, per-channel claim/lock, enforce-schedule.
- `server/services/vnc.js` — per-user VNC login sessions.
- `server/routes/schedule.js` — schedule CRUD + reschedule trigger.
- `server/routes/proxyPool.js` — proxies + admin distribution.
- `server/index.js` — auth, session, websockify routing.
- `public/app.js` + `public/index.html` + `public/index.css` — frontend.
- `PROJECT_HANDOVER.md`, `BUG_REPORT.md`, `SOLUTION_A_NOTES.md` — prior context.
