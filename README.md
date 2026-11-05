<p align="center"><img src="public/logo-default.png" alt="SwitchBoard-AV" width="320"></p>

# SwitchBoard-AV™

A small local web app that lets staff switch a Visionary decoder (a TV/projector) to a
different source. It sends UDP commands to the decoder (`STREAM.HOST=<ip>&VW.ACTIVE=FALSE&STREAM.CONNECT=TRUE`) and confirms the switch by reading the decoder back.

SwitchBoard-AV is an independent project. It is not affiliated with, endorsed by or supported by Visionary
Solutions. "Visionary", "PacketAV" and any other product names are trademarks of their owners and are
used here only to say which equipment the program works with.

v2.0 adds individual staff accounts, roles, and access groups so each person only sees and can
switch the screens and sources they're supposed to — enforced on the server, not just hidden in
the page.

## Run it

```
node server.js
```

The start-up summary lists the addresses to use. Open `https://localhost:8080` on the same computer, or the
`https://<server address>:8080` it shows under _Network_ from another one (or whatever `PORT` you set; see **HTTPS** below for the browser warning on the first visit, or use `TLS=off` for plain http). No npm install, no build step —
Node's built-in modules only.

### Environment variables (all optional)

| Variable               | Default                               | Purpose                                                                                                                                                                                                    |
| ---------------------- | ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DEVICES_FILE`         | `./devices.json`                      | Path to the decoder/encoder list. Imported once as the starting list, then managed in the app (see Devices)                                                                                                |
| `DATA_DIR`             | `./data`                              | Where accounts, groups, and the activity log are stored                                                                                                                                                    |
| `PORT`                 | `port` in `data/settings.json` (8080) | Web server port; overrides settings.json when set                                                                                                                                                          |
| `DEBUG`                | off                                   | Set to `1` to log every UDP/serial packet to the console (troubleshooting only; very chatty). Startup, warnings, errors and switch results always print                                                    |
| `BIND`                 | `0.0.0.0`                             | Address to listen on. The default is every network address, so other computers can connect. Set `127.0.0.1` to allow only the computer it runs on (for example with a reverse proxy on the same machine)   |
| `TRUST_PROXY`          | unset                                 | Set to `1` only if a TLS-terminating reverse proxy sits in front and sends `X-Forwarded-Proto: https`. Marks the session cookie `Secure`, and makes plain HTTP the default (the proxy does the encryption) |
| `TV_SERIAL_PORT`       | `6752`                                | TCP port on the decoders for serial-over-IP (TV power). Only change it for testing                                                                                                                         |
| `STATUS_POLL_SECONDS`  | `20`                                  | How often open pages refresh what each screen is showing. `0` turns auto-refresh off                                                                                                                       |
| `SESSION_IDLE_MINUTES` | `120`                                 | A signed-in person is signed out after this many minutes of doing nothing (automatic refreshes don't count)                                                                                                |
| `SESSION_MAX_HOURS`    | `12`                                  | ...and in any case this many hours after they signed in                                                                                                                                                    |
| `TLS`                  | unset (HTTPS on)                      | HTTPS is on by default with a self-signed certificate the app makes for itself. `TLS=off` serves plain HTTP — see **HTTPS** below                                                                          |
| `TLS_HOSTS`            | unset                                 | Extra names / IPs for the self-signed certificate, comma separated (e.g. `av.example.org,10.1.2.5`)                                                                                                        |
| `TLS_CERT`, `TLS_KEY`  | unset                                 | Use your own certificate and key (PEM files). Admins can instead upload one in Users → Security. Unusable files fall back to the next choice, never to plain HTTP                                          |
| `TLS_PFX`              | unset                                 | ...or a `.pfx` / `.p12` bundle                                                                                                                                                                             |
| `TLS_PASSPHRASE`       | unset                                 | Password for the key or `.pfx`, if it has one                                                                                                                                                              |
| `HTTP_REDIRECT_PORT`   | unset                                 | Also listen on this port (e.g. `80`) and send visitors to the HTTPS address                                                                                                                                |
| `SOURCE_URL`           | this project's GitHub page            | Web address (http/https) of this program's source code, shown as a link in the About window. Set it if you run a changed version for other people                                                          |
| `HSTS`                 | unset                                 | `1` tells browsers to refuse plain HTTP for this site. Not for self-signed certificates — see **HTTPS**                                                                                                    |
| `TLS_RELOAD_SECONDS`   | `3600`                                | How often the certificate files are re-read so a renewed one is used without a restart                                                                                                                     |

## First run — admin account

The first time the app starts with no accounts yet, it creates one:

- username: `admin`
- a random temporary password, printed once to the console

You'll be forced to set a real password the first time you sign in as `admin`. Write the
temporary password down before it scrolls off screen — it's never shown again.

## Roles, in plain language

- **User** — can switch sources on the screens in their own group(s). Sees nothing else.
- **Manager** — everything a User can do, plus: can create new User accounts, reset passwords,
  turn accounts on/off, and move people in or out of the groups the manager themselves was made
  a manager of. A Manager cannot create or edit Admin/Manager accounts, and cannot change what a
  group covers (which spaces, screens, or sources it includes) — only Admin can do that.
- **Admin** — everything: all screens, all sources, the Query tester, and full control over
  users and groups.

## Groups — how access is scoped

A **group** is a named bundle of access:

- **Spaces** — whole areas (e.g. "Library"). Ticking a space grants every screen in it, including
  ones added to that space later.
- Inside an expanded space you can **untick individual screens** to carve them back out (exclude),
  or — if the space itself isn't ticked — **tick individual screens** to grant just those, without
  the rest of the space.
- **Sources** — which encoders (channels/feeds) the group is allowed to switch to, or "All sources".
- **Group managers (optional)** — a dropdown of everyone with the Manager role; tick the ones who
  may add people to this particular group and reset their passwords. If nobody has the Manager
  role yet it says so. A group only ever keeps real Managers: if someone loses the role (or is
  deleted) they are removed from every group's managers automatically, and the page tells you
  how many groups that was. Giving them the role back later does not restore their old groups,
  so tick them again where you want them.
- **Can select several screens and switch them together** — a tick box, off by default (see
  Switching several screens at once).
- **Can change which input a source uses** — a tick box, off by default (see Source inputs).
- **Can blank screens and show a message on them** — a tick box, off by default (see Blank screen
  and on-screen message).
- **Can turn TVs on and off** — a tick box, off by default. Members get On/Off buttons for the
  TV on each screen in the group that is set up for it (see TV power below). The group editor's
  preview line says how many of the group's screens that covers.

A person's visible screens and sources are the union of every group they're in. Someone in no
group at all sees an empty screen with a note to contact an administrator.

## Admin panel

Open it from the account menu: click **Menu** at the top (it starts with who you are signed in as: your name, role and groups), then **Users** or **Status**
(Admin and Manager accounts), or **Devices** (Admin only). The same menu holds Refresh, Change
password, **About** (version and license, for everyone) and Sign out.

- **Users** — add a user, reset a password (shows a one-time temporary password — write it down
  and hand it off, it won't be shown again), rename, enable/disable, change group membership,
  and (Admin only) change role or delete.
- **Groups** (Admin only) — create/edit/delete groups: tick spaces, carve out or add individual
  screens, pick sources, and set which Managers may assign people to that group. A live preview
  shows how many screens and sources the group will grant before you save.
- **Activity** (Admin only) — a readable, filterable log of sign-ins, failed sign-ins, source
  switches (and whether they were confirmed), and admin changes. Kept to the most recent 2000
  entries.
- **Devices** (Admin only) — the screens and sources themselves; see the next section.
- **Branding** (Admin only) — the app's name, logo and colour. See **Branding** below.
- **Backup** (Admin only) — everything about backing up and restoring, in one place: the full .zip, the
  screens and sources list (download it, restore it from a file) and the history of changes to that list.
  See **Backing it up** below.
- **Security** (Admin only) — the HTTPS certificate: what is in use, upload a proper one, download
  the self-signed one to trust it on a computer, or go back to self-signed. See **HTTPS** below.

No part of the admin panel requires editing JSON by hand.

## Devices — managing screens and sources in the app

The Devices tab has four parts:

- **Screens** — add, edit and delete screens: name, space (pick one or type a new one), IP
  address, and TV power (None or LG, plus an optional Set ID). Screens are listed under their
  space, with a filter box.
- **Sources** — add, edit and delete sources (name and IP), and tick which inputs an encoder offers
  for input switching (see Source inputs).
- **Spaces** — **Add space**, rename a space, or delete one that is empty. A new space starts
  empty; to put a screen in it, edit the screen and pick the space from its dropdown. Every space
  a screen uses is listed automatically, and an empty space stays listed until you delete it, so
  you can set a space up (and give a group access to it) before its screens arrive.
- **Backing up the list** lives in the **Backup** tab (next to the Devices tab in the admin window), not here:
  **Download current list** saves the screens, sources and spaces as a `devices.json`; **Restore the list
  from a file** replaces the list with a `devices.json` you choose on your computer (for example one you
  downloaded earlier). **Check file** first says what is in it and what would change (screens and sources
  added or no longer there, group settings that would stop matching), and plain problems — not JSON, a bad
  IP, the same IP twice, an empty list — are refused without changing anything. The current list is saved
  first. The same tab shows the history of changes to the list, with a **Restore** button on each.

Things worth knowing:

- **Paste a list.** On Screens or Sources, "Paste a list" takes one device per line (screens:
  name, space, IP, TV power; sources: name, IP), tab-separated straight from a spreadsheet or
  comma-separated. **Check** shows every problem with its line number without saving anything;
  the list is added only if every line is good.
- **Test.** Each device has a Test button (and the add/edit form has one) that sends a read-only
  query and, for screens with TV power, reads the TV state over serial. It never changes anything.
- **Groups follow your edits.** Groups refer to screens and sources by IP and to spaces by name,
  so changing an IP, deleting a device, or renaming or deleting a space updates every group that uses it, and
  the page tells you how many groups changed. Nobody silently loses or keeps access.
- **Changes take effect immediately** for everyone, with no restart.
- **Checks on save.** IPs must be valid and unique across screens and sources, names are required,
  and the TV Set ID must be two characters like `00`.
- **Restore** puts the screens and sources back as they were before that change (the current list
  is saved first, so a restore can itself be undone). It does not touch groups: if you restore a
  space rename, groups that followed the rename keep the new name until you edit them.
- The last 10 changes are kept by default. Admins pick 5, 10, 15 or 20 in the Backup tab ("Earlier versions to keep"); choosing fewer removes the oldest saved versions straight away, after asking. Each saved version is a full copy of the list (about 12 KB for 92 screens and 23 sources). Every change is also recorded in Activity.

**Where the list lives.** The first time this version starts, `devices.json` is imported into
`data/devices.store.json`. From then on the app's copy is the one in use, so editing
`devices.json` no longer changes anything — use the Devices tab (or Restore the list from a file to load
a `devices.json` over the current list). `devices.json` is read only on a new server setup:
its `port` and `decoderPort` are copied once into `data/settings.json`, which the app uses from then on. To change
a port later, edit `data/settings.json` and restart.

## Backing it up

Everything — accounts, groups, the device list, its history, branding, settings and the activity log —
lives under the `data/` folder (`DATA_DIR`). It is not, and must never be, committed to git (see
`.gitignore`).

Two ways to back it up:

- **In the app (admins): Users → Backup → Download full backup (.zip).** One file with all of the above
  (the HTTPS certificate and key are left out), plus a `RESTORE.txt`. To restore: stop the app, unzip
  into the data folder, start the app; people sign in with the same passwords as when it was made.
  **Keep the file private**: it holds everyone's accounts and password hashes. Each download is
  recorded in the Activity log.
- **Copy the `data/` folder** (while the app is stopped, or any time — files are written in one step).

To keep a copy of just the screens and sources, use **Download current list** in the Backup tab, which also has the file restore and the change history.

## Security notes

- Passwords are hashed (scrypt, per-user salt) — never stored or logged in the clear. A new password must
  be at least 8 characters (at most 200) with some letters and at least one number or special character (a
  space counts), not a common password, not digits or letters in a row, not just the username, and different
  from the current one. Changing a password signs that person out everywhere
  else.
- Sessions are a random token in an `HttpOnly`, `SameSite=Strict` cookie, held server-side. **They end by
  themselves:** after 2 hours without the person doing anything, and in any case 12 hours after signing in
  (`SESSION_IDLE_MINUTES`, `SESSION_MAX_HOURS`). The page's automatic refreshes do not count as "doing
  something", so a page left open on a shared computer still signs out; the person sees a plain message and
  the sign-in screen. Signing in starts a fresh session and ends any older one in that browser.
- Repeated failed sign-ins for the same username+address are throttled with increasing delays, and one
  address that fails 30 times in 10 minutes (under any usernames) is paused for the rest of that window.
- Every response carries protective headers: a Content Security Policy (only the app's own script and
  stylesheet run, nothing can frame it, nothing is sent to other sites), `X-Content-Type-Options: nosniff`,
  `X-Frame-Options: DENY`, no Referer, and a restrictive Permissions-Policy. Answers from the API are never
  cached by the browser, and the page's files are re-checked on every load so an update shows at once.
- A request that changes something and that the browser says came from another website (Origin or
  Sec-Fetch-Site) is refused, on top of the `SameSite=Strict` cookie. Scripts and tools that send neither
  header are not affected; they still need a valid session. Behind a proxy (`TRUST_PROXY=1`), the proxy's
  `X-Forwarded-Host` is accepted too.
- An unexpected server error tells the browser only "Something went wrong on the server."; the details
  stay in the server's log.
- **HTTPS is on by default** (next section), so passwords and session cookies are encrypted in
  transit. Only `TLS=off` or a TLS-terminating reverse proxy (`TRUST_PROXY=1`) changes that; the app
  prints a reminder at start-up if it is listening on the network without HTTPS. The app listens on every
  network address by default; set `BIND=127.0.0.1` if it should only be reachable from the computer it runs on.
  Sign in and change the temporary admin password as soon as you first start it.
- `devices.json` holds no secrets and the app never writes to it. The live device list is
  `data/devices.store.json`, also free of secrets. Only Admins can see or change the device list.

## HTTPS (on by default, no reverse proxy needed)

The app serves HTTPS itself. **It is on out of the box**: the first time it starts it makes a
self-signed certificate (Node built-ins only, nothing to install), so passwords and sessions are
encrypted even before anyone has set anything up. Open `https://<server name or IP>:8080`. If you type
`http://` instead, the app redirects you to the `https://` address.

