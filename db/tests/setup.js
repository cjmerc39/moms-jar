// Test setup for the privacy tests. Talks ONLY to moms-jar-test.
//
// Secrets come from a file outside the repo (default ~/.moms-jar/test.env,
// or the path in MOMS_JAR_TEST_ENV). Nothing here ever prints a secret.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { SUPABASE_URL } from '../../config.js';
import { TEST_PROJECT_REF, TEST_SUPABASE_URL, TEST_SUPABASE_PUBLISHABLE_KEY } from './test-project.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const REAL_REF = new URL(SUPABASE_URL).hostname.split('.')[0];
const TEST_EMAIL_DOMAIN = 'moms-jar.test';

// Dates come back as 'YYYY-MM-DD' strings, not JS Dates (which would drag in time zones).
pg.types.setTypeParser(1082, (v) => v);

export const SECRETS_FILE = process.env.MOMS_JAR_TEST_ENV || path.join(os.homedir(), '.moms-jar', 'test.env');

// Returns { secrets } or { missing: 'reason' }.
export function loadSecrets() {
  if (!fs.existsSync(SECRETS_FILE)) return { missing: `no secrets file at ${SECRETS_FILE}` };
  const vars = {};
  for (const line of fs.readFileSync(SECRETS_FILE, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m) vars[m[1]] = m[2];
  }
  const need = ['TEST_SUPABASE_SECRET_KEY', 'TEST_DATABASE_URL', 'TEST_DATABASE_PASSWORD'];
  const unfilled = need.filter((k) => !vars[k] || vars[k] === 'paste-here');
  if (unfilled.length) return { missing: `fill in ${unfilled.join(', ')} in ${SECRETS_FILE}` };
  return { secrets: vars };
}

// Refuses to go on unless everything points at moms-jar-test.
function checkTargets(secrets) {
  if (TEST_PROJECT_REF === REAL_REF || TEST_SUPABASE_URL === SUPABASE_URL) {
    throw new Error('The test project is set to the real project. Refusing to run.');
  }
  if (!secrets.TEST_SUPABASE_SECRET_KEY.startsWith('sb_secret_')) {
    throw new Error(`TEST_SUPABASE_SECRET_KEY in ${SECRETS_FILE} doesn't look like a secret key (should start with sb_secret_).`);
  }
  const url = secrets.TEST_DATABASE_URL;
  if (!url.includes(TEST_PROJECT_REF) || url.includes(REAL_REF)) {
    throw new Error(`TEST_DATABASE_URL in ${SECRETS_FILE} is not the moms-jar-test database. Refusing to run.`);
  }
  if (!url.includes('[YOUR-PASSWORD]')) {
    throw new Error(`TEST_DATABASE_URL in ${SECRETS_FILE} should be pasted exactly as copied, with [YOUR-PASSWORD] still in it.`);
  }
}

export async function connect(secrets) {
  checkTargets(secrets);
  const admin = adminApi(secrets.TEST_SUPABASE_SECRET_KEY);

  // The secret key must belong to moms-jar-test: the test project's API accepts it.
  const probe = await admin('GET', '/auth/v1/admin/users?page=1&per_page=1');
  if (probe.status !== 200) {
    throw new Error(`moms-jar-test rejected TEST_SUPABASE_SECRET_KEY (status ${probe.status}). Is it the test project's secret key?`);
  }

  const connectionString = secrets.TEST_DATABASE_URL
    .replace('[YOUR-PASSWORD]', encodeURIComponent(secrets.TEST_DATABASE_PASSWORD));
  // The pooler's certificate isn't in Node's default trust store; this is the
  // throwaway test database only.
  const db = new pg.Client({ connectionString, ssl: { rejectUnauthorized: false } });
  try {
    await db.connect();
  } catch (err) {
    throw new Error(`Couldn't connect to the moms-jar-test database: ${err.code || 'error'}. Check the URL and password in ${SECRETS_FILE}.`);
  }
  return { db, admin };
}

