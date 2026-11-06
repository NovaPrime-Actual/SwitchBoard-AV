// ===========================================
// SPDX-License-Identifier: AGPL-3.0-or-later
// SWITCHBOARD-AV — client script
// Vanilla JS, no build step. Talks to the server's /api/* routes.
// Renders user-controlled strings (names, group names, activity text) with
// textContent only — never innerHTML — so stored data can never run as script.
// ===========================================

// ===========================================
//  LOGGING AND ERROR BOUNDARY
// ===========================================
const LOG_TAG = "[SwitchBoard-AV]";

// The only place this file writes to the browser console.
function logError(message, err) {
  // eslint-disable-next-line no-console -- the single logging entry point
  console.error(`${LOG_TAG} ${message}`, err);
}

// Last resort for a promise nobody awaits: log it instead of leaving an unhandled rejection.
function fire(promise) {
  promise.catch((err) => logError("Unexpected error in an action", err));
}

// Wraps an event handler so a promise it returns is never left floating.
function guarded(handler) {
  return (...args) => {
    const result = handler(...args);
    if (result instanceof Promise) fire(result);
  };
}

const API_TIMEOUT_MS = 60 * 1000; // no request waits longer than this for the server
const CLOSE_AFTER_CONFIRM_MS = 1200; // popup closes this long after a confirmed route

// ===========================================
//  API HELPER
// ===========================================
async function api(url, opts) {
  opts = opts || {};
  const fetchOpts = {
    credentials: "same-origin",
    method: opts.method || (opts.body !== undefined ? "POST" : "GET"),
    headers: {},
  };
  if (opts.body !== undefined) {
    fetchOpts.headers["Content-Type"] = "application/json";
    fetchOpts.body = JSON.stringify(opts.body);
  }
  // an automatic refresh is not the person doing something, so it must not keep their session alive
  if (opts.background) fetchOpts.headers["X-Background"] = "1";
  fetchOpts.signal = AbortSignal.timeout(API_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url, fetchOpts);
  } catch (err) {
    if (err.name === "TimeoutError") {
      throw new Error("The server did not answer in time. Try again.", { cause: err });
    }
    throw err;
  }
  let json;
  try {
    json = await res.json();
  } catch {
    json = {}; // no body, or not JSON: the status below still says what happened
  }
  if (!res.ok) {
    const err = new Error(json.error || res.statusText);
    err.status = res.status;
    // the server says the session is over (a wrong current password also answers 401, but without signedOut)
    if (res.status === 401 && json.signedOut && url !== "/api/me" && me) {
      me = null;
      data = null;
      showLogin("Your session has ended, so you were signed out. Please sign in again.");
    }
    throw err;
  }
  return json;
}

// ===========================================
//  DOM SHORTCUTS
// ===========================================
const $ = (id) => document.getElementById(id);
function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
}
function el(tag, props, children) {
  const n = document.createElement(tag);
  if (props)
    for (const k in props) {
      if (k === "className") n.className = props[k];
      else if (k === "text") n.textContent = props[k];
      else if (k.startsWith("on")) n.addEventListener(k.slice(2), props[k]);
      else n.setAttribute(k, props[k]);
    }
  (children || []).forEach((c) => n.append(c));
  return n;
}

// ===========================================
//  STATE
// ===========================================
let me = null; // current user (safeUser shape)
let data = null; // { decoders, sources } — scoped to me
const ALL_SPACES = "All";
let selectedSpace = localStorage.getItem("visionarySpace") || ALL_SPACES;
let openDecoderIp = null;
let isRouting = false;
let closeTimer = null;
let isPasswordForced = false;
let isSelectMode = false; // "select several screens" mode: tiles toggle instead of opening the popup
const selected = new Set(); // screen IPs chosen in select mode
let isBatchMode = false; // the source popup is open for the selected screens, not a single one

// ===========================================
//  LOGIN / SESSION
// ===========================================
const loginScreen = $("loginScreen");
const appShell = $("appShell");

function showLogin(notice) {
  stopPolling();
  $("loginError").textContent = notice || "";
  loginScreen.classList.remove("hidden");
  appShell.classList.add("hidden");
}

function showApp() {
  loginScreen.classList.add("hidden");
  appShell.classList.remove("hidden");
}

$("loginForm").addEventListener(
  "submit",
  guarded(async (ev) => {
    ev.preventDefault();
    const errorEl = $("loginError");
    errorEl.textContent = "";
    $("loginSubmit").disabled = true;
    try {
      me = await api("/api/login", {
        body: { username: $("loginUsername").value, password: $("loginPassword").value },
      });
      $("loginPassword").value = "";
      await enterApp();
    } catch (err) {
      errorEl.textContent = err.message;
    } finally {
      $("loginSubmit").disabled = false;
    }
  }),
);

$("logoutBtn").addEventListener(
  "click",
  guarded(async () => {
    try {
      await api("/api/logout", { method: "POST" });
    } catch (err) {
      logError("Sign-out request failed; signing out on this page anyway", err);
    }
    me = null;
    data = null;
    showLogin();
  }),
);

async function enterApp() {
  if (me.mustChangePassword) {
    showApp();
    renderWho(); // so Sign out stays reachable from the menu
    openChangePassword(true);
    return;
  }
  showApp();
  renderHeader();
  data = await api("/api/devices");
  renderSpaces();
  renderTiles();
  await refresh();
  startPolling();
}

// The top of the account menu says who is signed in: their name, role and groups.
function renderWho() {
  const roleLabel = { admin: "Admin", manager: "Manager", user: "User" }[me.role] || me.role;
  const groups = me.groupNames || [];
  $("menuWhoName").textContent = me.name || me.username;
  $("menuWhoName").title = "Username: " + me.username; // on hover, for the rare case two people share a name
  $("menuWhoRole").textContent = "Role: " + roleLabel;
  $("menuWhoGroups").textContent =
    "Groups: " +
    (groups.length
      ? groups.join(", ")
      : me.role === "admin"
        ? "none (admins can use every screen)"
        : "none");
}

function renderHeader() {
  renderWho();
  $("adminBtn").classList.toggle("hidden", me.role !== "admin" && me.role !== "manager");
  $("devicesBtn").classList.toggle("hidden", me.role !== "admin");
  $("statusBtn").classList.toggle("hidden", me.role !== "admin" && me.role !== "manager"); // a Manager's covers their groups
  $("openTester").classList.toggle("hidden", me.role !== "admin");
}

// ===========================================
//  ACCOUNT MENU (Refresh / Change password / Sign out)
// ===========================================
const menuBtn = $("menuBtn");
const menuList = $("menuList");
// visible items only: Admin is hidden for plain users
const menuItems = () =>
  [...menuList.querySelectorAll('[role="menuitem"]')].filter(
    (b) => !b.classList.contains("hidden"),
  );

function menuOpen() {
  return !menuList.classList.contains("hidden");
}

function openMenu(focusFirst) {
  menuList.classList.remove("hidden");
  // Right-aligned under the button by default; if that would run off the left edge of the screen
  // (the button sits at the left when the header wraps on a phone), align to the button's left instead.
  menuList.style.left = "";
  menuList.style.right = "";
  if (menuBtn.getBoundingClientRect().right - menuList.offsetWidth < 8) {
    menuList.style.left = "0";
    menuList.style.right = "auto";
  }
  menuBtn.setAttribute("aria-expanded", "true");
  if (focusFirst) menuItems()[0].focus();
}

function closeMenu(returnFocus) {
  menuList.classList.add("hidden");
  menuBtn.setAttribute("aria-expanded", "false");
  if (returnFocus) menuBtn.focus();
}

menuBtn.addEventListener("click", () => (menuOpen() ? closeMenu(false) : openMenu(false)));
// choosing an item runs its own handler (registered elsewhere), then the menu closes
menuList.addEventListener("click", (ev) => {
  if (ev.target.closest("button")) closeMenu(false); // not when someone just clicks the "signed in as" label
});
document.addEventListener("click", (ev) => {
  if (menuOpen() && !$("userMenu").contains(ev.target)) closeMenu(false);
});
document.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape" && menuOpen()) closeMenu(true);
});
menuBtn.addEventListener("keydown", (ev) => {
  if (ev.key === "ArrowDown") {
    ev.preventDefault();
    openMenu(true);
  }
});
menuList.addEventListener("keydown", (ev) => {
  const items = menuItems();
  const i = items.indexOf(document.activeElement);
  if (ev.key === "ArrowDown") {
    ev.preventDefault();
    items[(i + 1) % items.length].focus();
  } else if (ev.key === "ArrowUp") {
    ev.preventDefault();
    items[(i - 1 + items.length) % items.length].focus();
  }
});

// ===========================================
//  ABOUT
// ===========================================
const aboutBackdrop = $("aboutBackdrop");
$("aboutBtn").addEventListener(
  "click",
  guarded(async () => {
    try {
      const a = await api("/api/about");
      // the program's own name is fixed in the page; a different name set in Branding is shown as what this install is called
      const setup = $("aboutSetup");
      setup.textContent =
        a.appName && a.appName !== "SwitchBoard-AV"
          ? `This installation is called “${a.appName}”.`
          : "";
      setup.classList.toggle("hidden", !setup.textContent);
      $("aboutVersion").textContent = "Version " + a.version;
      $("aboutLicense").textContent = a.license;
      $("aboutCopyright").textContent = a.copyright.replace("(c)", "©");
      const src = $("aboutSource");
      clear(src);
      if (a.sourceUrl && /^https?:\/\//.test(a.sourceUrl)) {
        src.append(
          document.createTextNode("Source code: "),
          el("a", {
            href: a.sourceUrl,
            target: "_blank",
            rel: "noopener noreferrer",
            text: a.sourceUrl,
          }),
        );
      }
      src.classList.toggle("hidden", !src.firstChild);
      aboutBackdrop.classList.add("open");
    } catch (err) {
      flashMsg(err.message, true);
    }
  }),
);
$("aboutClose").addEventListener("click", () => aboutBackdrop.classList.remove("open"));
aboutBackdrop.addEventListener("click", (ev) => {
  if (ev.target === aboutBackdrop) aboutBackdrop.classList.remove("open");
});

// ===========================================
//  CHANGE PASSWORD
// ===========================================
const pwBackdrop = $("pwBackdrop");

function openChangePassword(forced) {
  isPasswordForced = !!forced;
  $("pwClose").classList.toggle("hidden", isPasswordForced);
  $("pwForcedNote").textContent = isPasswordForced
    ? "This account has a temporary password. Choose a new password to continue."
    : "";
  $("pwError").textContent = "";
  $("pwForm").reset();
  pwBackdrop.classList.add("open");
}

function closeChangePassword() {
  if (isPasswordForced) return; // must complete the forced change first
  pwBackdrop.classList.remove("open");
}

$("changePasswordBtn").addEventListener("click", () => openChangePassword(false));
$("pwClose").addEventListener("click", closeChangePassword);

$("pwForm").addEventListener(
  "submit",
  guarded(async (ev) => {
    ev.preventDefault();
    const errorEl = $("pwError");
    errorEl.textContent = "";
    const next = $("pwNew").value;
    const confirm = $("pwConfirm").value;
    if (next !== confirm) {
      errorEl.textContent = "New password and confirmation do not match";
      return;
    }
    try {
      await api("/api/change-password", {
        body: { currentPassword: $("pwCurrent").value, newPassword: next },
      });
      pwBackdrop.classList.remove("open");
      if (isPasswordForced) {
        isPasswordForced = false;
        me.mustChangePassword = false;
        renderHeader();
        data = await api("/api/devices");
        renderSpaces();
        renderTiles();
        fire(refresh());
      }
    } catch (err) {
      errorEl.textContent = err.message;
    }
  }),
);

// ===========================================
//  TILES / SPACES / ROUTING
// ===========================================
const grid = $("grid");
const spacesEl = $("spaces");