### What people will see

A self-signed certificate means **browsers show a warning** ("Your connection is not private") the
first time on each device, because nobody vouches for it. The connection is still encrypted. Click
_Advanced → Continue_. The warning goes away once an admin installs a proper certificate (below), or
the self-signed one is installed as trusted on a particular computer.

### Managing the certificate in the app (admins)

Open **Users → Security** (admins only). It shows what the app is using now — what it is good for,
when it expires, its fingerprint — and lets an admin:

- **Upload a real certificate.** Choose the certificate file (`.pem`, `.crt`, `.cer`) and its key
  file (`.key` / `.pem`), plus the key's password if it has one. **Check files** reads them and says
  in plain words what is wrong if something is (key doesn't match, wrong password, files in the wrong
  boxes, expired, a CA certificate instead of a server one). **Install certificate** applies it at
  once, for everyone, with no restart. A full-chain file (certificate followed by the CA's
  intermediates) works; the order inside it doesn't matter.
- **Download the certificate** to install it as trusted on a computer (Windows: right-click → Install
  Certificate → Trusted Root Certification Authorities), which removes the browser warning there.
- **Go back to self-signed** if an uploaded certificate causes trouble.
- See a warning if the certificate doesn't list the address the admin is using right now, or is about
  to expire.

Every upload and reset is recorded in the Activity log. The uploaded files are stored in
`data/tls/` (the key without its password, readable only by the account running the app). **Keep
`data/` private** — it is not committed to git and is covered by the same backups.

