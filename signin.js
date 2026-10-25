// Pure helpers for invite links and sign-in. No DOM, no network.
//
// A link looks like '<app url>#k=<key>&c=<code>'. The key is 43 URL-safe
// characters; the backup code is 10 characters from CODE_ALPHABET, shown as
// 'ABCDE-FGHJK'. Both live after the '#', so they're never sent to the web
// server hosting the app.

import { addDays } from './logic.js';

export const CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const KEY_RE = /^[A-Za-z0-9_-]{43}$/;

// Reads '#k=...&c=...' from a URL hash. Missing parts are null.
export function parseLinkHash(hash) {
  const params = new URLSearchParams((hash || '').replace(/^#/, ''));
  const key = params.get('k');
  const code = params.get('c');
  return {
    key: key && KEY_RE.test(key) ? key : null,
    code: code && isCode(code) ? formatCode(code) : null,
  };
}

// Ignores case, spaces and dashes.
export function normalizeCode(text) {
  return String(text || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function isCode(text) {
  const c = normalizeCode(text);
  return c.length === 10 && [...c].every((ch) => CODE_ALPHABET.includes(ch));
}

export function formatCode(text) {
  const c = normalizeCode(text);
  return `${c.slice(0, 5)}-${c.slice(5)}`;
}

// Whatever she pasted or typed: a whole link, just the key, or the backup
// code. Returns { key } or { code }, or null if it's none of those.
export function parseSignInInput(text) {
  const t = String(text || '').trim();
  if (!t) return null;
  if (t.includes('#')) {
    const { key, code } = parseLinkHash(t.slice(t.indexOf('#')));
    if (key) return { key };
    if (code) return { code };
    return null;
  }
  if (KEY_RE.test(t)) return { key: t };
  if (isCode(t)) return { code: formatCode(t) };
  return null;
}

export function buildLink(appUrl, key, code) {
  return `${appUrl.split('#')[0]}#k=${key}&c=${formatCode(code)}`;
}

// iPhone and iPad keep the home screen app's storage separate from Safari,
// so a link opened in Safari can't sign in the installed app. In that case
// the app shows "Copy my key" and Add to Home Screen steps instead.
export function needsInstallFirst(userAgent, standalone, maxTouchPoints = 0) {
  const ua = userAgent || '';
  const iOS = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && maxTouchPoints > 1);
  return iOS && !standalone;
}

function localDate(date, timeZone) {
  // 'en-CA' formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

// For the admin screen: 'Never', 'Just now', 'Today, 9:14 AM',
// 'Yesterday, 9:14 AM', 'Oct 20', or 'Oct 20, 2025' for another year.
export function describeWhen(iso, now = new Date(), timeZone = undefined) {
  if (!iso) return 'Never';
  const when = new Date(iso);
  if (now - when < 2 * 60 * 1000 && now >= when) return 'Just now';
  const day = localDate(when, timeZone);
  const today = localDate(now, timeZone);
  const time = new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: '2-digit' }).format(when);
  if (day === today) return `Today, ${time}`;
  if (day === addDays(today, -1)) return `Yesterday, ${time}`;
  const sameYear = day.slice(0, 4) === today.slice(0, 4);
  return new Intl.DateTimeFormat('en-US', {
    timeZone, month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }),
  }).format(when);
}

// Opens the phone's messaging app with the text filled in.
export function smsLink(body) {
  return `sms:?&body=${encodeURIComponent(body)}`;
}