function renderSpaces() {
  const names = [...new Set(data.decoders.map((d) => d.space))];
  if (selectedSpace !== ALL_SPACES && !names.includes(selectedSpace)) selectedSpace = ALL_SPACES;
  clear(spacesEl);
  for (const name of [ALL_SPACES, ...names]) {
    const count =
      name === ALL_SPACES
        ? data.decoders.length
        : data.decoders.filter((d) => d.space === name).length;
    const btn = el("button", { className: name === selectedSpace ? "active" : "" }, [
      el("span", { text: name }),
      el("span", { className: "count", text: String(count) }),
    ]);
    btn.addEventListener("click", () => {
      selectedSpace = name;
      localStorage.setItem("visionarySpace", name);
      renderTiles();
    });
    spacesEl.append(btn);
  }
}

function nowLabel(d) {
  if (d.reachable === false) return "No response";
  if (!d.host) return "Not read yet";
  const src = data.sources.find((s) => s.ip === d.host);
  if (src) return src.name;
  return "Other source";
}

function renderTiles() {
  renderSpaces();
  updateInputsMenu();
  clear(grid);
  if (data.decoders.length === 0) {
    grid.append(
      el("div", { className: "empty-state" }, [
        el("div", { text: "You don't have access to any screens yet." }),
        el("div", { text: "Ask your administrator to add you to a group." }),
      ]),
    );
    return;
  }
  for (const ip of [...selected]) if (!data.decoders.some((d) => d.ip === ip)) selected.delete(ip); // screen went away
  const shown = data.decoders.filter(
    (d) => selectedSpace === ALL_SPACES || d.space === selectedSpace,
  );
  // "Select several" is a group permission: leave select mode if it no longer applies, and only offer it
  // when at least two of the screens being shown may be picked together.
  if (isSelectMode && !data.decoders.some((d) => d.canMulti)) {
    isSelectMode = false;
    selected.clear();
  }
  if (shown.filter((d) => d.canMulti).length > 1 || isSelectMode) grid.append(selectBar(shown));
  for (const d of shown) {
    const isPicked = isSelectMode && selected.has(d.ip);
    const blank =
      d.output && d.output !== "NORMAL"
        ? el("div", { className: "badge", text: OUTPUT_LABELS[d.output] || d.output })
        : null;
    const tile = el(
      "button",
      {
        className: "tile" + (isPicked ? " selected" : ""),
        "aria-pressed": isSelectMode ? String(isPicked) : null,
      },
      [
        // zero-width space after "_" so long names like Gym_Concession_Stand_Display wrap at the underscore
        el("div", { className: "name", text: d.name.replace(/_/g, "_​") }),
        el("div", {
          className: "now" + (d.reachable === false ? " noreply" : ""),
          text: nowLabel(d),
        }),
        blank,
        // IP is shown to managers and admins only; plain users see just the name and status
        me.role === "user" ? null : el("div", { className: "ip", text: d.ip || "no IP set" }),
      ].filter(Boolean),
    );
    if (!isSelectMode) tile.removeAttribute("aria-pressed");
    if (isSelectMode && !d.canMulti) {
      tile.disabled = true; // not allowed in a multi-screen switch
      tile.classList.add("unselectable");
    }
    tile.addEventListener("click", () => {
      if (!isSelectMode) return openPopup(d.ip);
      if (selected.has(d.ip)) selected.delete(d.ip);
      else selected.add(d.ip);
      renderTiles();
    });
    grid.append(tile);
  }
}

// The bar above the tiles: turns on "select several", and once on, shows the selection controls.
function selectBar(shown) {
  const bar = el("div", { className: "select-bar" });
  if (!isSelectMode) {
    const on = el("button", { text: "Select several screens" });
    on.addEventListener("click", () => {
      isSelectMode = true;
      selected.clear();
      renderTiles();
    });
    bar.append(on);
    return bar;
  }
  const n = selected.size;
  const all = el("button", { text: "Select all shown" });
  all.addEventListener("click", () => {
    shown.filter((d) => d.canMulti).forEach((d) => selected.add(d.ip));
    renderTiles();
  });
  const none = el("button", { text: "Clear" });
  none.addEventListener("click", () => {
    selected.clear();
    renderTiles();
  });
  const go = el("button", {
    className: "primary",
    text: n ? `Choose a source for ${n}` : "Choose a source",
  });
  go.disabled = n === 0;
  go.addEventListener("click", openBatchPopup);
  const done = el("button", { text: "Done" });
  done.addEventListener("click", () => {
    isSelectMode = false;
    selected.clear();
    renderTiles();
  });
  bar.append(el("span", { className: "select-count", text: `${n} selected` }), all, none, go);
  // blank / message for the selection, only when the person may control every selected screen
  const allCan =
    n > 0 && [...selected].every((ip) => (data.decoders.find((d) => d.ip === ip) || {}).canScreen);
  if (allCan) {
    for (const [label, action] of [
      ["Black", "black"],
      ["Picture", "picture"],
      ["Message...", "message"],
    ]) {
      const b = el("button", { text: label });
      b.addEventListener(
        "click",
        guarded(() => batchScreen(action)),
      );
      bar.append(b);
    }
  }
  bar.append(done);
  return bar;
}

// Briefly shows a result in the header, then goes back to the "Updated" time.
let flashTimer = null;
function flashMsg(text, bad) {
  const msg = $("msg");
  msg.className = `status-message ${bad ? "bad" : "ok"}`;
  msg.textContent = text;
  clearTimeout(flashTimer);
  flashTimer = setTimeout(stampUpdated, 8000);
}

async function batchScreen(action) {
  const ips = [...selected];
  let text;
  if (action === "message") {
    text = window.prompt(
      `Message to show on ${ips.length} screen${ips.length === 1 ? "" : "s"} (up to 80 characters; leave empty to cancel)`,
      "",
    );
    if (!text || !text.trim()) return;
    text = text.trim();
  }
  const label = { black: "Black screen", picture: "Picture", message: "Message" }[action];
  flashMsg(`${label}: sending to ${ips.length}...`, false);
  try {
    const r = await api("/api/screen", { body: { decoderIps: ips, action, text } });
    data = r.snapshot;
    renderTiles();
    const bad = r.results.filter((x) => !x.ok);
    if (bad.length === 0) flashMsg(`${label}: all ${ips.length} confirmed`, false);
    else
      flashMsg(
        `${label}: ${ips.length - bad.length} of ${ips.length} confirmed. Not confirmed: ${bad
          .slice(0, 5)
          .map((x) => x.name)
          .join(", ")}${bad.length > 5 ? " ..." : ""}`,
        true,
      );
  } catch (err) {
    flashMsg(`${label}: ${err.message}`, true);
  }
}

const backdrop = $("backdrop");
const sourcesEl = $("sources");
const statusEl = $("status");

function setStatus(cls, text) {
  statusEl.className = "modal-foot " + cls;
  statusEl.textContent = text;
}

function renderSources() {
  // The source that is "current": the screen's own, or for several screens the one they all share.
  let currentHost;
  if (isBatchMode) {
    const hosts = new Set(
      [...selected].map((ip) => (data.decoders.find((x) => x.ip === ip) || {}).host || null),
    );
    currentHost = hosts.size === 1 ? [...hosts][0] : null;
    $("modalTitle").textContent = `${selected.size} screens — choose a source`;
  } else {
    const d = data.decoders.find((x) => x.ip === openDecoderIp);
    currentHost = d.host;
    $("modalTitle").textContent = `${d.name.replace(/_/g, "_​")} — choose a source`;
  }
  clear(sourcesEl);
  // Shared sources first; local sources (tied to a space) only when every chosen screen is in that space,
  // under their own heading per space.
  const targetIps = isBatchMode ? [...selected] : [openDecoderIp];
  const targetSpaces = new Set(
    targetIps.map((ip) => (data.decoders.find((x) => x.ip === ip) || {}).space),
  );
  const shared = data.sources.filter((s) => !s.space);
  const local = data.sources.filter((s) => s.space && targetSpaces.size === 1 && targetSpaces.has(s.space));
  if (shared.length === 0 && local.length === 0) {
    sourcesEl.append(el("div", { className: "sub", text: "No sources are available to you." }));
    return;
  }
  const addButton = (s) => {
    const btn = el("button", {
      className: "src" + (currentHost === s.ip ? " current" : ""),
      text: s.name,
    });
    btn.disabled = isRouting;
    btn.addEventListener(
      "click",
      guarded(() => takeRoute(s.ip)),
    );
    sourcesEl.append(btn);
  };
  shared.forEach(addButton);
  if (local.length) {
    sourcesEl.append(el("div", { className: "sub", text: `${local[0].space} only` }));
    local.forEach(addButton);
  }
}

// The source popup for every screen picked in select mode.
function openBatchPopup() {
  if (selected.size === 0) return;
  clearTimeout(closeTimer);
  isBatchMode = true;
  openDecoderIp = null;
  isRouting = false;
  setStatus("", "");
  renderSources();
  tvRow.classList.add("hidden"); // TV power is per screen, not part of a group switch
  $("screenRow").classList.add("hidden");
  $("msgRow").classList.add("hidden");
  backdrop.classList.add("open");
}

function openPopup(ip) {
  clearTimeout(closeTimer);
  isBatchMode = false;
  openDecoderIp = ip;
  isRouting = false;
  setStatus("", "");
  renderSources();
  fire(renderTvPower(ip));
  fire(renderScreenControls(ip));
  backdrop.classList.add("open");
}

// ----- blank screen / on-screen message (only for screens the user may control; the server enforces it too) -----
const scrRow = $("screenRow");
const msgRow = $("msgRow");
const OUTPUT_LABELS = {
  NORMAL: "Picture",
  STANDBY: "Black screen",
  LOGO: "Logo",
  OFF: "Output off",
};
let isScreenBusy = false;

function setScreenButtons() {
  for (const id of ["scrPicture", "scrBlack", "scrLogo", "msgShow", "msgClear"])
    $(id).disabled = isScreenBusy;
}

function showScreenState(output, osd) {
  $("screenState").className = "tv-state";
  $("screenState").textContent = OUTPUT_LABELS[output] || "Unknown";
  $("msgState").className = "tv-state";
  $("msgState").textContent = osd ? `Showing: "${osd}"` : "";
  if (osd !== undefined && osd !== null && document.activeElement !== $("msgText"))
    $("msgText").value = osd;
}

async function renderScreenControls(ip) {
  const d = data.decoders.find((x) => x.ip === ip);
  const can = !!(d && d.canScreen);
  scrRow.classList.toggle("hidden", !can);
  msgRow.classList.toggle("hidden", !can);
  if (!can) return;
  $("msgText").value = "";
  showScreenState(d.output, null);
  isScreenBusy = true;
  setScreenButtons();
  try {
    const r = await api("/api/screen", { body: { decoderIps: [ip], action: "status" } });
    data = r.snapshot;
    const one = r.results[0];
    if (openDecoderIp === ip) showScreenState(one.output || d.output, one.osd);
  } catch (err) {
    if (openDecoderIp === ip) {
      $("screenState").className = "tv-state bad";
      $("screenState").textContent = err.message;
    }
  }
  isScreenBusy = false;
  setScreenButtons();
}

async function setScreen(action, text) {
  const ip = openDecoderIp;
  if (!ip) return;
  // feedback goes in the row the person used: the Message row for messages, the Screen row for the rest
  const isMsg = action === "message" || action === "clear-message";
  const stateEl = isMsg ? $("msgState") : $("screenState");
  isScreenBusy = true;
  setScreenButtons();
  stateEl.className = "tv-state wait";
  stateEl.textContent = "Working...";
  try {
    const r = await api("/api/screen", { body: { decoderIps: [ip], action, text } });
    data = r.snapshot;
    renderTiles();
    const one = r.results[0];
    if (openDecoderIp === ip) {
      if (one.error) throw new Error(one.error);
      const d = data.decoders.find((x) => x.ip === ip);
      showScreenState(
        d.output,
        action === "message" ? text : action === "clear-message" ? "" : null,
      );
      if (!one.ok) {
        stateEl.className = "tv-state bad";
        stateEl.textContent = "Sent, but the screen did not confirm";
      } else stateEl.className = "tv-state ok";
    }
  } catch (err) {
    if (openDecoderIp === ip) {
      stateEl.className = "tv-state bad";
      stateEl.textContent = err.message;
    }
  }
  isScreenBusy = false;
  setScreenButtons();
}