`.pfx` / `.p12` bundles can't be uploaded in the screen; for those use `TLS_PFX` (below), or convert
them with openssl.

### Which certificate is used

In order, each falling back to the next if it can't be used — the app **never** drops to plain HTTP by
accident:

1. **Server settings** — `TLS_CERT` + `TLS_KEY` (PEM files) or `TLS_PFX` (+ `TLS_PASSPHRASE`). For
   people who deploy with files/Docker. When these are working they take priority and the Security tab
   shows them read-only.
2. **A certificate uploaded in the Security tab.**
3. **The self-signed certificate** the app made for itself. It lists `localhost`, the server's name and
   current network IPs, plus anything in `TLS_HOSTS` (e.g. `TLS_HOSTS=av.example.org`). It is reused,
   valid two years, and replaced automatically within 30 days of expiry or when a name is added. If the
   server's IP changes, a new one is made at the next start and browsers warn again, so give the server
   a fixed IP and set `TLS_HOSTS` to the name people type.

If the files named in the server settings can't be used at start-up (missing, only one of cert/key
set, key doesn't match, wrong `.pfx` password) the app prints exactly what is wrong and carries on with
the next choice. The certificate files are re-read every hour (`TLS_RELOAD_SECONDS`), so putting the
right files in place is enough. The other way round is deliberate: if a real certificate is already
being served and a replacement file turns out to be broken, the app keeps serving the working one and
warns, rather than falling back to self-signed.

