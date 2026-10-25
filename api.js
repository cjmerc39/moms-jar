// The app's only connection to the outside world: the real Supabase project
// from config.js. Keeps this device's sign-in in localStorage and renews it
// before it expires.

import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from './config.js';

const SESSION_KEY = 'jar.session';

function loadSession() {
  try {
    return JSON.parse(localStorage.getItem(SESSION_KEY)) || null;
  } catch {
    return null;
  }
}

function saveSession(s) {
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify({
      access_token: s.access_token,
      refresh_token: s.refresh_token,
      expires_at: s.expires_at || Math.floor(Date.now() / 1000) + (s.expires_in || 3600),
    }));
  } catch {
    // Private browsing: the sign-in lasts until the page closes.
  }
  memory = loadSession() || s;
}

export function signOutHere() {
  try { localStorage.removeItem(SESSION_KEY); } catch {}
  memory = null;
}

let memory = loadSession();
let refreshing = null;

export function hasSession() {
  return !!memory;
}

async function send(path, init = {}) {
  try {
    const r = await fetch(`${SUPABASE_URL}${path}`, init);
    const text = await r.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    return { ok: r.ok, status: r.status, data };
  } catch {
    return { ok: false, status: 0, data: null, offline: true };
  }
}

// A valid access token, renewing it if it's about to expire. Null if signed out.
async function accessToken() {
  if (!memory) return null;
  if (memory.expires_at - 60 > Date.now() / 1000) return memory.access_token;
  if (!refreshing) {
    refreshing = send('/auth/v1/token?grant_type=refresh_token', {
      method: 'POST',
      headers: { apikey: SUPABASE_PUBLISHABLE_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: memory.refresh_token }),
    }).then((r) => {
      if (r.ok && r.data?.access_token) saveSession(r.data);
      else if (!r.offline) signOutHere(); // the sign-in was revoked or expired for good
      refreshing = null;
    });
  }
  await refreshing;
  return memory ? memory.access_token : null;
}

async function call(method, path, body) {
  const token = await accessToken();
  return send(path, {
    method,
    headers: {
      apikey: SUPABASE_PUBLISHABLE_KEY,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

export const select = (table, query = 'select=*') => call('GET', `/rest/v1/${table}?${query}`);
export const insert = (table, row) => call('POST', `/rest/v1/${table}`, row);
export const update = (table, query, patch) => call('PATCH', `/rest/v1/${table}?${query}`, patch);
export const rpc = (fn, args = {}) => call('POST', `/rest/v1/rpc/${fn}`, args);

// The plain-language message from a failed call.
export function problem(r, fallback = 'Something went wrong. Try again.') {
  if (r.offline) return "Can't reach the internet right now. Try again when you have signal.";
  return r.data?.error || r.data?.message || fallback;
}

// Swaps a key or backup code for a sign-in on this device.
// input: { key } or { code }. Returns { ok } or { ok: false, message }.
export async function redeem(input) {
  const swap = await send('/functions/v1/redeem-invite', {
    method: 'POST',
    headers: { apikey: SUPABASE_PUBLISHABLE_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!swap.ok) return { ok: false, message: problem(swap) };
  const verified = await send('/auth/v1/verify', {
    method: 'POST',
    headers: { apikey: SUPABASE_PUBLISHABLE_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: swap.data.type, token_hash: swap.data.token_hash }),
  });
  if (!verified.ok || !verified.data?.access_token) return { ok: false, message: problem(verified) };
  saveSession(verified.data);
  return { ok: true };
}