$("scrPicture").addEventListener(
  "click",
  guarded(() => setScreen("picture")),
);
$("scrBlack").addEventListener(
  "click",
  guarded(() => setScreen("black")),
);
$("scrLogo").addEventListener(
  "click",
  guarded(() => setScreen("logo")),
);
$("msgShow").addEventListener("click", () => {
  const text = $("msgText").value.trim();
  if (!text) return $("msgText").focus();
  fire(setScreen("message", text));
});
$("msgClear").addEventListener(
  "click",
  guarded(() => setScreen("clear-message")),
);
$("msgText").addEventListener("keydown", (ev) => ev.key === "Enter" && $("msgShow").click());

// ----- TV power (only for screens the user may power; the server enforces this too) -----
const tvRow = $("tvPowerRow");
const tvStateEl = $("tvState");
let isTvBusy = false;

function tvLabel(on) {
  return on === true ? "On" : on === false ? "Off" : "Unknown";
}

function setTvButtons() {
  $("tvOn").disabled = isTvBusy;
  $("tvOff").disabled = isTvBusy;
}

// Shows the row and reads the TV's current state from the server.
async function renderTvPower(ip) {
  const d = data.decoders.find((x) => x.ip === ip);
  tvRow.classList.toggle("hidden", !(d && d.canPower));
  if (!d || !d.canPower) return;
  tvStateEl.className = "tv-state";
  tvStateEl.textContent = d.tvOn === null ? "Checking..." : tvLabel(d.tvOn);
  isTvBusy = true;
  setTvButtons();
  try {
    const r = await api("/api/tv-power", { body: { decoderIp: ip, action: "status" } });
    data = r.snapshot;
    if (openDecoderIp === ip) tvStateEl.textContent = tvLabel(r.on);
  } catch (err) {
    if (openDecoderIp === ip) {
      tvStateEl.className = "tv-state bad";
      tvStateEl.textContent = err.message;
    }
  }
  isTvBusy = false;
  setTvButtons();
}

async function setTvPower(action) {
  const ip = openDecoderIp;
  const d = data.decoders.find((x) => x.ip === ip);
  if (!d) return;
  if (action === "off" && !window.confirm(`Turn off the TV for ${d.name}?`)) return;
  isTvBusy = true;
  setTvButtons();
  tvStateEl.className = "tv-state wait";
  tvStateEl.textContent = action === "on" ? "Turning on..." : "Turning off...";
  try {
    const r = await api("/api/tv-power", { body: { decoderIp: ip, action } });
    data = r.snapshot;
    if (openDecoderIp === ip) {
      tvStateEl.className = "tv-state ok";
      tvStateEl.textContent = tvLabel(r.on);
    }
  } catch (err) {
    if (openDecoderIp === ip) {
      tvStateEl.className = "tv-state bad";
      tvStateEl.textContent = err.message;
    }
  }
  isTvBusy = false;
  setTvButtons();
}

$("tvOn").addEventListener(
  "click",
  guarded(() => setTvPower("on")),
);
$("tvOff").addEventListener(
  "click",
  guarded(() => setTvPower("off")),
);

function closePopup() {
  clearTimeout(closeTimer);
  backdrop.classList.remove("open");
  openDecoderIp = null;
  isBatchMode = false;
}

// Switches the open screen, or every selected screen when the popup is in batch mode.
async function takeRoute(encoderIp) {
  const batch = isBatchMode;
  const decoderIp = openDecoderIp;
  const ips = batch ? [...selected] : [decoderIp];
  const stillHere = () => (batch ? isBatchMode : openDecoderIp === decoderIp); // popup not closed or moved on
  isRouting = true;
  renderSources();
  setStatus("wait", ips.length > 1 ? `Switching ${ips.length} screens...` : "Switching...");
  try {
    const r = await api("/api/route", { body: { decoderIps: ips, encoderIp } });
    data = r.snapshot;
    renderTiles();
    if (!stillHere()) return;
    isRouting = false;
    renderSources();
    if (!batch) {
      const one = r.results[0];
      if (one.error) setStatus("bad", one.error);
      else if (one.confirmed) {
        setStatus("ok", "Confirmed");
        closeTimer = setTimeout(closePopup, CLOSE_AFTER_CONFIRM_MS);
      } else setStatus("bad", `Not confirmed (decoder reports ${one.host})`);
      return;
    }
    const failed = r.results.filter((x) => !x.confirmed);
    if (failed.length === 0) {
      setStatus("ok", `All ${r.results.length} screens confirmed`);
      closeTimer = setTimeout(() => {
        closePopup();
        isSelectMode = false;
        selected.clear();
        renderTiles();
      }, CLOSE_AFTER_CONFIRM_MS);
    } else {
      const names = failed.slice(0, 6).map((x) => x.name);
      const more = failed.length > 6 ? ` and ${failed.length - 6} more` : "";
      setStatus(
        "bad",
        `${r.results.length - failed.length} of ${r.results.length} confirmed. Not confirmed: ${names.join(", ")}${more}`,
      );
    }
  } catch (err) {
    isRouting = false;
    if (stillHere()) {
      renderSources();
      setStatus("bad", err.message);
    }
  }
}

async function refresh() {
  const msg = $("msg");
  msg.className = "status-message wait";
  msg.textContent = "Reading decoders...";
  try {
    data = await api("/api/refresh", { method: "POST" });
    stampUpdated();
  } catch (err) {
    msg.className = "status-message bad";
    msg.textContent = err.message;
  }
  renderTiles();
}

function stampUpdated() {
  const msg = $("msg");
  msg.className = "status-message stamp";
  msg.textContent =
    "Updated " + new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

// ----- keep the tiles current: ask the decoders again every pollSeconds while the page is in view -----
let pollTimer = null;
let isPolling = false;

function stopPolling() {
  clearInterval(pollTimer);
  pollTimer = null;
}

function startPolling() {
  stopPolling();
  const secs = data && data.pollSeconds;
  if (secs > 0) pollTimer = setInterval(guarded(silentRefresh), secs * 1000);
}

// Skips a turn if the tab is hidden, a refresh is already running, or the person is mid-switch / mid-TV-command.
async function silentRefresh() {
  if (document.hidden || isPolling || isRouting || isTvBusy || isScreenBusy || !me) return;
  isPolling = true;
  try {
    const next = await api("/api/refresh", { method: "POST", background: true });
    data = next;
    stampUpdated();
    renderTiles();
  } catch (err) {
    if (err.status === 401) {
      // api() has normally signed the person out already, with a message; this only covers a 401 without one
      if (me) {
        me = null;
        data = null;
        showLogin(err.message);
      }
    } else {
      $("msg").className = "status-message bad";
      $("msg").textContent = "Can't update right now";
    }
  }
  isPolling = false;
}

document.addEventListener("visibilitychange", () => {
  if (!document.hidden && pollTimer) fire(silentRefresh());
});

$("close").addEventListener("click", closePopup);
backdrop.addEventListener("click", (ev) => {
  if (ev.target === backdrop) closePopup();
});
document.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape") {
    closePopup();
    closeTester();
    $("inputsBackdrop").classList.remove("open");
  }
});
$("refresh").addEventListener("click", guarded(refresh));

// ===========================================
//  QUERY TESTER (admin only)
// ===========================================
const testerBackdrop = $("testerBackdrop");
const testerDecoder = $("testerDecoder");
const testerKey = $("testerKey");
const testerSend = $("testerSend");
const testerLog = $("testerLog");

// Screens and sources share one list; a name for whichever the selected address belongs to.
const testerDevice = (ip) =>
  data.decoders.find((x) => x.ip === ip) || data.sources.find((x) => x.ip === ip);

// TV power is read through a screen's serial port, so it makes no sense for a source.
function updateTesterTvButton() {
  $("testerTvPower").disabled = !data.decoders.some((x) => x.ip === testerDecoder.value);
}
testerDecoder.addEventListener("change", updateTesterTvButton);

function openTester() {
  const keep = testerDecoder.value;
  clear(testerDecoder);
  for (const [label, list] of [
    ["Screens", data.decoders],
    ["Sources", data.sources],
  ]) {
    if (list.length === 0) continue;
    const group = document.createElement("optgroup");
    group.label = label;
    for (const d of list) group.append(new Option(`${d.name} (${d.ip})`, d.ip));
    testerDecoder.append(group);
  }
  if (keep) testerDecoder.value = keep;
  updateTesterTvButton();
  testerBackdrop.classList.add("open");
  testerKey.focus();
}

function closeTester() {
  testerBackdrop.classList.remove("open");
}

async function sendTest(diag) {
  const key = testerKey.value.trim().replace(/^QUERY\.KEY=/i, "");
  if (!diag && !key) return;
  const deviceIp = testerDecoder.value;
  const d = testerDevice(deviceIp);
  testerSend.disabled = true;
  testerLog.textContent += `> ${d ? d.name : deviceIp}  ${diag ? "QUERY." + diag + "=TRUE" : "QUERY.KEY=" + key}\n`;
  try {
    const r = await api("/api/test-query", { body: { deviceIp, key, diag } });
    if (r.replies.length === 0) testerLog.textContent += "  (no reply in 2 s)\n\n";
    else testerLog.textContent += r.replies.map((t) => "  < " + t).join("\n") + "\n\n";
  } catch (err) {
    testerLog.textContent += `  ERROR: ${err.message}\n\n`;
  }
  testerSend.disabled = false;
  testerLog.scrollTop = testerLog.scrollHeight;
}

$("openTester").addEventListener("click", () => data && openTester());
$("testerClose").addEventListener("click", closeTester);
testerBackdrop.addEventListener("click", (ev) => {
  if (ev.target === testerBackdrop) closeTester();
});
testerSend.addEventListener(
  "click",
  guarded(() => sendTest()),
);
$("testerClear").addEventListener("click", () => {
  testerLog.textContent = "";
});
testerKey.addEventListener("keydown", (ev) => {
  if (ev.key === "Enter") fire(sendTest());
});
document.querySelectorAll("#diagRow button[data-diag]").forEach((b) => {
  b.addEventListener(
    "click",
    guarded(() => sendTest(b.dataset.diag)),
  );
});

// Reads the selected decoder's TV over its serial port (status query only, never powers anything).
// Works on any decoder, flagged or not, so a screen can be checked before it is enabled in devices.json.
$("testerTvPower").addEventListener(
  "click",
  guarded(async () => {
    const decoderIp = testerDecoder.value;
    const d = testerDevice(decoderIp);
    const btn = $("testerTvPower");
    btn.disabled = true;
    testerLog.textContent += `> ${d ? d.name : decoderIp}  TV power status over serial (TCP)\n`;
    try {
      const r = await api("/api/tv-power", { body: { decoderIp, action: "status", probe: true } });
      testerLog.textContent += `  < ${JSON.stringify(r.raw)}  =>  TV is ${r.on ? "ON" : "OFF"}\n\n`;
    } catch (err) {
      testerLog.textContent += `  ERROR: ${err.message}\n\n`;
    }
    btn.disabled = false;
    testerLog.scrollTop = testerLog.scrollHeight;
  }),
);

// ===========================================
//  ADMIN
// ===========================================
const adminBackdrop = $("adminBackdrop");
let spacesDirectory = null; // from /api/admin/spaces — full device list by space (admin only)
let groupsCache = [];
let usersCache = [];

$("adminBtn").addEventListener(
  "click",
  guarded(() => openAdmin("users")),
);
$("devicesBtn").addEventListener(
  "click",
  guarded(() => openAdmin("devices")),
);
$("statusBtn").addEventListener(
  "click",
  guarded(() => openAdmin("status")),
);
$("adminClose").addEventListener("click", () => adminBackdrop.classList.remove("open"));
adminBackdrop.addEventListener("click", (ev) => {
  if (ev.target === adminBackdrop) adminBackdrop.classList.remove("open");
});