### Turning it off, or using a proxy

- `TLS=off` serves plain HTTP (the app warns at start-up if it is also listening on the network).
- `TRUST_PROXY=1` — a TLS-terminating reverse proxy in front of the app — also defaults to plain HTTP,
  since the proxy does the encryption. Set `TLS=selfsigned` as well if you want HTTPS behind it too.

### Other settings

- **Port.** Any port works. `PORT=443` saves people typing `:8080` (on Linux that needs extra rights;
  on Windows it just works if nothing else uses 443). Anyone who types `http://` at the app's own port is
  sent to the `https://` address automatically (to its front page). `HTTP_REDIRECT_PORT=80` adds a second
  port that does the same, for people who type the name with no port at all.
- **Check it is really your server.** At start-up the app prints the certificate's _SHA-256
  fingerprint_; the Security tab shows it too. With a self-signed certificate, comparing it with the
  browser's certificate details on a first visit is what proves nobody is in the middle.
- **`HSTS=1`** tells browsers to refuse plain HTTP for the site. **Don't use it with a self-signed
  certificate** — browsers then stop letting people click past the warning, which would lock everyone
  out. It is worth turning on once a real certificate is installed.
- The session cookie is automatically marked `Secure` when served over HTTPS.

## Branding — name, logo and colour

