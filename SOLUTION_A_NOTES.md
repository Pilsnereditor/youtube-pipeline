# Solution A + Proxy Distribution — What Changed & How to Test

**Status:** Implemented and syntax-validated. NOT yet tested against the live server — please run the checklist below on the VPS before relying on it. Everything is in git, so it's fully revertible.

---

## What was implemented

### 1. Per-user parallel logins (fixes C3, C4, C5)
The login screen is no longer one shared global session. Each user now gets their own isolated **slot** — a separate virtual screen and set of ports — so up to 4 people can do channel logins at the same time without ever sharing a screen or killing each other's session.

- `server/services/vnc.js` — rewritten: sessions are tracked per user (a `Map` keyed by userId), each assigned a free slot from a pool (`:99/:100/:101/:102`, ports `6080–6083`, etc.). Launch/stop/verify are all per-user. New `stopVncSessionForProfile()` stops only a login that's using a specific profile.
- `server/index.js` — the live-view proxy (`/websockify`) now resolves *who you are* and routes you only to *your* slot's port. A user can no longer reach another user's screen.
- `server/services/puppet.js` — uploads/reschedules/syncs now call the profile-scoped teardown, so they only close a login that's using the exact channel being worked on — never another user's login.
- `server/routes/channels.js` — the login endpoints now pass the user's ID through to all of this.

### 2. Per-user profiles (fixes C5, H2)
- New login profiles are namespaced per user (`profile_<userId>_<name>`, fresh logins `yt_setup_<userId>`), so two users picking the same profile name can never collide or land on each other's logged-in Chrome.
- The profile list now only shows *your* profiles, never other users'.

### 3. Admin proxy distribution (your 10 / 5 / 5 request)
- `server/routes/proxyPool.js` — two new **admin-only** endpoints: list every proxy across all users, and reassign selected proxies to a chosen user (also unlinks a reassigned proxy from any channel not owned by the new user).
- `public/index.html` + `public/app.js` — a new **Proxy Distribution** panel in the Users tab (admin-only): tick proxies, pick a user, click Assign. Each user only sees and uses the proxies assigned to them.

---

## How to deploy

1. In **antigravity**: "Commit and push my changes to GitHub."
2. On the **VPS**:
   ```
   cd /var/www/youtube-pipeline
   git pull origin main
   pm2 restart youtube-pipeline
   ```

> Note: parallel logins need `Xvfb`, `x11vnc`, and `websockify` installed (they already are, since logins work today). No new system packages are required — the new slots reuse the same tools on different ports.

---

## Test checklist (do this on the VPS after deploying)

**Proxy distribution (easy, do first):**
- [ ] As admin, open the Users tab → Proxy Distribution panel. You should see all 20 proxies grouped by owner.
- [ ] Tick 10 proxies, choose User A, click Assign. Tick 5, assign to User B; 5 more to User C.
- [ ] Log in as User B → Proxy Pool should show only B's 5 proxies (not yours, not C's).

**Parallel logins (the important one):**
- [ ] You and one other person both open a channel login at the same time. Both should see *their own* Chrome — neither kills the other, neither sees the other's screen.
- [ ] While someone is mid-login, trigger an upload/reschedule on a *different* channel. The login should stay alive (previously it was killed).
- [ ] Complete a login, confirm the channel links and its cookies save correctly.
- [ ] Confirm a normal scheduled upload still runs and reschedule still works (the time-dropdown fix from earlier).

If a login ever fails with "All login slots are in use," that just means 4 logins are open at once — close one and retry.

---

## Still pending from the bug report (NOT done yet)

These were out of scope for this task but remain in `BUG_REPORT.md`:

- **C1** — the localhost auto-login backdoor (`index.js`). Quick fix, recommended next.
- **C2** — the `debug-db` endpoint that leaks all users' data. Quick fix.
- **H1** — the proxy-provider (Webshare) import key is still stored globally/shared. Proxies themselves are now per-user, but the *import key* isn't — worth making per-user too.
- **H4 / M1–M4** — session hardening, the `DEFAULT 1` user_id footgun, timezone and premiere API bugs.

Want me to knock out C1 and C2 next? They're small and high-impact.