document.querySelectorAll(".admin-tabs button[data-tab]").forEach((btn) => {
  btn.addEventListener("click", () => selectAdminTab(btn.dataset.tab));
});

function selectAdminTab(tab) {
  document
    .querySelectorAll(".admin-tabs button[data-tab]")
    .forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  document.querySelectorAll(".admin-panel").forEach((p) => p.classList.remove("active"));
  $(tab + "Panel").classList.add("active");
  $("adminTitle").textContent =
    {
      users: "Users",
      groups: "Groups",
      activity: "Activity",
      devices: "Devices",
      status: "Status",
      branding: "Branding",
      security: "Security",
      backup: "Backup",
    }[tab] || "Users";
  if (tab === "status") fire(loadStatus());
  if (tab === "branding") fire(loadBrandingForm());
  if (tab === "security") fire(loadSecurity());
  if (tab === "backup") {
    backupNote("");
    loadDevices().catch((err) => backupNote(err.message, true)); // fills in the list note and the change history
  }
  if (tab === "activity") fire(loadActivity());
  if (tab === "groups") renderGroupsList();
  if (tab === "devices") {
    selectDevSub("screens");
    loadDevices().catch((err) => devNote(err.message, true));
  }
}

async function openAdmin(startTab) {
  const isAdmin = me.role === "admin";
  $("groupsTabBtn").classList.toggle("hidden", !isAdmin);
  $("activityTabBtn").classList.toggle("hidden", !isAdmin);
  $("devicesTabBtn").classList.toggle("hidden", !isAdmin);
  $("statusTabBtn").classList.toggle("hidden", !isAdmin && me.role !== "manager");
  $("securityTabBtn").classList.toggle("hidden", !isAdmin);
  $("brandingTabBtn").classList.toggle("hidden", !isAdmin);
  $("backupTabBtn").classList.toggle("hidden", !isAdmin);
  $("newUserRoleField").classList.toggle("hidden", !isAdmin);
  $("tempPasswordBanner").classList.add("hidden");
  selectAdminTab("users");
  if (isAdmin) {
    spacesDirectory = await api("/api/admin/spaces");
  }
  await loadGroups();
  await loadUsers();
  if (startTab && startTab !== "users") selectAdminTab(startTab);
  adminBackdrop.classList.add("open");
}

async function loadGroups() {
  groupsCache = await api("/api/admin/groups");
}

async function loadUsers() {
  usersCache = await api("/api/admin/users");
  renderUsers();
}

function groupName(id) {
  const g = groupsCache.find((x) => x.id === id);
  return g ? g.name : id;
}

function renderUsers() {
  const list = $("usersList");
  clear(list);
  for (const u of usersCache) {
    const chips = [el("span", { className: "chip role-" + u.role, text: u.role })];
    if (u.disabled) chips.push(el("span", { className: "chip disabled", text: "disabled" }));
    for (const gid of u.groups || [])
      chips.push(el("span", { className: "chip", text: groupName(gid) }));

    const row = el("div", { className: "row" }, [
      el("div", { className: "grow" }, [
        el("div", { text: `${u.name} — ${u.username}` }),
        el("div", {}, chips),
      ]),
    ]);

    // Edit opens the shared form: name, username, role and groups (managers: groups only).
    const editBtn = el("button", { text: "Edit" });
    editBtn.addEventListener("click", () => openUserForm(u));
    row.append(editBtn);

    const resetBtn = el("button", { text: "Reset password" });
    resetBtn.addEventListener(
      "click",
      guarded(async () => {
        try {
          const r = await api(`/api/admin/users/${u.id}/reset-password`, { method: "POST" });
          const banner = $("tempPasswordBanner");
          banner.textContent = `Temporary password for ${u.username}: ${r.tempPassword} (shown once — share it with them now)`;
          banner.classList.remove("hidden");
        } catch (err) {
          window.alert(err.message);
        }
      }),
    );
    row.append(resetBtn);

    const disableBtn = el("button", { text: u.disabled ? "Enable" : "Disable" });
    disableBtn.addEventListener(
      "click",
      guarded(async () => {
        try {
          await api(`/api/admin/users/${u.id}/disable`, { body: { disabled: !u.disabled } });
          await loadUsers();
        } catch (err) {
          window.alert(err.message);
        }
      }),
    );
    row.append(disableBtn);

    if (me.role === "admin" && u.id !== me.id) {
      const delBtn = el("button", { className: "danger", text: "Delete" });
      delBtn.addEventListener(
        "click",
        guarded(async () => {
          if (!window.confirm(`Delete ${u.username}? This cannot be undone.`)) return;
          try {
            await api(`/api/admin/users/${u.id}`, { method: "DELETE" });
            await loadUsers();
          } catch (err) {
            window.alert(err.message);
          }
        }),
      );
      row.append(delBtn);
    }

    list.append(row);
  }
}

// --- add user form ---
let editingUser = null; // null = adding a new user; otherwise the user object being edited

// Open the shared add/edit form. Pass a user to edit, or nothing to add.
function openUserForm(u) {
  editingUser = u || null;
  // Managers can only change a user's groups; name, username and role are admin-only.
  const groupsOnly = !!u && me.role !== "admin";
  $("newUserName").disabled = groupsOnly;
  $("newUserUsername").disabled = groupsOnly;
  $("addUserForm").classList.remove("hidden");
  $("newUserError").textContent = "";
  $("newUserName").value = u ? u.name : "";
  $("newUserUsername").value = u ? u.username : "";
  $("newUserRole").value = u ? u.role : "user";
  // Own role can't be changed here (the server also guards the last admin).
  $("newUserRole").disabled = !!u && u.id === me.id;
  $("newUserSave").textContent = u ? "Save changes" : "Create user";
  renderNewUserGroups(u ? u.groups || [] : []);
  $("addUserForm").scrollIntoView({ block: "nearest" });
}

$("addUserBtn").addEventListener("click", () => openUserForm(null));
$("newUserCancel").addEventListener("click", () => {
  editingUser = null;
  $("addUserForm").classList.add("hidden");
});

function renderNewUserGroups(selected = []) {
  const box = $("newUserGroups");
  clear(box);
  const picked = new Set(selected);
  for (const g of groupsCache) {
    const cb = el("input", { type: "checkbox", value: g.id });
    cb.checked = picked.has(g.id);
    box.append(el("label", {}, [cb, document.createTextNode(" " + g.name)]));
  }
}

// Apply only the fields that changed to an existing user.
async function saveUserEdits(u) {
  const base = `/api/admin/users/${u.id}`;
  const name = $("newUserName").value.trim();
  const username = $("newUserUsername").value.trim().toLowerCase();
  const role = $("newUserRole").value;
  const groups = [...$("newUserGroups").querySelectorAll("input:checked")].map((i) => i.value);
  if (name !== u.name) await api(`${base}/rename`, { body: { name } });
  if (username !== u.username) await api(`${base}/username`, { body: { username } });
  if (role !== u.role && u.id !== me.id) {
    const r = await api(`${base}/role`, { body: { role } });
    if (r.groupsUpdated) {
      const banner = $("tempPasswordBanner");
      banner.textContent = `${u.name} was also removed as a manager of ${r.groupsUpdated} group${r.groupsUpdated === 1 ? "" : "s"}.`;
      banner.classList.remove("hidden");
    }
  }
  // Role changes can drop manager rights but never groups; send the checked list as the final state.
  const before = [...(u.groups || [])].sort().join(",");
  if (groups.slice().sort().join(",") !== before) await api(`${base}/groups`, { body: { groups } });
}

$("newUserSave").addEventListener(
  "click",
  guarded(async () => {
    const errorEl = $("newUserError");
    errorEl.textContent = "";
    if (editingUser) {
      try {
        await saveUserEdits(editingUser);
        editingUser = null;
        $("addUserForm").classList.add("hidden");
        await loadUsers();
      } catch (err) {
        errorEl.textContent = err.message;
        await loadUsers().catch(() => {});
      }
      return;
    }
    const groups = [...$("newUserGroups").querySelectorAll("input:checked")].map((i) => i.value);
    try {
      const r = await api("/api/admin/users", {
        body: {
          name: $("newUserName").value,
          username: $("newUserUsername").value,
          role: $("newUserRole").value,
          groups,
        },
      });
      $("addUserForm").classList.add("hidden");
      $("newUserName").value = "";
      $("newUserUsername").value = "";
      const banner = $("tempPasswordBanner");
      banner.textContent = `Temporary password for ${r.user.username}: ${r.tempPassword} (shown once — share it with them now)`;
      banner.classList.remove("hidden");
      await loadUsers();
    } catch (err) {
      errorEl.textContent = err.message;
    }
  }),
);

// --- groups panel (admin only) ---
$("addGroupBtn").addEventListener("click", () => openGroupForm(null));
$("groupCancel").addEventListener("click", () => $("groupForm").classList.add("hidden"));

function renderGroupsList() {
  const list = $("groupsList");
  clear(list);
  for (const g of groupsCache) {
    const row = el("div", { className: "row" }, [
      el("div", { className: "grow" }, [
        el("div", { text: g.name }),
        el("div", {
          className: "sub",
          text: `${g.spaces.length} space(s), ${g.decoders.length} extra screen(s), sources: ${g.sources === "all" ? "all" : g.sources.length}, managers: ${(g.managers || []).join(", ") || "none"}`,
        }),
      ]),
    ]);
    const editBtn = el("button", { text: "Edit" });
    editBtn.addEventListener("click", () => openGroupForm(g));
    row.append(editBtn);
    const delBtn = el("button", { className: "danger", text: "Delete" });
    delBtn.addEventListener(
      "click",
      guarded(async () => {
        if (!window.confirm(`Delete group "${g.name}"? Users in it will lose that access.`)) return;
        await api(`/api/admin/groups/${g.id}`, { method: "DELETE" });
        await loadGroups();
        renderGroupsList();
      }),
    );
    row.append(delBtn);
    list.append(row);
  }
}

function openGroupForm(g) {
  $("groupForm").classList.remove("hidden");
  $("groupError").textContent = "";
  $("groupFormId").value = g ? g.id : "";
  $("groupName").value = g ? g.name : "";
  renderGroupManagers(g ? g.managers || [] : []);
  $("groupSourcesAll").checked = g ? g.sources === "all" : false;
  $("groupTvPower").checked = g ? g.tvPower === true : false;
  $("groupScreenControl").checked = g ? g.screenControl === true : false;
  $("groupInputControl").checked = g ? g.inputControl === true : false;
  $("groupMultiSwitch").checked = g ? g.multiSwitch === true : false;

  // Per space: the space checkbox grants the whole space (new decoders added to it later
  // are included automatically). Inside an expanded space, when the space box is ticked the
  // decoder checkboxes default CHECKED and unticking one carves it out (excludeDecoders).
  // When the space box is NOT ticked, decoder checkboxes default UNCHECKED and ticking one
  // grants just that decoder (decoders[]) without pulling in the rest of the space.
  const spacesBox = $("groupSpaces");
  clear(spacesBox);
  for (const space of spacesDirectory) {
    const spaceChecked = g ? g.spaces.includes(space.name) : false;
    const details = el("details", { className: "space-group" });
    const spaceInput = el("input", {
      type: "checkbox",
      className: "space-check",
      "data-space": space.name,
    });
    spaceInput.checked = spaceChecked;
    const summary = el("summary", {}, [
      el("label", {}, [
        spaceInput,
        document.createTextNode(
          ` ${space.name} (${space.decoders.length} ${space.decoders.length === 1 ? "screen" : "screens"})`,
        ),
      ]),
    ]);
    details.append(summary);
    const inner = el("div", { className: "checkbox-grid" });
    const decoderInputs = [];
    for (const d of space.decoders) {
      const checked = spaceChecked
        ? !g.excludeDecoders.includes(d.ip)
        : !!(g && g.decoders.includes(d.ip));
      const input = el("input", { type: "checkbox", className: "decoder-pick", "data-ip": d.ip });
      input.checked = checked;
      decoderInputs.push(input);
      const label = el("label", {}, [input, document.createTextNode(" " + d.name)]);
      inner.append(label);
    }
    details.append(inner);
    spacesBox.append(details);
    // Toggling the whole-space box resets every decoder box underneath it to that box's default.
    spaceInput.addEventListener("change", () => {
      decoderInputs.forEach((input) => {
        input.checked = spaceInput.checked;
      });
      updateGroupPreview();
    });
    decoderInputs.forEach((input) => input.addEventListener("change", updateGroupPreview));
  }

  const sourcesBox = $("groupSources");
  clear(sourcesBox);
  for (const s of getAllSources()) {
    const checked = g && g.sources !== "all" ? g.sources.includes(s.ip) : false;
    const label = el("label", {}, [
      el("input", { type: "checkbox", className: "source-check", "data-ip": s.ip }),
      document.createTextNode(" " + s.name),
    ]);
    label.querySelector("input").checked = checked;
    sourcesBox.append(label);
  }
  $("groupSourcesAll").onchange = updateGroupPreview;
  $("groupTvPower").onchange = updateGroupPreview;
  sourcesBox
    .querySelectorAll(".source-check")
    .forEach((cb) => cb.addEventListener("change", updateGroupPreview));
  updateGroupPreview();
}

