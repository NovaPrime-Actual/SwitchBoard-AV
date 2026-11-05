// ===========================================
// SPDX-License-Identifier: AGPL-3.0-or-later
// SIGN-IN API for SwitchBoard-AV
// Description: Sign-in, sign-out, password change, and the page's own data (/api/me, /api/about).
// ===========================================

import {
  createSession,
  destroySessionsForUser,
  findUserByUsername,
  hashPassword,
  ipBlocked,
  isLocked,
  parseCookies,
  recordIpFailure,
  recordLoginFailure,
  recordLoginSuccess,
  sessions,
  setSessionCookie,
  throttleKey,
  verifyPassword,
} from "../auth.js";
import { readJsonOrRefuse, reply } from "../http.js";
import { selfView } from "../scoping.js";
import { logActivity, saveStore } from "../store.js";

export async function handleLogin(req, res) {
  const body = await readJsonOrRefuse(req, res);
  if (!body) return;
  const username = String(body.username || "").trim();
  const ip = req.socket.remoteAddress || "unknown";
  const key = throttleKey(username, ip);
  if (isLocked(key) || ipBlocked(ip))
    return reply(res, 429, { error: "Too many attempts. Try again shortly." });

  const user = findUserByUsername(username);
  let ok = false;
  if (user && !user.disabled) ok = await verifyPassword(user, body.password);

  if (!ok) {
    recordLoginFailure(key);
    recordIpFailure(ip);
    logActivity({ type: "login_failed", username: username || "(blank)" });
    return reply(res, 401, { error: "Invalid username or password" });
  }
  recordLoginSuccess(key);
  // signing in starts a fresh session; a session cookie the browser already had is ended, not reused
  const oldToken = parseCookies(req).sid;
  if (oldToken) sessions.delete(oldToken);
  const token = createSession(user.id);
  setSessionCookie(req, res, token);
  logActivity({ type: "login", username: user.username });
  return reply(res, 200, selfView(user));
}

export async function handleChangePassword(req, res, user) {
  const body = await readJsonOrRefuse(req, res);
  if (!body) return;
  const current = String(body.currentPassword || "");
  const next = String(body.newPassword || "");
  const ok = await verifyPassword(user, current);
  if (!ok) return reply(res, 401, { error: "Current password is incorrect" });
  const problem = passwordProblem(next, user, current);
  if (problem) return reply(res, 400, { error: problem });
  const { salt, hash } = await hashPassword(next);
  user.passwordSalt = salt;
  user.passwordHash = hash;
  user.mustChangePassword = false;
  saveStore();
  // a changed password signs this person out everywhere else (someone else may have had their old one)
  destroySessionsForUser(user.id, parseCookies(req).sid);
  logActivity({ type: "password_change", username: user.username });
  return reply(res, 200, { ok: true });
}

// Rules for a new password, in plain words. Short enough to type on a phone, but not easily guessed: at least
// 8 characters with some letters and at least one number or special character (a space counts), and not an
// obvious one.
const MIN_PASSWORD_LENGTH = 8;

const MAX_PASSWORD_LENGTH = 200;

const COMMON_PASSWORDS = new Set(
  [
    "password",
    "password1",
    "password2",
    "password12",
    "password123",
    "password1234",
    "password12345",
    "passw0rd",
    "passw0rd123",
    "p@ssw0rd",
    "p@ssword123",
    "12345678",
    "123456789",
    "1234567890",
    "12345678910",
    "123456789012",
    "0123456789",
    "0987654321",
    "1q2w3e4r",
    "1q2w3e4r5t",
    "1qaz2wsx",
    "1qaz2wsx3edc",
    "zaq12wsx",
    "qwerty123",
    "qwerty12",
    "qwertyui",
    "qwertyuiop",
    "qwerty1234",
    "qwerty12345",
    "qwerty123456",
    "asdf1234",
    "asdfghjk",
    "asdfghjkl1",
    "asdfghjkl123",
    "zxcvbnm123",
    "abc12345",
    "abcd1234",
    "abc1234567",
    "abcd123456",
    "iloveyou",
    "iloveyou1",
    "iloveyou12",
    "iloveyou123",
    "letmein1",
    "letmein123",
    "letmein1234",
    "welcome1",
    "welcome12",
    "welcome123",
    "welcome1234",
    "welcome12345",
    "admin123",
    "admin1234",
    "admin12345",
    "admin123456",
    "administrator",
    "changeme",
    "changeme123",
    "changeme1234",
    "trustno1",
    "trustno1234",
    "monkey123",
    "monkey1234",
    "dragon123",
    "dragon12345",
    "football1",
    "football123",
    "baseball1",
    "baseball123",
    "superman1",
    "superman123",
    "princess1",
    "princess123",
    "sunshine1",
    "sunshine123",
    "master123",
    "master12345",
    "shadow123",
    "shadow12345",
    "michael1",
    "michael123",
    "charlie1",
    "charlie123",
    "school123",
    "school12345",
    "teacher123",
    "teacher1234",
    "student123",
    "student1234",
    "classroom1",
    "classroom123",
    "switchboard",
    "switchboard1",
    "switchboardav",
    "switchboardav1",
  ].map((p) => p.toLowerCase()),
);

function passwordProblem(password, user, current) {
  if (password.length < MIN_PASSWORD_LENGTH)
    return `Choose a longer password: at least ${MIN_PASSWORD_LENGTH} characters.`;
  if (password.length > MAX_PASSWORD_LENGTH)
    return `That password is too long. Use at most ${MAX_PASSWORD_LENGTH} characters.`;
  if (current !== undefined && password === current)
    return "Choose a different password from your current one.";
  if (!/\p{L}/u.test(password)) return "Include some letters as well as numbers or symbols.";
  if (!/[^\p{L}]/u.test(password))
    return "Add at least one number or special character, for example 7, ! or a space.";
  const letters = password.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (
    /^(.)\1+$/.test(letters) ||
    "01234567890123456789".includes(letters) ||
    "abcdefghijklmnopqrstuvwxyz".includes(letters)
  ) {
    return "That password is too easy to guess. Mix words, numbers or symbols that are not in a row.";
  }
  if (COMMON_PASSWORDS.has(password.toLowerCase()) || COMMON_PASSWORDS.has(letters)) {
    return "That password is too common. Choose something that is harder to guess, such as a few unrelated words.";
  }
  if (user) {
    const bare = (s) =>
      String(s || "")
        .toLowerCase()
        .replace(/[^a-z]/g, "");
    const justName = password.toLowerCase().replace(/[^a-z]/g, "");
    if (
      bare(user.username) &&
      (justName === bare(user.username) || justName === bare(user.username).repeat(2))
    ) {
      return "Your password cannot be just your username. Choose something else.";
    }
  }
  return null;
}