Nothing about who runs the app is in the code. Out of the box it shows the SwitchBoard-AV name and logo with a steel-grey header and red
highlights for selected things (colours chosen to sit well with the logo's silver and red). An admin changes that in **Users → Branding** (admins only):

- **App name** — shown in the header and the browser tab (up to 40 characters).
- **Organization name** — optional; shown under the app name on the sign-in page and used as the
  logo's alt text (up to 80 characters).
- **Colour** — the header and button colour. Pick it with the colour picker or type a hex code
  like `#482d8c`. The page stays dark; the app works out a lighter shade of your colour for text
  and focus rings on its own. Colours that white text can't be read on (too light), or that would
  vanish into the dark page (too dark), are refused with a message.
- **Highlight colour** — used for things that are selected: the open space in the list, the current
  source in the chooser, and screens picked with "Select several". It has its own lighter shade and the
  same readability rules. Red by default; the header stays grey, so the logo's red arrow still shows.
- **Logo** — PNG, JPEG, GIF or WebP, up to 512 KB; roughly square works best. SVG is not accepted,
  because an SVG can carry scripts. Files are checked by what they contain, not by their name.
  **Remove logo** goes back to the built-in SwitchBoard-AV logo; **Reset to defaults** clears everything.

A live preview shows the result before you save; saving applies to everyone and reloads the page.

**The program's own name always shows.** Whatever name is set here, the sign-in card and a corner of the
main page say "Powered by SwitchBoard-AV", and the About window shows SwitchBoard-AV with the install's own
name underneath. That wording is fixed text in the page, not part of these settings, so it cannot be changed
from the Branding tab.
Changes are recorded in the Activity log.

The settings are stored in `data/branding.json` and the logo in `data/branding/`, next to the
accounts and groups, so they stay out of git, are covered by the same backups, and survive updating
the code. The sign-in page can show them before anyone signs in, so `/branding.css` (two colour
values) and `/branding/logo` are public; nothing else about the setup is.

## Code style

The code follows the project's script style guide, with these recorded choices:

- **Class names** are plain kebab-case, one block per screen area, not BEM.
- **Dark theme only.** The look is set through the Branding colours, so there is no light theme.
- **The first-run admin password is printed once on the console.** The person starting the app needs it to sign in; it is a temporary password that must be changed at first sign-in. Nothing else logs a credential.
- **Stylelint** has `no-descending-specificity` and `media-feature-range-notation` turned off: the base button and tile rules deliberately outrank component defaults, and the wide-layout query is written with `min-width`.

## License

SwitchBoard-AV is free software, released under the [GNU Affero General Public License, version 3 or
later](LICENSE) (AGPL-3.0-or-later). In plain words: you may use it, change it and share it, including
running it for your own organization. If you share a modified version, or run one as a service that other
people use over a network, you must make your modified source available to them under the same license,
so it cannot be turned into a closed, proprietary product. The license text is what counts; this is only
a summary. Copyright (c) 2026 Brett Cupp.

No organization's branding is built into the code: each install sets its own name, logo and colours in
the Branding tab (see above). The default SwitchBoard-AV logo is part of the project.

**The name and logo.** The license covers the code; it does not give anyone the right to use the name
"SwitchBoard-AV" or its logo as their own brand. You can run the unmodified program with its name and logo,
call something "based on" or "compatible with" SwitchBoard-AV, and put your own organization's name on your
own install in the Branding tab. A **modified version** must have its own name and logo and keep the credit
"SwitchBoard-AV by Brett Cupp". The two additional terms that say so (under section 7 of the AGPL) are in
[NOTICE](NOTICE), and the plain-words rules are in [TRADEMARKS.md](TRADEMARKS.md).

The About window links to this project's source code on GitHub. If you run a **changed version** for other
people, set `SOURCE_URL` (see the table above) to where your changed source can be had; the AGPL asks you
to offer it to the people who use it.

Contributions are welcome. You keep your copyright; your work is accepted under the same license, with
a Developer Certificate of Origin sign-off (`Signed-off-by:` on each commit, see [DCO](DCO)) and no separate
agreement to sign. See [CONTRIBUTING.md](CONTRIBUTING.md).

## What the tile labels mean

Each tile shows the source the decoder is currently tuned to. Two other labels can appear:

- **No response** (amber) — the decoder did not answer its last query within about a second.
  Usual causes: the PC running the app has no network path to that decoder's VLAN (for example
  working from home without a VPN), UDP port 8000 is blocked by a firewall, or the decoder is off.