// Admin always sees the full encoder list via /api/devices (admin role is unscoped).
function getAllSources() {
  return data ? data.sources : [];
}

// Reads the current state of the space/decoder checkboxes into { spaces, decoders, excludeDecoders }.
function readGroupScopeForm() {
  const spaces = [];
  const decoders = [];
  const excludeDecoders = [];
  document.querySelectorAll("#groupSpaces .space-group").forEach((details) => {
    const spaceInput = details.querySelector(".space-check");
    const decoderInputs = [...details.querySelectorAll(".decoder-pick")];
    if (spaceInput.checked) {
      spaces.push(spaceInput.dataset.space);
      decoderInputs.filter((i) => !i.checked).forEach((i) => excludeDecoders.push(i.dataset.ip));
    } else {
      decoderInputs.filter((i) => i.checked).forEach((i) => decoders.push(i.dataset.ip));
    }
  });
  return { spaces, decoders, excludeDecoders };
}

// The "Group managers" dropdown: a tick list of everyone with the Manager role. (Someone who loses the role
// is removed from every group's managers by the server, so the list never holds anyone else.)
function renderGroupManagers(selected) {
  const box = $("groupManagers");
  clear(box);
  const rows = usersCache
    .filter((u) => u.role === "manager")
    .map((u) => ({ username: u.username, label: `${u.name} (${u.username})` }));
  if (rows.length === 0) {
    box.append(
      el("div", {
        className: "sub",
        text: "No one has the Manager role yet. Set a person's role to Manager in Users first.",
      }),
    );
  }
  for (const r of rows) {
    const cb = el("input", { type: "checkbox", value: r.username });
    cb.checked = selected.includes(r.username);
    cb.addEventListener("change", updateManagersSummary);
    box.append(el("label", {}, [cb, document.createTextNode(" " + r.label)]));
  }
  updateManagersSummary();
}

function updateManagersSummary() {
  const picked = [...$("groupManagers").querySelectorAll("input:checked")].map((cb) =>
    cb.parentElement.textContent.trim(),
  );
  $("groupManagersSummary").textContent = picked.length ? picked.join(", ") : "No managers";
}

function updateGroupPreview() {
  const { spaces, decoders, excludeDecoders } = readGroupScopeForm();
  let screenCount = decoders.length;
  for (const space of spacesDirectory) {
    if (!spaces.includes(space.name)) continue;
    for (const d of space.decoders) if (!excludeDecoders.includes(d.ip)) screenCount++;
  }
  const sourcesAll = $("groupSourcesAll").checked;
  const sourceCount = sourcesAll
    ? getAllSources().length
    : document.querySelectorAll(".source-check:checked").length;
  let text = `This group will see ${screenCount} screen(s) and ${sourceCount} source(s).`;
  if ($("groupTvPower").checked) {
    const inScope = new Set(decoders);
    for (const space of spacesDirectory) {
      if (spaces.includes(space.name))
        for (const d of space.decoders) if (!excludeDecoders.includes(d.ip)) inScope.add(d.ip);
    }
    let tvCount = 0;
    for (const space of spacesDirectory)
      for (const d of space.decoders) if (d.tvPower && inScope.has(d.ip)) tvCount++;
    text += ` TV power will work on ${tvCount} of them.`;
  }
  $("groupPreview").textContent = text;
}

$("groupSave").addEventListener(
  "click",
  guarded(async () => {
    const errorEl = $("groupError");
    errorEl.textContent = "";
    const id = $("groupFormId").value;
    const name = $("groupName").value.trim();
    if (!name) {
      errorEl.textContent = "Name required";
      return;
    }
    const { spaces, decoders, excludeDecoders } = readGroupScopeForm();
    const sourcesAll = $("groupSourcesAll").checked;
    const sources = sourcesAll
      ? "all"
      : [...document.querySelectorAll(".source-check:checked")].map((cb) => cb.dataset.ip);
    const managers = [...$("groupManagers").querySelectorAll("input:checked")].map(
      (cb) => cb.value,
    );
    const body = {
      name,
      spaces,
      decoders,
      excludeDecoders,
      sources,
      managers,
      tvPower: $("groupTvPower").checked,
      screenControl: $("groupScreenControl").checked,
      inputControl: $("groupInputControl").checked,
      multiSwitch: $("groupMultiSwitch").checked,
    };
    try {
      if (id) await api(`/api/admin/groups/${id}`, { method: "PATCH", body });
      else await api("/api/admin/groups", { body });
      $("groupForm").classList.add("hidden");
      await loadGroups();
      renderGroupsList();
      renderNewUserGroups();
    } catch (err) {
      errorEl.textContent = err.message;
    }
  }),
);

// ===========================================
//  SOURCE INPUTS: choose which input (HDMI 1, HDMI 2, USB-C, Auto) an encoder uses
//  Only for sources set up for it in Devices, and only for people in a group with the tick (or admins).
//  It changes what EVERY screen showing that source sees, so each change asks first.
// ===========================================
const inputsBackdrop = $("inputsBackdrop");
const inputMsgs = new Map(); // source ip -> { text, cls } shown under its buttons
let isInputsBusy = false;

function inputLabel(v) {
  return { HDMI1: "HDMI 1", HDMI2: "HDMI 2", AUTO: "Auto" }[v] || v;
}

const inputSources = () => (data ? data.sources.filter((s) => s.canInput) : []);

function updateInputsMenu() {
  $("inputsBtn").classList.toggle("hidden", inputSources().length === 0);
}

function renderInputs() {
  const box = $("inputsList");
  clear(box);
  const list = inputSources();
  if (list.length === 0)
    box.append(el("div", { className: "sub", text: "No sources are set up for input switching." }));
  for (const s of list) {
    const msg = inputMsgs.get(s.ip) || {
      text: s.input ? `Now: ${inputLabel(s.input)}` : "",
      cls: "",
    };
    const buttons = s.inputs.map((v) => {
      const b = el("button", {
        className: "src" + (s.input === v ? " current" : ""),
        text: inputLabel(v),
      });
      b.disabled = isInputsBusy;
      b.addEventListener(
        "click",
        guarded(() => changeInput(s, v)),
      );
      return b;
    });
    box.append(
      el("div", { className: "row input-row" }, [
        el("div", { className: "grow" }, [
          el("div", { text: s.name }),
          el("div", { className: "input-choices" }, buttons),
          el("div", { className: "dev-test " + msg.cls, text: msg.text }),
        ]),
      ]),
    );
  }
}

async function readInputs() {
  for (const s of inputSources()) {
    try {
      const r = await api("/api/source-input", { body: { encoderIp: s.ip } });
      data = r.snapshot;
      inputMsgs.set(s.ip, {
        text: r.input ? `Now: ${inputLabel(r.input)}` : "Could not read the current input",
        cls: r.input ? "" : "bad",
      });
    } catch (err) {
      inputMsgs.set(s.ip, { text: err.message, cls: "bad" });
    }
    if (inputsBackdrop.classList.contains("open")) renderInputs();
  }
}

async function changeInput(s, v) {
  if (
    !window.confirm(
      `This changes what every screen showing ${s.name} sees. Switch ${s.name} to ${inputLabel(v)}?`,
    )
  )
    return;
  isInputsBusy = true;
  inputMsgs.set(s.ip, { text: `Switching to ${inputLabel(v)}...`, cls: "wait" });
  renderInputs();
  try {
    const r = await api("/api/source-input", { body: { encoderIp: s.ip, input: v } });
    data = r.snapshot;
    inputMsgs.set(
      s.ip,
      r.ok
        ? { text: `Now: ${inputLabel(r.input)} (confirmed)`, cls: "ok" }
        : {
            text: `Not confirmed${r.input ? ` (it reports ${inputLabel(r.input)})` : ""}`,
            cls: "bad",
          },
    );
  } catch (err) {
    inputMsgs.set(s.ip, { text: err.message, cls: "bad" });
  }
  isInputsBusy = false;
  renderInputs();
}

$("inputsBtn").addEventListener("click", () => {
  inputMsgs.clear();
  renderInputs();
  inputsBackdrop.classList.add("open");
  fire(readInputs());
});
$("inputsClose").addEventListener("click", () => inputsBackdrop.classList.remove("open"));
inputsBackdrop.addEventListener("click", (ev) => {
  if (ev.target === inputsBackdrop) inputsBackdrop.classList.remove("open");
});

// ===========================================
//  STATUS (admin only): who answers, how fast, which model, what each screen shows
// ===========================================
let hasCheckedStatusOnce = false;

function ago(ms) {
  if (!ms) return "never";
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 5) return "just now";
  if (s < 90) return `${s} s ago`;
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  return `${Math.round(s / 3600)} h ago`;
}

function statusRow(d) {
  const chips = [
    el("span", { className: "chip", text: d.ip }),
    el("span", { className: "chip", text: d.kind === "decoder" ? "Screen" : "Source" }),
  ];
  if (d.model) chips.push(el("span", { className: "chip", text: d.model }));
  if (d.ms !== null && d.ms !== undefined)
    chips.push(el("span", { className: "chip ok", text: `${d.ms} ms` }));
  if (d.reachable === false)
    chips.push(el("span", { className: "chip disabled", text: "No answer" }));
  const lines = [el("div", { text: d.name }), el("div", {}, chips)];
  const detail = [];
  if (d.kind === "decoder") {
    if (d.space) detail.push(d.space);
    detail.push(d.source ? `Showing ${d.source}` : "Source unknown");
  }
  detail.push(`last answered ${ago(d.lastReply)}`);
  lines.push(el("div", { className: "sub", text: detail.join(" · ") }));
  return el("div", { className: "row" }, [el("div", { className: "grow" }, lines)]);
}

function renderStatus(rep) {
  const s = rep.summary;
  if (s.total === 0) {
    $("statusSummary").classList.remove("bad");
    $("statusSummary").textContent = "Nothing to show yet";
    $("statusWhen").textContent =
      "You don't manage any groups with screens yet. An administrator can name you as a group manager in Groups.";
    clear($("statusList"));
    return;
  }
  $("statusSummary").textContent =
    `${s.answering} of ${s.total} answering` +
    (s.notAnswering ? `, ${s.notAnswering} not answering` : "") +
    (s.unknown ? `, ${s.unknown} not checked yet` : "");
  $("statusSummary").classList.toggle("bad", Boolean(s.notAnswering));
  $("statusWhen").textContent = rep.checkedAt
    ? `Last full check ${ago(rep.checkedAt)}`
    : "No full check yet";
  const box = $("statusList");
  clear(box);
  const groups = [
    ["Not answering", rep.devices.filter((d) => d.reachable === false)],
    ["Not checked yet", rep.devices.filter((d) => d.reachable === null)],
    ["Answering", rep.devices.filter((d) => d.reachable === true)],
  ];
  for (const [title, list] of groups) {
    if (list.length === 0) continue;
    box.append(el("div", { className: "space-head", text: `${title} (${list.length})` }));
    for (const d of list) box.append(statusRow(d));
  }
}

