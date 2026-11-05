# Contributing to SwitchBoard-AV

Thanks for wanting to help. SwitchBoard-AV is a small web app that lets non-technical staff change the
source on Visionary Solutions PacketAV decoders, with accounts, access groups and an admin area that needs
no command line. Bug reports, ideas, documentation fixes and code are all welcome.

## Before you start

- **Small fixes** (typos, wording, an obvious bug): go ahead and open a pull request.
- **Anything bigger** (a new feature, a change to how permissions or commands work): please open an issue
  first and describe what you want to do and why, so we can agree on the approach before you spend time on it.
- **Questions or ideas:** open an issue too.

## Reporting a security problem

Please do **not** post security problems (for example a way around the group permissions, or anything that
exposes passwords or sessions) in a public issue. Report them privately through the repository's
"Report a vulnerability" option (GitHub: **Security** tab), and give enough detail to reproduce it. We will
reply, fix it, and credit you if you like.

## License

SwitchBoard-AV is released under the **GNU Affero General Public License, version 3 or later**
([LICENSE](LICENSE)), with the additional terms in [NOTICE](NOTICE) (the name and logo are not part of the license,
see [TRADEMARKS.md](TRADEMARKS.md), and modified versions must keep the credit "SwitchBoard-AV by Brett Cupp").
**You keep the copyright to what you write**, and your contribution is accepted under that same license and
those terms, with no separate agreement to sign. In short: anyone may use, change and share the code, but a
changed version that is shared, or run as a service for other people, must stay open source under the same
license.

## Signing off your work (the DCO)

Instead of a contributor agreement, this project uses the **Developer Certificate of Origin** ([DCO](DCO)),
the same short statement the Linux kernel uses. Every commit in a pull request must end with a line like this:

```
Signed-off-by: Your Name <you@example.com>
```

Git adds it for you when you commit with `-s`:

```
git commit -s -m "Fix the typo in the Backup tab"
```

The line says that you wrote the change (or have the right to submit it) under the project's open source
license, and that you understand the contribution and your name and email are public and kept in the project's
history. Please use your own name and a working email address.

- **If you contribute as part of your job**, make sure your employer is fine with it: the sign-off says you
  have the right to submit the work.
- **Forgot to sign off?** A bot checks every pull request and tells you what to do. For your last commit, run
  `git commit --amend -s --no-edit`; for several, `git rebase --signoff main`; then push again with
  `git push --force-with-lease`. A single follow-up commit that signs off on the earlier ones also works,
  as the bot explains.

## Setting it up to work on

You need **Node.js 18 or newer**. Running the app needs no `npm install` and no build step: it uses only what
comes with Node, and the web page is plain JavaScript, HTML and CSS. To check your changes against the project's
style, run `npm install` once (developer tools only), then `npm run format` to tidy the files and `npm run check`
for the formatter check, the linters (ESLint, Stylelint, html-validate) and the tests.

To try changes without real hardware, run the pretend decoders in one terminal:

```
TV_SERIAL_PORT=16755 node test/mock-decoders.js
```

and the app against them in another (on Windows PowerShell, set the variables with `$env:NAME = "value"`):

```
TLS=off TV_SERIAL_PORT=16755 DEVICES_FILE=test/devices.test.json node server.js
```

Then open `http://localhost:8080`. The first start creates an admin account and prints its temporary password
in the terminal. The app keeps its data in a `data` folder next to `server.js` (never commit it). The
[README](README.md) explains every setting.

**Never point a test at real decoders or screens.** The pretend decoders answer on `127.x` addresses only.

## Where things are

`server.js` is only the entry point (first-run admin account and start-up). The rest lives in `src/`:

