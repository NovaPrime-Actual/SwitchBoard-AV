# Changelog

SwitchBoard-AV, newest first.

## v2.13 (11/05/26)

- The app now listens on every network address by default (`BIND` was `127.0.0.1`), so a server install works for other computers as soon as it starts. Set `BIND=127.0.0.1` to keep it to the computer it runs on. HTTPS is still on by default. The start-up summary shows what it is listening on and the `https://` address to use from another computer.

## v2.12 (11/04/26)

Code tidy to the project's script style guide. No change to what the app does for people, apart from the page's look being rebuilt on shared design tokens.

- The code is now ES modules (`"type": "module"`), checked by Prettier, ESLint, Stylelint and html-validate (`npm run check` runs the formatter check, the linters and the tests; `npm install` is needed only for these developer tools, never to run the app).
- Console output goes through one function and every line carries the `[SwitchBoard-AV]` tag. Failures are logged instead of swallowed, and wrapped errors keep their cause.
- The page script is a module with a 60-second limit on every request, and no promise is left unobserved.
- Styles: colours and sizes live in `public/tokens.css`, sizes are in rem, the layout is phone-first, and styles use classes instead of ids.
- Notes written in the page's HTML are removed from what the server sends.
- `server.js` is now a short entry point; the code lives in `src/` (one module per area, API routes in `src/api/`), with no change in behaviour. CONTRIBUTING.md has a map.
- Typing `http://` at the app's own HTTPS port now redirects to the `https://` address instead of failing, so `http://127.0.0.1:8080` just works (to the front page; the typed path is not kept).
- The Query tester's list now includes the sources (encoders) as well as the screens, in two groups. The TV power button is for screens only.
- The About window now links to the project's source on GitHub by default; `SOURCE_URL` overrides it for a changed version.
- The README now says plainly that SwitchBoard-AV is independent and not affiliated with or endorsed by Visionary Solutions.
- SECURITY.md says how to report a problem privately.
- Version bumped to 2.12.

## v2.11

Hardening pass.

- The `devices.json` that comes with the app is now a small sample (six screens, three sources, on documentation-only addresses that can never reach real equipment) instead of one site's real list.
- The automated tests now live in `test/` and run with `node test/run-all.js` (about two minutes); see CONTRIBUTING.md.
- Sessions now end: after 2 hours of the person doing nothing (`SESSION_IDLE_MINUTES`) and 12 hours after sign-in (`SESSION_MAX_HOURS`). The page's automatic refreshes send `X-Background: 1` and don't count as activity. A person whose session ended sees "Your session has ended, so you were signed out. Please sign in again." Signing in retires the browser's old session; changing a password ends that person's other sessions.
- Security headers on every response: a Content Security Policy (own script/style only, no framing, no outside connections), nosniff, DENY framing, no Referer, Permissions-Policy, same-origin opener/resource policies. API answers are `no-store`; the page's files are `no-cache`.
- New passwords: still at least 8 characters, at most 200, and now they need some letters and at least one number or special character (a space counts). Common passwords, digits or letters in a row, just the username, and the same as the current one are refused. The current password is checked first.
- Requests that change something and come from another website (Origin / Sec-Fetch-Site) are refused.
- More than 30 failed sign-ins from one address in 10 minutes (under any usernames) pauses sign-in from that address for the rest of the window.
- Pasting up to 500 screens or sources works: the paste limit was 10 KB (about 125 lines) and now 300 KB, with a plain message past it.
- A server error no longer sends its internal message to the browser.
- Tidier console output: start-up prints one aligned summary (screens and sources, device list, data folder, HTTPS and certificate fingerprint, the URL to open) with notes and warnings below it, instead of a run of long unlabelled lines. Lines after start-up begin with the time. Colours and line-wrapping only when a person is watching a terminal; a log file or pipe stays plain, one line per message. The first-run admin notice is shorter.
- The SwitchBoard-AV name is marked with ™ (unregistered) in the README title and in TRADEMARKS.md. It is not added to the program's own screens.
- Name and logo policy: TRADEMARKS.md says what forks may do with the SwitchBoard-AV name and logo (unmodified installs may keep them; a modified version needs its own name and logo and says "Based on SwitchBoard-AV"). NOTICE adds two additional terms under section 7 of the AGPL: no trademark rights are granted (7(e)), and a modified version must keep the credit "SwitchBoard-AV by Brett Cupp" in its About window and source notices (7(b)). The About window now shows "by Brett Cupp" under the version, as fixed text.
- "Powered by SwitchBoard-AV" is fixed wording on the sign-in card and in a corner of the main page, and the About window always shows SwitchBoard-AV (the name set in Branding appears there as "This installation is called ..."). None of it can be changed from the Branding tab.