async function runStatusCheck() {
  const btn = $("statusCheckBtn");
  btn.disabled = true;
  btn.textContent = "Checking...";
  try {
    renderStatus(await api("/api/admin/health/check", { method: "POST" }));
    hasCheckedStatusOnce = true;
    data = await api("/api/devices"); // the check also refreshed what the tiles know
    renderTiles();
  } catch (err) {
    $("statusSummary").textContent = err.message;
    $("statusSummary").classList.add("bad");
  }
  btn.disabled = false;
  btn.textContent = "Check all now";
}

// Shows what is known right away, and runs a full check the first time the tab is opened.
async function loadStatus() {
  try {
    const rep = await api("/api/admin/health");
    renderStatus(rep);
    if (!rep.checkedAt && !hasCheckedStatusOnce && rep.summary.total > 0) fire(runStatusCheck());
  } catch (err) {
    $("statusSummary").textContent = err.message;
  }
}

$("statusCheckBtn").addEventListener("click", guarded(runStatusCheck));

// ===========================================
//  DEVICES (admin only): screens, sources, spaces, backup
//  Everything is saved by the server, which also updates groups and keeps a snapshot for restore.
// ===========================================
let devs = null; // GET /api/admin/devices
let renamingSpace = null; // space whose name is being edited in the Spaces list
let pasteKind = null; // "decoders" | "encoders" while the paste form is open

function devNote(text, bad) {
  const n = $("devNote");
  n.textContent = text || "";
  n.className = "dev-note" + (bad ? " bad" : "") + (text ? "" : " hidden");
}

// Messages for the Backup tab (restore, replace from a file): same look as devNote, scrolled into view.
function backupNote(text, bad) {
  const n = $("backupNote");
  n.textContent = text || "";
  n.className = "dev-note" + (bad ? " bad" : "") + (text ? "" : " hidden");
  if (text) n.scrollIntoView({ block: "nearest" });
}

async function loadDevices() {
  devs = await api("/api/admin/devices");
  renderDevices();
}

// After any change: reload the list, then refresh what the rest of the app shows from it.
async function devicesChanged(r, message, noteFn = devNote) {
  await loadDevices();
  data = await api("/api/devices");
  spacesDirectory = await api("/api/admin/spaces");
  renderTiles();
  const n = r && r.groupsUpdated;
  noteFn(
    (message || "Saved.") + (n ? ` ${n} group${n === 1 ? "" : "s"} updated to match.` : ""),
    false,
  );
}

const DEV_SUB_PANELS = { screens: "devScreens", sources: "devSources", spaces: "devSpaces" };

function selectDevSub(sub) {
  document
    .querySelectorAll("#devSubTabs button")
    .forEach((b) => b.classList.toggle("active", b.dataset.sub === sub));
  for (const [name, id] of Object.entries(DEV_SUB_PANELS))
    $(id).classList.toggle("active", name === sub);
  for (const id of ["screenForm", "sourceForm", "pasteForm", "spaceForm"])
    $(id).classList.add("hidden");
  renamingSpace = null;
  devNote("");
  if (devs) renderDevices();
}

document
  .querySelectorAll("#devSubTabs button")
  .forEach((b) => b.addEventListener("click", () => selectDevSub(b.dataset.sub)));

function renderDevices() {
  renderScreensList();
  renderSourcesList();
  renderSpacesList();
  renderBackup();
  fillSpaceSelect($("sfSpace").value);
}

// Space picker for the screen form: a real dropdown of the existing spaces plus "New space...".
const NEW_SPACE = "__new__";

function fillSpaceSelect(selected) {
  const sel = $("sfSpace");
  clear(sel);
  for (const s of devs.spaces) sel.append(new Option(s, s));
  sel.append(new Option("+ New space...", NEW_SPACE));
  sel.value = [...sel.options].some((o) => o.value === selected) ? selected : sel.options[0].value;
  $("sfSpaceNew").classList.toggle("hidden", sel.value !== NEW_SPACE);
}

// What the form should save as the space name.
function chosenSpace() {
  return $("sfSpace").value === NEW_SPACE ? $("sfSpaceNew").value.trim() : $("sfSpace").value;
}

// Read-only reachability check (UDP query, plus the TV's serial link when asked). Never changes anything.
async function runDeviceTest(ip, tv, tvSetId, into) {
  into.className = "dev-test wait";
  into.textContent = "Testing...";
  try {
    const r = await api("/api/admin/devices/test", { body: { ip, tv, tvSetId } });
    const parts = [r.reachable ? `Answers (${r.ms} ms)` : "No answer from the device"];
    if (r.tv) parts.push(r.tv.ok ? `TV is ${r.tv.on ? "on" : "off"}` : `TV: ${r.tv.error}`);
    const bad = !r.reachable || (r.tv && !r.tv.ok);
    into.className = "dev-test " + (bad ? "bad" : "ok");
    into.textContent = parts.join(" · ");
  } catch (err) {
    into.className = "dev-test bad";
    into.textContent = err.message;
  }
}

async function deleteDevice(kind, d, noun) {
  if (
    !window.confirm(
      `Delete ${noun} "${d.name}" (${d.ip})? It is also removed from every group. You can bring it back from Backup.`,
    )
  )
    return;
  try {
    const r = await api(`/api/admin/devices/${kind}/${encodeURIComponent(d.ip)}`, {
      method: "DELETE",
    });
    await devicesChanged(r, `Deleted ${d.name}.`);
  } catch (err) {
    devNote(err.message, true);
  }
}

// ----- screens -----
function screenRow(d) {
  const chips = [el("span", { className: "chip", text: d.ip })];
  if (d.tvPower)
    chips.push(
      el("span", {
        className: "chip role-admin",
        text: "TV power" + (d.tvSetId ? ` (ID ${d.tvSetId})` : ""),
      }),
    );
  const result = el("span", { className: "dev-test" });
  const testBtn = el("button", { text: "Test" });
  testBtn.addEventListener(
    "click",
    guarded(async () => {
      testBtn.disabled = true;
      await runDeviceTest(d.ip, !!d.tvPower, d.tvSetId, result);
      testBtn.disabled = false;
    }),
  );
  const editBtn = el("button", { text: "Edit" });
  editBtn.addEventListener("click", () => openScreenForm(d));
  const delBtn = el("button", { className: "danger", text: "Delete" });
  delBtn.addEventListener(
    "click",
    guarded(() => deleteDevice("decoders", d, "screen")),
  );
  return el("div", { className: "row" }, [
    el("div", { className: "grow" }, [el("div", { text: d.name }), el("div", {}, chips), result]),
    editBtn,
    testBtn,
    delBtn,
  ]);
}

function renderScreensList() {
  const box = $("screensList");
  clear(box);
  const q = $("screenFilter").value.trim().toLowerCase();
  const bySpace = new Map();
  for (const d of devs.decoders) {
    if (q && ![d.name, d.space, d.ip].join(" ").toLowerCase().includes(q)) continue;
    if (!bySpace.has(d.space)) bySpace.set(d.space, []);
    bySpace.get(d.space).push(d);
  }
  if (bySpace.size === 0) {
    box.append(
      el("div", {
        className: "sub",
        text: devs.decoders.length ? "No screens match." : "No screens yet. Add one above.",
      }),
    );
    return;
  }
  for (const [space, list] of bySpace) {
    box.append(el("div", { className: "space-head", text: `${space} (${list.length})` }));
    for (const d of list) box.append(screenRow(d));
  }
}

$("screenFilter").addEventListener("input", () => devs && renderScreensList());

function openScreenForm(d) {
  $("pasteForm").classList.add("hidden");
  $("sfOrig").value = d ? d.ip : "";
  $("sfName").value = d ? d.name : "";
  $("sfSpaceNew").value = "";
  fillSpaceSelect(d ? d.space : "");
  $("sfIp").value = d ? d.ip : "";
  $("sfTv").value = d && d.tvPower ? d.tvPower : "";
  $("sfSetId").value = d && d.tvSetId ? d.tvSetId : "";
  $("sfSetIdField").classList.toggle("hidden", !$("sfTv").value);
  $("sfError").textContent = "";
  $("sfTest").textContent = "";
  $("sfTest").className = "dev-test";
  $("sfSave").textContent = d ? "Save changes" : "Add screen";
  $("screenForm").classList.remove("hidden");
  $("sfName").focus();
}

$("addScreenBtn").addEventListener("click", () => openScreenForm(null));
$("sfSpace").addEventListener("change", () => {
  const isNew = $("sfSpace").value === NEW_SPACE;
  $("sfSpaceNew").classList.toggle("hidden", !isNew);
  if (isNew) $("sfSpaceNew").focus();
});
$("sfCancel").addEventListener("click", () => $("screenForm").classList.add("hidden"));
$("sfTv").addEventListener("change", () =>
  $("sfSetIdField").classList.toggle("hidden", !$("sfTv").value),
);
$("sfTestBtn").addEventListener(
  "click",
  guarded(() =>
    runDeviceTest(
      $("sfIp").value.trim(),
      !!$("sfTv").value,
      $("sfSetId").value.trim(),
      $("sfTest"),
    ),
  ),
);
$("sfSave").addEventListener(
  "click",
  guarded(async () => {
    $("sfError").textContent = "";
    const orig = $("sfOrig").value;
    const body = {
      name: $("sfName").value,
      space: chosenSpace(),
      ip: $("sfIp").value.trim(),
      tvPower: $("sfTv").value,
      tvSetId: $("sfTv").value ? $("sfSetId").value.trim() : "",
    };
    try {
      const r = orig
        ? await api(`/api/admin/devices/decoders/${encodeURIComponent(orig)}`, {
            method: "PATCH",
            body,
          })
        : await api("/api/admin/devices/decoders", { body });
      $("screenForm").classList.add("hidden");
      await devicesChanged(r, `Saved ${body.name.trim()}.`);
    } catch (err) {
      $("sfError").textContent = err.message;
    }
  }),
);

// ----- sources -----
function sourceRow(s) {
  const result = el("span", { className: "dev-test" });
  const testBtn = el("button", { text: "Test" });
  testBtn.addEventListener(
    "click",
    guarded(async () => {
      testBtn.disabled = true;
      await runDeviceTest(s.ip, false, "", result);
      testBtn.disabled = false;
    }),
  );
  const editBtn = el("button", { text: "Edit" });
  editBtn.addEventListener("click", () => openSourceForm(s));
  const delBtn = el("button", { className: "danger", text: "Delete" });
  delBtn.addEventListener(
    "click",
    guarded(() => deleteDevice("encoders", s, "source")),
  );
  const chips = [el("span", { className: "chip", text: s.ip })];
  if (s.space) chips.push(el("span", { className: "chip role-admin", text: `Local to ${s.space}` }));
  if (s.inputs && s.inputs.length)
    chips.push(
      el("span", {
        className: "chip role-admin",
        text: "Inputs: " + s.inputs.map(inputLabel).join(", "),
      }),
    );
  return el("div", { className: "row" }, [
    el("div", { className: "grow" }, [el("div", { text: s.name }), el("div", {}, chips), result]),
    editBtn,
    testBtn,
    delBtn,
  ]);
}

function renderSourcesList() {
  const box = $("sourcesList");
  clear(box);
  if (devs.encoders.length === 0)
    box.append(el("div", { className: "sub", text: "No sources yet. Add one above." }));
  for (const s of devs.encoders) box.append(sourceRow(s));
}

// "Local to space" dropdown on the source form: blank = a shared source.
function fillSourceSpaceSelect(selected) {
  const sel = $("srSpace");
  clear(sel);
  sel.append(new Option("Shared — all spaces", ""));
  for (const s of devs.spaces) sel.append(new Option(s, s));
  sel.value = selected && devs.spaces.includes(selected) ? selected : "";
}