- `config.js`, `log.js`, `files.js`, `util.js`: settings, the one logging function, JSON file helpers, small helpers.
- `store.js`, `devicelist.js`: the saved users, groups, activity log and device list.
- `auth.js`, `scoping.js`: passwords and sessions; who may see and switch what.
- `state.js`, `decoders.js`: the live decoder picture, and talking to the decoders over UDP.
- `branding.js`, `static.js`, `http.js`, `webserver.js`, `tls-runtime.js`, `tls.js`, `backup.js`: the web side.
- `api/`: one file per group of API routes, and `api/index.js` that dispatches to them.

Modules only import from modules listed above them, so there are no import loops. State that several
modules change is kept in one object (for example `tlsRuntime`) or changed through a function.

## Running the tests

```
node test/run-all.js
```

runs every test script in `test/` one after another (about two minutes) and prints one line per script. Each
script starts its own copy of the app, and the pretend decoders where it needs them, in a temporary folder, so
your own data folder is never touched. To run only some, name them: `node test/run-all.js tls hardening`
runs the scripts with those words in their names, and `--verbose` shows everything they print.

- The scripts use fixed ports (from 18080 up) on `127.0.0.1`, so don't run two of them at once.
- A few checks use the `openssl` command or a tool that opens zip files (`tar` or `unzip`). If the machine
  doesn't have one, those checks print `SKIP` and the rest still run.
- The pretend decoders listen on addresses such as `127.0.1.11` and `127.0.2.12` (see
  `test/devices.test.json`). Windows and Linux accept all of `127.x.x.x` as it is; macOS only answers on
  `127.0.0.1` unless you add the others first, for example `sudo ifconfig lo0 alias 127.0.1.11`.
- `devices.json` in the main folder is only a sample on documentation-only addresses; the tests use
  `test/devices.test.json`.

## What we look for in a change

These come from how the app has been built; following them keeps it simple and safe.

- **No dependencies.** Do not add npm packages. If something is missing from Node, write the small piece
  yourself.
- **The server decides.** Every permission is checked on the server, never only hidden in the page. A request
  for something a person may not do must be refused, and a batch with one forbidden item is refused whole.
- **Check all input.** Anything that arrives from a browser or a file is untrusted. Validate it, and answer
  with a plain-English error.
- **Show text safely.** The page puts text on screen with `textContent` and never builds HTML from stored or
  typed text (no `innerHTML`). Anything the server puts into HTML is escaped.
- **No organization branding in the code.** Names, logos and colours belong in the Branding settings. Do not
  add a school's, company's or product's name or logo to the source.
- **Plain words.** The people using this are teachers and office staff. Labels, help text and errors should
  make sense to someone who has never seen a command line. Say what happened and what to do.
- **Keep it working on Windows.** Many installs run on a Windows PC. Use the app's existing safe file-writing
  helper for anything saved to the data folder.
- **Tests.** When you change what the app does, add or update a check in the matching `test/*.test.js`
  script, and run `node test/run-all.js` before you open the pull request.
- **Say how it was checked.** Commands the app sends to decoders (UDP port 8000) and TV serial (TCP 6752)
  are confirmed by reading the value back. If you change one, explain how you tested it, and on which
  models, if you tested on real hardware.

## Making a pull request

1. Fork the repository and make a branch for your change.
2. Keep it focused: one idea per pull request is much easier to review.
3. Sign off every commit (see above).
4. Update the [README](README.md) if what people see or set up has changed, and add a line to the
   [CHANGELOG](CHANGELOG.md). Keep the version in the header of `server.js`, `APP_VERSION` in `src/config.js` and `package.json`
   in step when you change it.
5. In the pull request, say **what** changed, **why**, and **how you tested it**.
6. A maintainer will review it. We may ask for changes. Please be patient; this is a small project.

Commit messages: a short heading, then a few lines on what and why if it is not obvious.

## Source files

New source files start with the same short notice the others have, including the line
`SPDX-License-Identifier: AGPL-3.0-or-later`.

## Being kind

Be patient and respectful with everyone, whatever their experience. Disagree about the code, not the person.
Maintainers may close or remove contributions or comments that are abusive or off topic.