function adminApi(secretKey) {
  return async (method, p, body) => {
    const r = await fetch(`${TEST_SUPABASE_URL}${p}`, {
      method,
      headers: { apikey: secretKey, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await r.text();
    let data;
    try { data = JSON.parse(text); } catch { data = text; }
    return { status: r.status, data };
  };
}

// Deletes test accounts and photos, rebuilds the schema from the migrations.
export async function rebuild({ db, admin }) {
  await clearData({ db, admin });
  await db.query(fs.readFileSync(path.join(here, 'reset.sql'), 'utf8'));
  const dir = path.join(here, '..', 'migrations');
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    await db.query(fs.readFileSync(path.join(dir, file), 'utf8'));
  }
  // Wait for the API to notice the new tables.
  for (let i = 0; i < 50; i++) {
    const r = await client(null).select('slips', 'select=id&limit=1');
    if (r.status !== 404 && r.data?.code !== 'PGRST205') return;
    await new Promise((res) => setTimeout(res, 300));
  }
  throw new Error('The API never picked up the new tables.');
}

// Removes test accounts, photos and rows. Leaves the schema in place.
export async function clearData({ db, admin }) {
  const photos = await db.query(`select name from storage.objects where bucket_id = 'photos'`).catch(() => ({ rows: [] }));
  if (photos.rows.length) {
    await admin('DELETE', '/storage/v1/object/photos', { prefixes: photos.rows.map((r) => r.name) });
  }
  for (let page = 1; page < 20; page++) {
    const r = await admin('GET', `/auth/v1/admin/users?page=${page}&per_page=100`);
    const users = r.data?.users || [];
    for (const u of users) {
      if (u.email?.endsWith(`@${TEST_EMAIL_DOMAIN}`)) await admin('DELETE', `/auth/v1/admin/users/${u.id}`);
    }
    if (users.length < 100) break;
  }
  await db.query(`
    do $$ begin
      if to_regclass('public.people') is not null then
        truncate public.mom_marks, public.slips, public.prompts, public.people cascade;
      end if;
    end $$;`);
}

// A signed-in test account.
export async function makeAccount(admin, label) {
  const email = `t-${label}-${crypto.randomUUID().slice(0, 8)}@${TEST_EMAIL_DOMAIN}`;
  const password = crypto.randomBytes(18).toString('base64url');
  const created = await admin('POST', '/auth/v1/admin/users', { email, password, email_confirm: true });
  if (created.status >= 300) throw new Error(`creating a test account failed: ${created.status} ${JSON.stringify(created.data)}`);
  const r = await fetch(`${TEST_SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: TEST_SUPABASE_PUBLISHABLE_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const session = await r.json();
  if (!session.access_token) throw new Error(`signing in a test account failed: ${r.status}`);
  return { userId: created.data.id, token: session.access_token };
}

// Gives an account a person and an active invite, the way step 4's invite links will.
export async function makePerson(db, account, name, role) {
  const person = (await db.query(
    'insert into public.people (name, role) values ($1, $2) returning id', [name, role])).rows[0];
  const invite = (await db.query(
    'insert into private.invites (person_id, token_hash) values ($1, $2) returning id',
    [person.id, crypto.randomBytes(32).toString('hex')])).rows[0];
  if (account) {
    await db.query(
      'insert into private.person_accounts (user_id, person_id, invite_id) values ($1, $2, $3)',
      [account.userId, person.id, invite.id]);
  }
  return { ...account, personId: person.id, inviteId: invite.id };
}

// The API as a given signed-in account (token) or a signed-out visitor (null).
// Uses only the publishable key, exactly like the app or someone with browser tools.
export function client(token) {
  const headers = (extra = {}) => ({
    apikey: TEST_SUPABASE_PUBLISHABLE_KEY,
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...extra,
  });
  async function req(method, p, body, extra = {}) {
    const r = await fetch(`${TEST_SUPABASE_URL}${p}`, {
      method,
      headers: headers({ 'Content-Type': 'application/json', Prefer: 'return=representation', ...extra }),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await r.text();
    let data;
    try { data = JSON.parse(text); } catch { data = text; }
    return { status: r.status, data };
  }
  return {
    select: (table, query = 'select=*', extra) => req('GET', `/rest/v1/${table}?${query}`, undefined, extra),
    insert: (table, row) => req('POST', `/rest/v1/${table}`, row),
    update: (table, query, patch) => req('PATCH', `/rest/v1/${table}?${query}`, patch),
    remove: (table, query) => req('DELETE', `/rest/v1/${table}?${query}`),
    rpc: (fn, args = {}) => req('POST', `/rest/v1/rpc/${fn}`, args),
    async upload(objectPath, bytes, type = 'image/jpeg') {
      const r = await fetch(`${TEST_SUPABASE_URL}/storage/v1/object/photos/${objectPath}`, {
        method: 'POST', headers: headers({ 'Content-Type': type }), body: bytes,
      });
      await r.arrayBuffer();
      return r.status;
    },
    async download(objectPath) {
      const r = await fetch(`${TEST_SUPABASE_URL}/storage/v1/object/authenticated/photos/${objectPath}`, { headers: headers() });
      await r.arrayBuffer();
      return r.status;
    },
  };
}