- **Not read yet** — the decoder is reachable but has not reported a source (nothing has been
  routed to it since it started, or the page has not refreshed yet).

## Staying current, and the Status tab

**Tiles refresh by themselves.** While the page is open and in view, it asks the screens it can
see what they are showing every `STATUS_POLL_SECONDS` (default 20), so a change made by someone
else shows up without pressing Refresh. The header shows "Updated 7:55 PM". It
pauses when the tab is hidden, and skips a turn while you are mid-switch. Each person's page only
asks about the screens they have access to.

**Status tab (Admins and Managers; account menu, then Status).** An Admin sees every screen and
source. A **Manager** sees only the screens of the groups they manage, plus the sources those
groups use, and "Check all now" asks only those devices. A Manager who isn't named on any group yet
sees a note saying so. The first time it opens it asks the devices in scope for their model, all at
once, and lists them with the problems first:

- **Not answering**, **Not checked yet**, **Answering**, with a summary like "88 of 115 answering".
- For each: IP, whether it is a screen or a source, its model, the real round-trip time in
  milliseconds, what a screen is showing now, and when it last answered.
- **Check all now** repeats the check. It is read-only, and the same result feeds the tiles, so a
  screen that stopped answering shows "No response" for everyone straight away.

## Switching several screens at once

**This is a group permission, off by default.** The **Select several screens** button only appears
for people in a group with **Can select several screens and switch them together** ticked (and
for Admins), and only for the screens that group covers: in selection mode, screens the person
may not group together are greyed out and can't be ticked. The server enforces it too, so a request
for more than one screen is refused without the tick, including blanking or messaging several at
once. Switching a single screen is never affected.

