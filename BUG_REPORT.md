# YouTube Pipeline — Bug & Isolation Review

**Prepared for:** 3-user deployment of gageditor.com (you + 2 others, fully separated)
**Date:** 2026-06-10
**Status:** Findings only — nothing has been changed. Review and tell me what to fix.

---

## How to read this

The big question for your setup is: *can the 2 other users see or disturb your channels, videos, YouTube logins, or settings — and vice versa?* Most of the database layer is actually scoped correctly per user. The serious problems are concentrated in **three places**: the login bypass, one debug endpoint, the shared-secrets settings, and the **entire VNC / channel-login subsystem**, which was built as a single global thing and will collide when 2+ people use it at once.

Severity key: **CRITICAL** = real cross-user leak or breakage; **HIGH** = isolation/security weakness; **MEDIUM** = correctness bug or hardening.

---

## CRITICAL — must fix before 3 people use it

### C1. Localhost requests are auto-logged-in as you (admin)
`server/index.js:99-105`. Any request whose Host header is `localhost`/`127.0.0.1` is silently logged in as **user 1 (you) with admin rights**, no password. Whether this is currently exploitable depends on how nginx forwards the Host header, but it's a backdoor that must be removed for a real multi-user product. `trust proxy` is also not configured, so the raw Host header is trusted.

### C2. `/api/channels/debug-db` dumps everyone's data
`server/routes/channels.js:866`. No user filter, no admin gate. Any logged-in user can list **all** channels (names, YouTube channel IDs, profile names, cookie status) and the 20 most recent scheduled posts **across all 3 users**. Straight cross-user data leak. Should be admin-only or deleted.

### C3. The VNC channel-login screen is a single global session
`server/services/vnc.js` (and `server/index.js:182`). The browser-login feature uses one hardcoded display/port (`:99`, `5999`, `6080`, `9222`) and one global `vncSession`. Consequences when 2 people use it at once:

- Starting a login **kills the other person's** in-progress login (`launchVncSession` calls `stopVncSession()` first).
- Both users' noVNC traffic is proxied to the **same port 6080**, so one user can end up viewing/controlling the other's Chrome window — including their Google login.

This is the single biggest concurrency problem for your use case.

### C4. Any upload/reschedule/sync kills another user's live login
`server/services/puppet.js` — `closeBrowserSession()` and every browser operation call the global `stopVncSession()` (which has no user/channel argument). So if User A's scheduled upload fires while User B is typing their Google password in the login screen, **B's login is destroyed mid-flow.**

### C5. "Fresh" logins share one folder and wipe each other
`server/routes/channels.js:276` + `vnc.js:136`. A fresh channel login defaults to a shared profile folder `yt_setup_new`, and launching a fresh login **deletes that folder first**. Two users logging in a new channel around the same time overwrite each other's YouTube cookies into the same directory — cross-contaminated logins.

---

## HIGH — isolation & security weaknesses

### H1. Shared API keys / secrets in the global `settings` table
Several secrets live in the global `settings` table (one shared row, not per-user):

- **Webshare proxy API key** — `proxyPool.js:99`. All 3 users share one key; each save overwrites the others'.
- **Gemini / OpenAI / Groq keys & Google OAuth client id/secret** — `gemini.js`, `videoCleanup.js`, `media.js:272`, `youtube.js`. These read the per-user key first but **fall back to the global key**, so a key one person saves globally gets silently used (and billed) by others.

For true separation, each user should supply and use only their own keys.

### H2. Browser profiles are not namespaced per user
`channels.js:209` + schema. Profile folders are `profile_<name>` with no user prefix, and `profile_name` has no per-user uniqueness. If two users pick the same profile name ("main"), they collide — one gets a 409 error, or worse, ends up pointed at the other user's profile directory (and their logged-in YouTube cookies). Proxy-to-profile bindings (`proxy_for_profile_*`) are likewise keyed by name only, so they leak across users too.

### H3. Bulk scheduling acts on channels before checking ownership
`server/routes/schedule.js:498-504`. In `POST /api/schedule/bulk`, the code runs `syncChannelWithYouTube()` on every `channelId` from the request **before** verifying you own them (ownership is checked later, at line 527). That sync can cancel posts and reset asset flags. A user could pass someone else's channel ID and trigger side effects on it. Ownership must be checked first.

### H4. Weak session configuration
`server/index.js:74,77`. The session secret falls back to a hardcoded `'youtube-pipeline-secret'` if `SESSION_SECRET` isn't set in `.env` (guessable secret → forgeable logins), and `cookie.secure` is `false` (cookies allowed over plain HTTP). Both should be hardened for production (random secret, secure cookies over HTTPS).

---

## MEDIUM — correctness bugs & hardening

### M1. `user_id INTEGER DEFAULT 1` everywhere
Schema-wide. Most tables default `user_id` to 1. If any insert ever forgets to set the user, the row silently becomes **yours** (user 1). It's a latent footgun that amplifies C1. A couple of routes also do `req.session.userId || 1` (e.g. `media.js:660`), degrading safety.

### M2. Timezone shift when rescheduling via the official API
`server/services/youtube.js:395`. `new Date("2026-06-13T19:30:00").toISOString()` treats your time as the **server's** timezone (UTC), not Turkey, so API-mode schedules land hours off. Your channels are browser-mode today so this is latent, but it'll bite anyone using API mode.

### M3. Premieres forced to private in API reschedule
`server/routes/schedule.js:236`. On reschedule, API mode forces `privacy = 'private'`, which breaks a Premiere (premieres must stay public-scheduled). Latent (browser-mode unaffected), but wrong.

### M4. Startup self-heal is global
`server/db/database.js:298-321`. On restart, all `processing` posts and active pipeline runs for **every** user are reset to `error`. Acceptable at boot (no user context exists), but worth knowing: a restart aborts everyone's in-flight uploads, not just one person's.

---

## Confirmed SAFE (reviewed, no problem)

- WebSocket puppet control checks channel ownership before acting (`index.js:152`).
- Per-channel browser profile paths, the `killOrphanedChrome` cleanup (scoped to the target profile only — does not kill all Chrome), the per-channel `activeSetupSessions` map, and per-user pipeline run tracking are all correctly isolated.
- Proxies are passed per-launch (no global proxy env mutation).
- Core CRUD in channels, media, schedule, comments, presets, settings, ai, auth, client routes is properly scoped to `user_id` / verified channel ownership (aside from the specific exceptions above).

---

## Suggested fix order

1. **C1, C2** — remove the localhost backdoor and lock down/delete `debug-db`. (Small, high impact.)
2. **C3, C4, C5** — rework the VNC/login subsystem for per-user isolation (dynamic ports + per-user profiles, scope `stopVncSession` to a channel/user). This is the largest piece of work.
3. **H2, H3** — namespace profiles per user; check ownership before bulk sync.
4. **H1, H4** — per-user secrets; harden session config.
5. **M1–M4** — defaults, timezone, premiere, as cleanup.

Tell me which of these you want me to fix and I'll start at the top.