## v2.10 (11/04/26)

- Console logging: every UDP/serial packet is now logged only with `DEBUG=1`. Startup, warnings, errors and one line per switch result always print.
- devices.json is read only on a new server setup. Its `port` and `decoderPort` are copied once into `data/settings.json`; the app runs from the data folder after that.
- Admins can edit an existing user (name, username, role, groups) from an Edit button on the Users tab. Username changes also update any group manager lists.
- The header menu button now just says Menu; the dropdown starts with who is signed in: their name (hover for the username), role and the groups they belong to (admins show "none" with a note that they can use every screen), instead of "Administrator (admin)" on the button.
- New Backup tab (admins): a full backup as one .zip (accounts and groups, the device list and its history, branding, settings, activity log; not the HTTPS key), with a RESTORE.txt inside. Each download is logged.
- The list change history keeps the last 10 changes by default (it was 30). An admin chooses 5, 10, 15 or 20 in the Backup tab; a longer history saved by an older version is trimmed to the current choice when the app starts. The choice is stored in store.json, so a full backup carries it.
- All backup and restore for the screens and sources list (download, restore from a file, change history with Restore) moved from the Devices page into the Backup tab, so it is all in one place. The buttons are relabelled, and the list is now restored from a devices.json file you choose ("Check file" shows what would change first) instead of re-reading the file on the server.
- The license changes from MIT to the GNU Affero General Public License, version 3 or later (AGPL-3.0-or-later), so the code can't be packaged into a closed, proprietary product or service. LICENSE holds the official text; source files carry SPDX notices. The About window now shows the license, the copyright and the "no warranty" line the AGPL asks interactive programs to show, plus an optional source link (`SOURCE_URL`).
- CONTRIBUTING.md added. Contributions are accepted under the project license with a Developer Certificate of Origin sign-off (`Signed-off-by:` on each commit; the DCO file has the text), with no CLA. `.github/dco.yml` configures the DCO checking bot for when this folder becomes its own repository.
- About window in the account menu (for everyone): app name, version, license and copyright.
- The default header/button colour is now a steel grey (#59606b) that goes with the default logo, instead of blue.
- A second branding colour, the highlight for selected things (the open space, the current source, picked screens), is red (#a6171d) by default and can be changed in the Branding tab. The last hard-coded violet shades in the stylesheet now follow the settings.
- The default app name is SwitchBoard-AV (an install keeps whatever name its Branding tab holds).

## v2.9

- The name, logo and accent colour are configurable in an admin Branding tab (stored in `DATA_DIR`), so the code carries no organization branding. A plain default is used until an admin sets one.

## v2.8

- Serves HTTPS itself, on by default (no reverse proxy needed). A self-signed certificate is made on first start; admins can upload a real one in the Security tab, or `TLS_CERT`/`TLS_KEY` (or `TLS_PFX`) can point at one.
- `TLS=off` (or `TRUST_PROXY=1` behind a proxy) turns HTTPS off. See `tls.js`.

## v2.7

- "Select several screens" is now a group permission ("can switch several screens at once"), off by default. Any request for more than one screen is refused on the server without it.

## v2.6

- People in a group ticked "can change source inputs" can pick which input (HDMI 1, HDMI 2, USB-C, Auto) an encoder uses, for the encoders that offer it (devices `inputs`).

## v2.5

- Blank-screen (picture / black / logo) and on-screen message for people in a group ticked "can blank screens and show messages". Tiles show when a screen is blanked.

## v2.4

- Open pages refresh on their own (`STATUS_POLL_SECONDS`, default 20; 0 = off).
- Admins get a Status tab: who answers, how fast, which model, and what each screen is showing.

## v2.3

- Pick several screens and switch them all to one source in one go. Each screen is checked against the person's access first and confirmed separately.

## v2.2

- The device list moves into the app: admins add, edit, remove and test screens and sources, rename spaces and paste lists in the Devices screen.
- Changes cascade into the groups and take effect at once. Every change keeps a snapshot for restore.

## v2.1

- TV power over the decoder's RS-232 port (LG, TCP 6752).
- A decoder opts in with `"tvPower": "lg"` in `devices.json`, and a group must be ticked "can control TV power" to use it.

## v2.0

- Per-user accounts, roles (admin/manager/user), access groups that scope which decoders/sources each person may see and switch.
- In-app admin UI for non-technical staff, and an activity log.
- Everything is enforced server-side, not just hidden in the UI.
