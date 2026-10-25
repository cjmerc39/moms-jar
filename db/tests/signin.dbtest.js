// Invite link and sign-in tests (spec section 4), run against moms-jar-test only.
// Run with: npm run test:db
//
// The redeem-invite function runs locally (same file Supabase runs) against
// moms-jar-test. One last test calls the copy deployed to moms-jar-test.

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { handle } from '../../supabase/functions/redeem-invite/index.ts';
import { parseLinkHash } from '../../signin.js';
import { loadSecrets, connect, rebuild, clearData, client } from './setup.js';
import { TEST_SUPABASE_URL, TEST_SUPABASE_PUBLISHABLE_KEY } from './test-project.js';

const { secrets, missing } = loadSecrets();
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148';
const ANDROID = 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/140.0 Mobile Safari/537.36';

describe('invite links and sign-in on moms-jar-test', { skip: missing && `skipped: ${missing}` }, () => {
  let conn, db, env;

  // Calls the swap function the way the app does, then trades its token for a session.
  async function redeem(input, userAgent = IPHONE) {
    const res = await handle(new Request('https://local.test/redeem-invite', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': userAgent },
      body: JSON.stringify(input),
    }), env);
    const data = await res.json();
    if (res.status !== 200) return { status: res.status, error: data.error };
    const v = await fetch(`${TEST_SUPABASE_URL}/auth/v1/verify`, {
      method: 'POST',
      headers: { apikey: TEST_SUPABASE_PUBLISHABLE_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: data.type, token_hash: data.token_hash }),
    });
    const session = await v.json();
    assert.equal(v.status, 200, 'verify failed');
    return { status: 200, token: session.access_token, api: client(session.access_token) };
  }
  const whoami = async (api) => (await api.rpc('whoami')).data;

  let adminLink, adminApi;
  const people = {};

  before(async () => {
    conn = await connect(secrets);
    db = conn.db;
    env = { url: TEST_SUPABASE_URL, secretKey: secrets.TEST_SUPABASE_SECRET_KEY };
    await rebuild(conn);
  });

  after(async () => {
    if (!conn) return;
    await clearData(conn);
    await db.end();
  });

  test('one-time setup makes the admin and returns a working link', async () => {
    const link = (await db.query(`select private.setup_admin('Test Admin') as link`)).rows[0].link;
    assert.match(link, /^https:\/\/cjmerc39\.github\.io\/moms-jar\/#k=[A-Za-z0-9_-]{43}&c=[2-9A-HJ-NP-Z]{5}-[2-9A-HJ-NP-Z]{5}$/);
    adminLink = parseLinkHash(new URL(link).hash);
    const signedIn = await redeem({ key: adminLink.key });
    assert.equal(signedIn.status, 200);
    adminApi = signedIn.api;
    assert.deepEqual((await whoami(adminApi)).map((p) => [p.name, p.role]), [['Test Admin', 'admin']]);
    await assert.rejects(db.query(`select private.setup_admin('Second Admin')`), /already an admin/);
  });

  test('the admin adds people and makes their links', async () => {
    for (const [label, role] of [['mom', 'mom'], ['b', 'contributor'], ['c', 'contributor']]) {
      const added = await adminApi.insert('people', { name: `Test ${label}`, role });
      assert.equal(added.status, 201, JSON.stringify(added.data));
      const made = await adminApi.rpc('admin_make_link', { p_person: added.data[0].id });
      assert.equal(made.status, 200, JSON.stringify(made.data));
      people[label] = { id: added.data[0].id, ...made.data[0] };
    }
    assert.match(people.mom.code, /^[2-9A-HJ-NP-Z]{5}-[2-9A-HJ-NP-Z]{5}$/);
  });

  test('a key signs a device in as that person', async () => {
    const s = await redeem({ key: people.mom.key });
    assert.equal(s.status, 200);
    assert.deepEqual((await whoami(s.api)).map((p) => p.role), ['mom']);
    people.mom.phone = s.api;
  });

  test('the backup code works too, typed any old way', async () => {
    const typed = ` ${people.mom.code.toLowerCase().replace('-', ' ')} `;
    const s = await redeem({ code: typed }, ANDROID);
    assert.equal(s.status, 200);
    assert.deepEqual((await whoami(s.api)).map((p) => p.role), ['mom']);
    people.mom.tablet = s.api;
  });

  test('the admin screen shows devices, link use, and last active', async () => {
    const mom = (await adminApi.rpc('admin_people')).data.find((p) => p.id === people.mom.id);
    assert.equal(mom.link_on, true);
    assert.equal(mom.devices, 2);
    assert.deepEqual(mom.device_kinds.sort(), ['Android', 'iPhone']);
    assert.ok(Date.now() - new Date(mom.link_last_used) < 5 * 60 * 1000);

    // last_active moves when the app opens (touch_me).
    await db.query(`update private.person_accounts set last_seen_at = now() - interval '3 days' where person_id = $1`, [people.mom.id]);
    const before = (await adminApi.rpc('admin_people')).data.find((p) => p.id === people.mom.id).last_active;
    assert.ok(Date.now() - new Date(before) > 2 * 86400000);
    assert.equal((await people.mom.phone.rpc('touch_me')).status, 204);
    const after = (await adminApi.rpc('admin_people')).data.find((p) => p.id === people.mom.id).last_active;
    assert.ok(Date.now() - new Date(after) < 5 * 60 * 1000);

    const b = (await adminApi.rpc('admin_people')).data.find((p) => p.id === people.b.id);
    assert.deepEqual([b.link_on, b.devices, b.link_last_used], [true, 0, null]);
  });

  test('a new link turns off the old one and signs out every device that used it', async () => {
    const made = await adminApi.rpc('admin_make_link', { p_person: people.mom.id });
    const fresh = made.data[0];
    assert.deepEqual(await whoami(people.mom.phone), []);
    assert.deepEqual(await whoami(people.mom.tablet), []);
    assert.equal((await redeem({ key: people.mom.key })).status, 401);
    assert.equal((await redeem({ code: people.mom.code })).status, 401);

    const s = await redeem({ key: fresh.key });
    assert.deepEqual((await whoami(s.api)).map((p) => p.role), ['mom']);
    const mom = (await adminApi.rpc('admin_people')).data.find((p) => p.id === people.mom.id);
    assert.equal(mom.devices, 1, 'only devices on the current link count');
    Object.assign(people.mom, fresh, { phone: s.api });
  });

  test('turning off a link signs its devices out', async () => {
    const s = await redeem({ key: people.b.key });
    assert.equal((await whoami(s.api)).length, 1);
    assert.equal((await adminApi.rpc('admin_turn_off_link', { p_person: people.b.id })).status, 204);
    assert.deepEqual(await whoami(s.api), []);
    assert.deepEqual((await s.api.select('slips')).data, []);
    assert.equal((await redeem({ key: people.b.key })).status, 401);
    const b = (await adminApi.rpc('admin_people')).data.find((p) => p.id === people.b.id);
    assert.equal(b.link_on, false);
  });

  test('removing a person signs them out; the admin cannot remove themselves', async () => {
    const s = await redeem({ key: people.c.key });
    assert.equal((await adminApi.rpc('admin_remove_person', { p_person: people.c.id })).status, 204);
    assert.deepEqual(await whoami(s.api), []);
    assert.equal((await redeem({ key: people.c.key })).status, 401);
    const me = (await whoami(adminApi))[0];
    const self = await adminApi.rpc('admin_remove_person', { p_person: me.id });
    assert.equal(self.data.message, "You can't remove yourself.");
  });

  test('only the admin can use the admin functions', async () => {
    const visitor = client(null);
    for (const [who, api] of [['mom', people.mom.phone], ['visitor', visitor]]) {
      assert.ok((await api.rpc('admin_people')).status >= 400, `${who} listed people`);
      assert.ok((await api.rpc('admin_make_link', { p_person: people.mom.id })).status >= 400, `${who} made a link`);
      assert.ok((await api.rpc('admin_turn_off_link', { p_person: people.mom.id })).status >= 400);
      assert.ok((await api.rpc('admin_remove_person', { p_person: people.mom.id })).status >= 400);
    }
    assert.equal((await people.mom.phone.rpc('admin_people')).data.message, 'Only the admin can do that.');
    assert.equal((await whoami(people.mom.phone)).length, 1, "Mom's link still works");
  });

  test("the swap's database functions can't be called from the app", async () => {
    for (const api of [client(null), people.mom.phone, adminApi]) {
      assert.ok((await api.rpc('redeem_invite', { p_key: people.mom.key, p_code: null })).status >= 400);
      assert.ok((await api.rpc('link_device', {
        p_user: crypto.randomUUID(), p_person: people.mom.id, p_invite: crypto.randomUUID(), p_device: 'x',
      })).status >= 400);
    }
  });

  test('only fingerprints of keys and codes are stored', async () => {
    const rows = (await db.query('select * from private.invites where person_id = $1 and active', [people.mom.id])).rows;
    assert.equal(rows.length, 1);
    const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
    assert.equal(rows[0].token_hash, sha(people.mom.key));
    assert.equal(rows[0].code_hash, sha(people.mom.code.replace('-', '')));
    assert.ok(!JSON.stringify(rows).includes(people.mom.key));
  });

  test('wrong backup codes are rate limited; keys keep working', async () => {
    await db.query('truncate private.code_failures'); // earlier tests tried old codes
    for (let i = 0; i < 20; i++) {
      assert.equal((await redeem({ code: 'ZZZZZ-ZZZZZ' })).status, 401);
    }
    const blocked = await redeem({ code: 'ZZZZZ-ZZZZZ' });
    assert.equal(blocked.status, 429);
    assert.equal(blocked.error, 'Too many tries. Wait an hour, then try again.');
    assert.equal((await redeem({ code: people.mom.code })).status, 429, 'even the right code waits');
    assert.equal((await redeem({ key: people.mom.key })).status, 200, 'links are not affected');
    await db.query('truncate private.code_failures');
    assert.equal((await redeem({ code: people.mom.code })).status, 200);
  });

  test('junk requests get plain refusals', async () => {
    const call = (init) => handle(new Request('https://local.test/redeem-invite', init), env);
    assert.equal((await call({ method: 'GET' })).status, 405);
    const pre = await call({ method: 'OPTIONS' });
    assert.equal(pre.headers.get('Access-Control-Allow-Origin'), '*');
    assert.equal((await call({ method: 'POST', body: 'not json' })).status, 400);
    assert.equal((await call({ method: 'POST', body: '{}' })).status, 400);
    assert.equal((await call({ method: 'POST', body: JSON.stringify({ key: 'x'.repeat(500) }) })).status, 401);
    const wrong = await call({ method: 'POST', body: JSON.stringify({ key: 'A'.repeat(43) }) });
    assert.deepEqual([wrong.status, (await wrong.json()).error], [401, "That key or code isn't working. Ask CJ for a new link."]);
  });

  test('public sign-ups are switched off', async () => {
    const settings = await (await fetch(`${TEST_SUPABASE_URL}/auth/v1/settings`, {
      headers: { apikey: TEST_SUPABASE_PUBLISHABLE_KEY },
    })).json();
    assert.equal(settings.disable_signup, true, 'switch off "Allow new users to sign up" in moms-jar-test');
    const r = await fetch(`${TEST_SUPABASE_URL}/auth/v1/signup`, {
      method: 'POST',
      headers: { apikey: TEST_SUPABASE_PUBLISHABLE_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: `stranger-${crypto.randomUUID().slice(0, 8)}@moms-jar.test`, password: crypto.randomUUID() }),
    });
    assert.ok(r.status >= 400, 'a stranger was able to sign up');
  });

  test('the copy deployed to moms-jar-test swaps a key for a sign-in', async (t) => {
    const url = `${TEST_SUPABASE_URL}/functions/v1/redeem-invite`;
    const r = await fetch(url, {
      method: 'POST',
      headers: { apikey: TEST_SUPABASE_PUBLISHABLE_KEY, 'Content-Type': 'application/json', 'User-Agent': IPHONE },
      body: JSON.stringify({ key: people.mom.key }),
    });
    if (r.status === 404) {
      t.skip('redeem-invite is not deployed to moms-jar-test yet');
      return;
    }
    const data = await r.json();
    assert.equal(r.status, 200, `deployed function said: ${data.error || data.msg || r.status}`);
    const v = await fetch(`${TEST_SUPABASE_URL}/auth/v1/verify`, {
      method: 'POST',
      headers: { apikey: TEST_SUPABASE_PUBLISHABLE_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: data.type, token_hash: data.token_hash }),
    });
    const session = await v.json();
    assert.deepEqual((await whoami(client(session.access_token))).map((p) => p.role), ['mom']);
    const wrong = await fetch(url, {
      method: 'POST',
      headers: { apikey: TEST_SUPABASE_PUBLISHABLE_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'A'.repeat(43) }),
    });
    assert.equal(wrong.status, 401);
  });
});

if (missing) console.log(`Sign-in tests skipped: ${missing}`);