Above the tiles, **Select several screens** turns on selection mode: tapping a tile ticks it
instead of opening it. **Select all shown** ticks every screen in the space you're looking at,
**Clear** unticks them, and **Choose a source for N** opens the usual source list. The chosen
source is sent to every ticked screen and each one is confirmed on its own, exactly like a
single switch. If all confirm, the popup closes; if some don't, it names them and stays open
so you can try again.

The server checks every screen against the person's access before switching anything: if any one
is outside their groups, nothing is switched. Up to 100 screens per request, 12 switched at a
time. Activity records one entry per screen, marked with the batch size.

## Blank screen and on-screen message

For people in a group ticked **Can blank screens and show a message on them** (and for Admins),
a screen's popup has two extra rows:

- **Screen** — **Picture** (normal), **Black** (a black screen) or **Logo** (the decoder's splash
  screen). A screen that isn't showing the picture gets an amber badge on its tile ("Black
  screen", "Logo screen"), so staff can see why it's dark. Switching a screen to a source brings
  the picture back, because the decoder resets itself when it is tuned.
- **Message** — text (up to 80 characters: letters, numbers, spaces and `. , : ; ! ? ' ( ) / -`)
  shown on the screen as an overlay in the upper-left corner; **Clear** removes it. Characters
  like `&` and `=` are refused so a message can never be mistaken for another command.

In "Select several screens" mode, **Black**, **Picture** and **Message...** appear for the
selection (only if you may control every selected screen).

Each command is confirmed by reading the setting back, the same way a source switch is, and the
result names any screen that didn't confirm. Everything is recorded in Activity, including the
text of messages. These use the decoder's documented `VIDEO.OUTPUT` and `VIDEO.OSD_TEXT`
settings (Visionary D5200 user manual). Tiles learn each screen's output mode from the regular
refresh.

**Worth checking once on a real decoder:** that a message with spaces displays correctly, and
that Clear really empties the message. The manual describes the setting but not those two cases.

## Source inputs (HDMI 1, HDMI 2, USB-C, Auto)

Some encoders (the E5200 has HDMI 1, HDMI 2 and USB-C inputs) can be told which input feeds the
stream. People who may do this see **Source inputs** in the account menu: each source that offers
it, the input it is on now, and a button per input. Every change asks first, because it changes
what **every screen showing that source** sees, and it is confirmed by reading the setting back.

**Who sees it.** The source must be set up for it, and the person must be an Admin or be in a group
that has **Can change which input a source uses** ticked _and_ lists that source. Otherwise the
menu item doesn't appear and the server refuses the request.