function openSourceForm(s) {
  $("pasteForm").classList.add("hidden");
  $("srOrig").value = s ? s.ip : "";
  $("srName").value = s ? s.name : "";
  $("srIp").value = s ? s.ip : "";
  fillSourceSpaceSelect(s && s.space);
  $("srInputs")
    .querySelectorAll("input")
    .forEach((cb) => (cb.checked = !!(s && s.inputs && s.inputs.includes(cb.value))));
  $("srError").textContent = "";
  $("srTest").textContent = "";
  $("srTest").className = "dev-test";
  $("srSave").textContent = s ? "Save changes" : "Add source";
  $("sourceForm").classList.remove("hidden");
  $("srName").focus();
}

$("addSourceBtn").addEventListener("click", () => openSourceForm(null));
$("srCancel").addEventListener("click", () => $("sourceForm").classList.add("hidden"));
$("srTestBtn").addEventListener(
  "click",
  guarded(() => runDeviceTest($("srIp").value.trim(), false, "", $("srTest"))),
);
$("srSave").addEventListener(
  "click",
  guarded(async () => {
    $("srError").textContent = "";
    const orig = $("srOrig").value;
    const body = {
      name: $("srName").value,
      ip: $("srIp").value.trim(),
      space: $("srSpace").value,
      inputs: [...$("srInputs").querySelectorAll("input:checked")].map((cb) => cb.value),
    };
    try {
      const r = orig
        ? await api(`/api/admin/devices/encoders/${encodeURIComponent(orig)}`, {
            method: "PATCH",
            body,
          })
        : await api("/api/admin/devices/encoders", { body });
      $("sourceForm").classList.add("hidden");
      await devicesChanged(r, `Saved ${body.name.trim()}.`);
    } catch (err) {
      $("srError").textContent = err.message;
    }
  }),
);

// ----- paste a list -----
function openPaste(kind) {
  pasteKind = kind;
  $("screenForm").classList.add("hidden");
  $("sourceForm").classList.add("hidden");
  $("pasteHelp").textContent =
    kind === "decoders"
      ? 'One screen per line: name, space, IP address, TV power (lg, or leave blank). Paste straight from a spreadsheet (tab-separated) or use commas. A first line starting with "name" is skipped.'
      : 'One source per line: name, IP address. Paste straight from a spreadsheet (tab-separated) or use commas. A first line starting with "name" is skipped.';
  $("pasteText").value = "";
  clear($("pasteResult"));
  $("pasteForm").classList.remove("hidden");
  $("pasteText").focus();
}

$("pasteScreensBtn").addEventListener("click", () => openPaste("decoders"));
$("pasteSourcesBtn").addEventListener("click", () => openPaste("encoders"));
$("pasteCancel").addEventListener("click", () => $("pasteForm").classList.add("hidden"));

async function runPaste(dryRun) {
  const box = $("pasteResult");
  clear(box);
  try {
    const r = await api("/api/admin/devices/import", {
      body: { kind: pasteKind, text: $("pasteText").value, dryRun },
    });
    if (!r.ok) {
      box.append(
        el("div", {
          className: "bad",
          text: `${r.errors.length} problem${r.errors.length === 1 ? "" : "s"} found. Nothing was added.`,
        }),
      );
      for (const e of r.errors) box.append(el("div", { className: "bad", text: e }));
      return;
    }
    if (dryRun) {
      box.append(
        el("div", {
          className: "ok",
          text: `${r.rows.length} look good: ${r.rows.map((d) => d.name).join(", ")}. Press "Add them" to save.`,
        }),
      );
      return;
    }
    $("pasteForm").classList.add("hidden");
    await devicesChanged(r, `Added ${r.added}.`);
  } catch (err) {
    box.append(el("div", { className: "bad", text: err.message }));
  }
}

$("pasteCheck").addEventListener(
  "click",
  guarded(() => runPaste(true)),
);
$("pasteAdd").addEventListener(
  "click",
  guarded(() => runPaste(false)),
);

// ----- spaces -----
function renderSpacesList() {
  const box = $("spacesList");
  clear(box);
  const counts = new Map(devs.spaces.map((s) => [s, 0]));
  for (const d of devs.decoders) counts.set(d.space, (counts.get(d.space) || 0) + 1);
  if (counts.size === 0)
    box.append(el("div", { className: "sub", text: "No spaces yet. Add one above." }));
  for (const [space, n] of counts) {
    const row = el("div", { className: "row" });
    if (renamingSpace === space) {
      const input = el("input", { type: "text", value: space, "aria-label": "New space name" });
      input.value = space;
      const save = el("button", { className: "primary", text: "Save" });
      const cancel = el("button", { text: "Cancel" });
      const doRename = async () => {
        try {
          const r = await api("/api/admin/devices/spaces/rename", {
            body: { from: space, to: input.value },
          });
          renamingSpace = null;
          await devicesChanged(r, `Renamed ${space} to ${input.value.trim()}.`);
        } catch (err) {
          devNote(err.message, true);
        }
      };
      save.addEventListener("click", guarded(doRename));
      input.addEventListener(
        "keydown",
        guarded((ev) => ev.key === "Enter" && doRename()),
      );
      cancel.addEventListener("click", () => {
        renamingSpace = null;
        renderSpacesList();
      });
      row.append(el("div", { className: "grow" }, [input]), save, cancel);
    } else {
      const rename = el("button", { text: "Rename" });
      rename.addEventListener("click", () => {
        renamingSpace = space;
        renderSpacesList();
      });
      const kids = [
        el("div", { text: space }),
        el("div", {
          className: "sub",
          text: n === 0 ? "No screens yet" : `${n} screen${n === 1 ? "" : "s"}`,
        }),
      ];
      row.append(el("div", { className: "grow" }, kids), rename);
      if (n === 0) {
        const del = el("button", { className: "danger", text: "Delete" });
        del.addEventListener(
          "click",
          guarded(async () => {
            if (
              !window.confirm(
                `Delete the empty space "${space}"? It is also removed from every group that lists it. You can bring it back from Backup.`,
              )
            )
              return;
            try {
              const r = await api(`/api/admin/devices/spaces/${encodeURIComponent(space)}`, {
                method: "DELETE",
              });
              await devicesChanged(r, `Deleted ${space}.`);
            } catch (err) {
              devNote(err.message, true);
            }
          }),
        );
        row.append(del);
      }
    }
    box.append(row);
  }
}

// ----- add a space -----
$("addSpaceBtn").addEventListener("click", () => {
  $("spName").value = "";
  $("spError").textContent = "";
  $("spaceForm").classList.remove("hidden");
  $("spName").focus();
});
$("spCancel").addEventListener("click", () => $("spaceForm").classList.add("hidden"));

async function saveNewSpace() {
  $("spError").textContent = "";
  const name = $("spName").value.trim();
  try {
    const r = await api("/api/admin/devices/spaces", { body: { name } });
    $("spaceForm").classList.add("hidden");
    await devicesChanged(r, `Added ${name}.`);
  } catch (err) {
    $("spError").textContent = err.message;
  }
}

$("spSave").addEventListener("click", guarded(saveNewSpace));
$("spName").addEventListener(
  "keydown",
  guarded((ev) => ev.key === "Enter" && saveNewSpace()),
);

// ----- backup / history -----
function renderBackup() {
  $("devSourceNote").textContent =
    devs.source === "imported"
      ? "This list was imported from the devices.json file next to the app when it first started. From now on it lives in the app's data folder and is edited here."
      : "The list lives in the app's data folder. The devices.json file next to the app is only used the first time the app starts.";
  const keepSel = $("historyKeep");
  clear(keepSel);
  for (const n of devs.historyChoices || [])
    keepSel.append(new Option(`The last ${n} changes`, String(n), false, n === devs.historyKeep));
  const box = $("historyList");
  clear(box);
  if (devs.history.length === 0)
    box.append(el("div", { className: "sub", text: "No changes yet." }));
  for (const h of devs.history) {
    const restore = el("button", { text: "Restore" });
    restore.addEventListener(
      "click",
      guarded(async () => {
        if (
          !window.confirm(
            `Put the screens and sources back as they were before "${h.reason}"? The current list is saved first, so this can be undone.`,
          )
        )
          return;
        try {
          const r = await api("/api/admin/devices/restore", { body: { at: h.at } });
          await devicesChanged(r, "Restored.", backupNote);
        } catch (err) {
          backupNote(err.message, true);
        }
      }),
    );
    box.append(
      el("div", { className: "row" }, [
        el("div", { className: "grow" }, [
          el("div", { text: `Before: ${h.reason}` }),
          el("div", {
            className: "sub",
            text: `${new Date(h.at).toLocaleString()} · ${h.by} · ${h.screens} screens, ${h.sources} sources`,
          }),
        ]),
        restore,
      ]),
    );
  }
}

$("historyKeep").addEventListener(
  "change",
  guarded(async () => {
    const keep = Number($("historyKeep").value);
    const dropping = Math.max(0, devs.history.length - keep);
    if (
      dropping &&
      !window.confirm(
        `Keeping only the last ${keep} changes removes the ${dropping} oldest saved version${dropping === 1 ? "" : "s"} now. Continue?`,
      )
    ) {
      $("historyKeep").value = String(devs.historyKeep);
      return;
    }
    try {
      await api("/api/admin/devices/history-limit", { body: { keep } });
      await loadDevices();
      backupNote(`Keeping the last ${keep} changes.`, false);
    } catch (err) {
      $("historyKeep").value = String(devs.historyKeep);
      backupNote(err.message, true);
    }
  }),
);

// Restore the list from a devices.json file chosen on this computer: check it first, then replace.
let devFileText = null; // the text of the file that passed "Check file"

function devFileForget() {
  devFileText = null;
  $("reimportBtn").disabled = true;
  clear($("devFileResult"));
}
$("devFile").addEventListener("change", devFileForget);

$("devFileCheckBtn").addEventListener(
  "click",
  guarded(async () => {
    devFileForget();
    backupNote("");
    const box = $("devFileResult");
    try {
      const f = $("devFile").files[0];
      if (!f) throw new Error("Choose a devices.json file first.");
      if (f.size > 2000000) throw new Error("That file is too large to be a device list.");
      const text = await f.text();
      const r = await api("/api/admin/devices/import-file", { body: { text, dryRun: true } });
      devFileText = text;
      const line = (s) => box.append(el("div", { className: "sec-fact", text: s }));
      box.append(
        el("div", {
          className: "dev-note",
          text: "This file is a usable device list. Replacing the list would give you:",
        }),
      );
      line(
        `${r.screens} screen${r.screens === 1 ? "" : "s"} (${r.screensAdded} new, ${r.screensRemoved} no longer there), ${r.sources} source${r.sources === 1 ? "" : "s"} (${r.sourcesAdded} new, ${r.sourcesRemoved} no longer there), ${r.spaces} space${r.spaces === 1 ? "" : "s"}.`,
      );
      if (r.groupSettingsMissing) {
        box.append(
          el("div", {
            className: "dev-note bad",
            text: `${r.groupSettingsMissing} group setting${r.groupSettingsMissing === 1 ? "" : "s"} point at a screen or source that is not in this file. They simply stop matching anything; nothing in the groups is deleted.`,
          }),
        );
      }
      line("The current list is saved first, so this can be undone with Restore below.");
      $("reimportBtn").disabled = false;
    } catch (err) {
      box.append(el("div", { className: "dev-note bad", text: err.message }));
    }
  }),
);

$("reimportBtn").addEventListener(
  "click",
  guarded(async () => {
    if (!devFileText) return;
    if (
      !window.confirm(
        "Replace the whole screens and sources list with this file? The current list is saved first, so this can be undone.",
      )
    )
      return;
    try {
      const r = await api("/api/admin/devices/import-file", { body: { text: devFileText } });
      $("devFile").value = "";
      devFileForget();
      await devicesChanged(r, "Restored the list from the file.", backupNote);
    } catch (err) {
      backupNote(err.message, true);
    }
  }),
);

// --- branding panel: name, logo, colour (admin only) ---
let brandLogoData = null; // base64 of a logo chosen in this form, not saved yet
let brandState = null; // what the server has saved

function brandNote(text, bad) {
  const n = $("brandNote");
  n.textContent = text || "";
  n.className = "dev-note" + (bad ? " bad" : "") + (text ? "" : " hidden");
}

function brandShowPreview() {
  $("brandPreview").style.background = /^#[0-9a-fA-F]{6}$/.test($("brandAccentHex").value)
    ? $("brandAccentHex").value
    : "";
  $("brandPreviewName").textContent = $("brandAppName").value;
  $("brandPreviewSelect").style.background = /^#[0-9a-fA-F]{6}$/.test($("brandSelectHex").value)
    ? $("brandSelectHex").value
    : "";
}

async function loadBrandingForm() {
  brandNote("");
  try {
    brandState = await api("/api/admin/branding");
    $("brandAppName").value = brandState.appName;
    $("brandOrgName").value = brandState.orgName;
    $("brandAccent").value = brandState.accent;
    $("brandAccentHex").value = brandState.accent;
    $("brandSelect").value = brandState.select;
    $("brandSelectHex").value = brandState.select;
    $("brandPreviewLogo").src = brandState.logoUrl;
    $("brandLogoFile").value = "";
    brandLogoData = null;
    $("brandRemoveLogoBtn").classList.toggle("hidden", !brandState.hasLogo);
    brandShowPreview();
  } catch (err) {
    brandNote(err.message, true);
  }
}

$("brandAppName").addEventListener("input", brandShowPreview);
$("brandAccent").addEventListener("input", () => {
  $("brandAccentHex").value = $("brandAccent").value;
  brandShowPreview();
});
$("brandAccentHex").addEventListener("input", () => {
  const v = $("brandAccentHex").value.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(v)) $("brandAccent").value = v.toLowerCase();
  brandShowPreview();
});

$("brandSelect").addEventListener("input", () => {
  $("brandSelectHex").value = $("brandSelect").value;
  brandShowPreview();
});
$("brandSelectHex").addEventListener("input", () => {
  const v = $("brandSelectHex").value.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(v)) $("brandSelect").value = v.toLowerCase();
  brandShowPreview();
});

function toBase64(buf) {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

$("brandLogoFile").addEventListener(
  "change",
  guarded(async () => {
    brandNote("");
    brandLogoData = null;
    const f = $("brandLogoFile").files[0];
    if (!f) return;
    if (f.size > 512 * 1024) {
      $("brandLogoFile").value = "";
      return brandNote("That file is too large. The limit is 512 KB.", true);
    }
    brandLogoData = toBase64(await f.arrayBuffer());
    $("brandPreviewLogo").src = URL.createObjectURL(f);
  }),
);

async function saveBranding(extra) {
  brandNote("");
  try {
    await api("/api/admin/branding", {
      body: {
        appName: $("brandAppName").value,
        orgName: $("brandOrgName").value,
        accent: $("brandAccentHex").value.trim(),
        select: $("brandSelectHex").value.trim(),
        logo: brandLogoData ? { data: brandLogoData } : undefined,
        ...extra,
      },
    });
    brandNote("Saved. Reloading the page...");
    setTimeout(() => window.location.reload(), 700);
  } catch (err) {
    brandNote(err.message, true);
  }
}

$("brandSaveBtn").addEventListener(
  "click",
  guarded(() => saveBranding({})),
);
$("brandRemoveLogoBtn").addEventListener("click", () => {
  if (window.confirm("Remove the logo? The built-in logo is shown instead."))
    fire(saveBranding({ removeLogo: true }));
});
$("brandResetBtn").addEventListener(
  "click",
  guarded(async () => {
    if (!window.confirm("Put the name, logo and colour back to the defaults?")) return;
    try {
      await api("/api/admin/branding/reset", { body: {} });
      brandNote("Reset. Reloading the page...");
      setTimeout(() => window.location.reload(), 700);
    } catch (err) {
      brandNote(err.message, true);
    }
  }),
);

// --- security panel: HTTPS certificate (admin only) ---
let secChecked = null; // the files + password that passed "Check files", ready to install

function secNote(text, bad) {
  const n = $("secNote");
  n.textContent = text || "";
  n.className = "dev-note" + (bad ? " bad" : "") + (text ? "" : " hidden");
}

function secFact(label, value) {
  return el("div", { className: "sec-fact" }, [
    el("strong", { text: label + ": " }),
    document.createTextNode(value),
  ]);
}

function certFacts(c) {
  const when = c.validTo ? new Date(c.validTo).toLocaleDateString() : "unknown";
  const left =
    typeof c.daysLeft === "number"
      ? ` (${c.daysLeft < 0 ? "expired" : c.daysLeft + " days left"})`
      : "";
  const facts = [];
  if (c.names && c.names.length) facts.push(secFact("Good for", c.names.join(", ")));
  if (c.validTo) facts.push(secFact("Expires", when + left));
  if (c.issuer)
    facts.push(
      secFact(
        c.selfSigned ? "Made by" : "Issued by",
        c.selfSigned ? "this app (self-signed)" : c.issuer,
      ),
    );
  if (c.fingerprint) facts.push(secFact("Fingerprint (SHA-256)", c.fingerprint));
  return facts;
}

function renderSecurity(s) {
  const sum = $("secSummary");
  const det = $("secDetails");
  clear(sum);
  clear(det);
  if (!s.enabled) {
    sum.textContent = "HTTPS is off";
    det.append(
      el("div", {
        className: "preview-line",
        text: s.proxied
          ? "A proxy in front of the app (TRUST_PROXY) is expected to handle HTTPS, so there is no certificate to manage here."
          : "HTTPS was switched off for this server (TLS=off), so passwords travel unencrypted. Remove that setting and restart to turn it back on.",
      }),
    );
    $("secUpload").classList.add("hidden");
    $("secDownload").classList.add("hidden");
    $("secDownloadHelp").classList.add("hidden");
    $("secResetBtn").classList.add("hidden");
    return;
  }
  sum.textContent =
    s.kind === "uploaded"
      ? "Encrypted with the certificate you uploaded"
      : s.kind === "server-settings"
        ? "Encrypted with the certificate from the server's settings"
        : "Encrypted with a self-signed certificate (browsers show a warning)";
  certFacts(s).forEach((f) => det.append(f));
  if (s.expired)
    det.append(
      el("div", {
        className: "dev-note bad",
        text: "This certificate has expired. Upload a new one.",
      }),
    );
  else if (typeof s.daysLeft === "number" && s.daysLeft <= 30 && !s.selfSigned) {
    det.append(
      el("div", {
        className: "dev-note bad",
        text: `This certificate expires in ${s.daysLeft} days.`,
      }),
    );
  }
  if (s.coversThisAddress === false) {
    det.append(
      el("div", {
        className: "dev-note bad",
        text: `This certificate does not list the address you are using now (${s.address}), so browsers will warn. Open the app by one of the names above, or upload a certificate that includes this address.`,
      }),
    );
  }
  if (s.fallbackReason) {
    det.append(
      el("div", {
        className: "dev-note bad",
        text: `The certificate that was set up could not be used, so a fallback is in use: ${s.fallbackReason}`,
      }),
    );
  }
  if (s.lockedBySettings) {
    det.append(
      el("div", {
        className: "preview-line",
        text: "This certificate is set in the server's own settings (TLS_CERT / TLS_KEY / TLS_PFX), which take priority. To manage it here instead, remove those settings and restart.",
      }),
    );
  }
  $("secUpload").classList.toggle("hidden", Boolean(s.lockedBySettings));
  $("secDownload").classList.toggle("hidden", !s.canDownload);
  $("secDownloadHelp").classList.toggle("hidden", !s.canDownload || !s.selfSigned);
  $("secResetBtn").classList.toggle("hidden", !s.hasUploaded || Boolean(s.lockedBySettings));
}

async function loadSecurity() {
  secNote("");
  try {
    renderSecurity(await api("/api/admin/tls"));
  } catch (err) {
    secNote(err.message, true);
  }
}

function secForgetCheck() {
  secChecked = null;
  $("secInstallBtn").disabled = true;
  clear($("secCheckResult"));
}
["secCertFile", "secKeyFile"].forEach((id) => $(id).addEventListener("change", secForgetCheck));
$("secPass").addEventListener("input", secForgetCheck);

$("secCheckBtn").addEventListener(
  "click",
  guarded(async () => {
    secForgetCheck();
    secNote("");
    const box = $("secCheckResult");
    try {
      const cf = $("secCertFile").files[0];
      const kf = $("secKeyFile").files[0];
      if (!cf || !kf) throw new Error("Choose both the certificate file and the key file.");
      if (cf.size > 100000 || kf.size > 20000)
        throw new Error("Those files are too large to be a certificate and key.");
      const body = { cert: await cf.text(), key: await kf.text(), passphrase: $("secPass").value };
      const r = await api("/api/admin/tls/upload", { body: { ...body, dryRun: true } });
      secChecked = body;
      box.append(
        el("div", {
          className: "dev-note",
          text: "These files are a matching certificate and key. Check the details, then install.",
        }),
      );
      certFacts(r).forEach((f) => box.append(f));
      (r.warnings || []).forEach((w) =>
        box.append(el("div", { className: "dev-note bad", text: w })),
      );
      if (r.coversThisAddress === false) {
        box.append(
          el("div", {
            className: "dev-note bad",
            text: `It does not list the address you are using now (${r.address}). Installing it will make browsers warn here until you open the app by one of its names.`,
          }),
        );
      }
      $("secInstallBtn").disabled = false;
    } catch (err) {
      box.append(el("div", { className: "dev-note bad", text: err.message }));
    }
  }),
);

$("secInstallBtn").addEventListener(
  "click",
  guarded(async () => {
    if (!secChecked) return;
    if (
      !window.confirm(
        "Install this certificate now? It takes effect immediately for everyone, with no restart. You can go back to the self-signed one afterwards.",
      )
    )
      return;
    try {
      const r = await api("/api/admin/tls/upload", { body: secChecked });
      secChecked = null;
      $("secCertFile").value = "";
      $("secKeyFile").value = "";
      $("secPass").value = "";
      clear($("secCheckResult"));
      $("secInstallBtn").disabled = true;
      renderSecurity(r);
      secNote("Certificate installed.");
    } catch (err) {
      secNote(err.message, true);
    }
  }),
);

$("secResetBtn").addEventListener(
  "click",
  guarded(async () => {
    if (
      !window.confirm(
        "Go back to the self-signed certificate? Browsers will show their warning again until a real certificate is installed.",
      )
    )
      return;
    try {
      renderSecurity(await api("/api/admin/tls/reset", { body: {} }));
      secNote("Back to the self-signed certificate.");
    } catch (err) {
      secNote(err.message, true);
    }
  }),
);

// --- activity panel (admin only) ---
let activityCache = [];
async function loadActivity() {
  activityCache = await api("/api/admin/activity");
  renderActivity();
}

function entryText(e) {
  const parts = [new Date(e.at).toLocaleString(), e.type];
  if (e.username) parts.push(e.username);
  if (e.by) parts.push("by " + e.by);
  if (e.decoder) parts.push("-> " + e.decoder);
  if (e.encoder) parts.push("source " + e.encoder);
  if (e.action) parts.push("power " + e.action);
  if (e.detail) parts.push(e.detail);
  if (e.result) parts.push("(" + e.result + ")");
  if (e.group) parts.push("group " + e.group);
  return parts.join("  ");
}

function renderActivity() {
  const box = $("activityLog");
  clear(box);
  const filter = $("activityFilter").value.trim().toLowerCase();
  for (const e of activityCache) {
    const text = entryText(e);
    if (filter && !text.toLowerCase().includes(filter)) continue;
    box.append(el("div", { className: "entry", text }));
  }
}
$("activityFilter").addEventListener("input", renderActivity);

// ===========================================
//  BOOT
// ===========================================
async function boot() {
  try {
    me = await api("/api/me");
    await enterApp();
  } catch (err) {
    if (err.status !== 401) logError("Could not start the page", err); // 401 = simply not signed in
    showLogin();
  }
}

fire(boot());