**Setting up a source.** Devices, then Sources, then edit the source and tick the inputs staff may
choose between (HDMI 1, HDMI 2, USB-C, Auto). Leave all unticked if the encoder has one input, which
is the default. The list is stored as `"inputs": ["HDMI1", "HDMI2"]` on the source.

This uses the encoder's documented `STREAM.VIDEO` setting (values `AUTO`, `HDMI1`, `HDMI2`, `USB-C`;
Visionary D5200 user manual). The loop-out (`VIDEO.HDMI_OUT`), input priority and EDID settings are
not touched. When a source is on **Auto** the app shows "Auto"; the manual describes no way to ask
which input is actually in use.

**Worth checking once on a real encoder:** read its current input with the Query tester
(`STREAM.VIDEO`), then change it on a spare unit before enabling a group. The manual lists the
setting but doesn't show an example of the exact command.

## TV power (LG, through the decoder's serial port)

The popup for a screen shows a **TV power** row (current state, **On**, **Off**) when both are true:

1. the screen is set up for it (Devices, then edit the screen and set TV power to LG), and
2. the person is an Admin, or is in a group with **Can turn TVs on and off** ticked.

Off asks "Turn off the TV for ...?" first. Every On/Off is recorded in Activity with who did it;
routine state checks (the popup opening) are not.

How it works: the app opens a TCP connection to the decoder on port 6752, sends one LG command,
reads the TV's reply and closes. The commands are
`ka 00 01` (on), `ka 00 00` (off), `ka 00 ff` (state), each ending in a carriage return; the TV
answers like `a 00 OK01x`. If a connection fails it retries once after a short pause.

**Setting up a screen** — in the Devices tab, edit the screen, set **TV power** to "LG TV
(serial)" and save. The **LG Set ID** box is optional: fill it in (two characters, e.g. `01`) only
if that TV's Set ID isn't `00`, the default, which means "all sets". Stored, a flagged screen
looks like this (the same shape as the `devices.json` export):

```json
{ "name": "Library Display 1", "space": "Library", "ip": "192.0.2.21", "tvPower": "lg" }
```

The decoder itself must already have serial over IP switched on with the TV's settings (9600
baud, 8 data bits, no parity, 1 stop bit): in the decoder's web page set `SERIAL.ENABLED` to
`TRUE`, set `SERIAL.SETTINGS`, and save (the unit reboots). The RS-232 pins on the decoder's
8-pin connector are 6 = GND, 7 = TXD, 8 = RXD (Visionary D5200 user manual).

The sample list that comes with the app flags two screens this way (the Library displays). To add more, check the decoder first with its **Test** button in Devices
(tick TV power on the form first so the serial link is checked too; it only reads state), or the
Query tester's **TV power (serial)** button, then set TV power on that screen. No restart needed.

Other TV brands would be a new entry in the `TV_PROTOCOLS` table in `src/config.js`.

## Query tester

Admin-only, read-only. Pick any screen or source from the list. Sends `QUERY.<name>=TRUE` (the same queries the decoder's own diagnostics
page uses) or a typed `QUERY.KEY=<key>`, and shows every raw reply for a couple of seconds.
It cannot send a set command — the key is restricted to name characters, and the quick-pick
buttons are a fixed list. The **TV power (serial)** button reads the TV's power state over the
decoder's serial port (state query only — it never turns a TV on or off).

## devices.json

Starting with v2.2 the device list is managed in the app (see Devices above). `devices.json` is
read only on a new server setup, when its device list is imported once as the starting list and its `port` and `decoderPort` are copied into `data/settings.json`. After that the app does not read it again. The Backup tab's **Download current list** writes the
current list back out in the same shape, and **Restore the list from a file** loads such a file back in.

The `devices.json` that comes with the app is only a **sample** (six screens in four spaces, three sources),
so the app has something to show on a first start. It uses the addresses reserved for documentation
(`192.0.2.x` and `198.51.100.x`), which never reach a real device, so starting the app with it cannot send
anything to equipment on your network. Replace those screens and sources with your own in the Devices
tab, or put your own list in `devices.json` before the very first start.
