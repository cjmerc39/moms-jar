// Privacy tests (spec section 5), run against moms-jar-test only.
// Run with: npm run test:db
//
// Each run rebuilds moms-jar-test's schema from db/migrations, creates
// throwaway accounts, tries every rule through the public API, and cleans up.

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { addDays } from '../../logic.js';
import { loadSecrets, connect, rebuild, clearData, makeAccount, makePerson, client, SECRETS_FILE } from './setup.js';

const { secrets, missing } = loadSecrets();
const JPEG = Buffer.from('ffd8ffe000104a46494600010100000100010000ffd9', 'hex');

const rows = (r) => (Array.isArray(r.data) ? r.data : []);
const ids = (r) => rows(r).map((s) => s.id).sort();
const refused = (r) => r.status >= 400 || (Array.isArray(r.data) && r.data.length === 0);

describe('privacy rules on moms-jar-test', { skip: missing && `skipped: ${missing}` }, () => {
  let conn, db;
  let mom, admin, b, c, stranger;
  let as; // as.mom, as.b, ... API clients
  let today;
  const slip = {}; // named slip ids

  async function add(who, fields) {
    const r = await as[who].insert('slips', { prompt: 'A prompt', answer: 'An answer', from_name: 'Test', ...fields });
    assert.equal(r.status, 201, `insert as ${who} failed: ${JSON.stringify(r.data)}`);
    return r.data[0].id;
  }
  const dbSlip = async (id) => (await db.query('select * from public.slips where id = $1', [id])).rows[0];

  before(async () => {
    conn = await connect(secrets);
    db = conn.db;
    await rebuild(conn);
    today = (await db.query('select private.today() as d')).rows[0].d;
    await db.query('update public.settings set start_date = $1', [addDays(today, -2)]);

    mom = await makePerson(db, await makeAccount(conn.admin, 'mom'), 'Test Mom', 'mom');
    admin = await makePerson(db, await makeAccount(conn.admin, 'admin'), 'Test Admin', 'admin');
    b = await makePerson(db, await makeAccount(conn.admin, 'b'), 'Test B', 'contributor');
    c = await makePerson(db, await makeAccount(conn.admin, 'c'), 'Test C', 'contributor');
    stranger = await makeAccount(conn.admin, 'stranger'); // signed in, but never claimed an invite
    as = {
      mom: client(mom.token), admin: client(admin.token), b: client(b.token), c: client(c.token),
      stranger: client(stranger.token), visitor: client(null),
    };

    slip.bPrivate = await add('b', { prompt: 'B private', private: true });
    slip.bPublic = await add('b', { prompt: 'B public' });
    slip.cPublic = await add('c', { prompt: 'C public' });
  });

  after(async () => {
    if (!conn) return;
    await clearData(conn);
    await db.end();
  });

  test('a contributor sees the bank plus their own private slips', async () => {
    assert.deepEqual(ids(await as.b.select('slips')), [slip.bPrivate, slip.bPublic, slip.cPublic].sort());
    const mine = rows(await as.b.select('slips', `id=eq.${slip.bPrivate}`))[0];
    assert.equal(mine.private, true);
  });

  test("another contributor can't read a private slip, even by asking for it directly", async () => {
    assert.deepEqual(ids(await as.c.select('slips')), [slip.bPublic, slip.cPublic].sort());
    assert.deepEqual(rows(await as.c.select('slips', `id=eq.${slip.bPrivate}`)), []);
    assert.deepEqual(rows(await as.c.select('slips', 'prompt=eq.B%20private')), []);
    assert.deepEqual(rows(await as.c.select('slips', 'private=eq.true')), []);
  });

  test("the admin can't read someone else's private slip either", async () => {
    assert.deepEqual(rows(await as.admin.select('slips', `id=eq.${slip.bPrivate}`)), []);
    assert.ok(!ids(await as.admin.select('slips')).includes(slip.bPrivate));
  });

  test("Mom can't see waiting slips, private or not", async () => {
    assert.deepEqual(rows(await as.mom.select('slips')), []);
  });

  test('a signed-in stranger and a signed-out visitor get nothing', async () => {
    for (const who of ['stranger', 'visitor']) {
      for (const table of ['slips', 'people', 'settings', 'prompts', 'mom_marks']) {
        assert.ok(refused(await as[who].select(table)), `${who} read ${table}`);
      }
      assert.ok(refused(await as[who].insert('slips', { prompt: 'x', answer: 'x', from_name: 'x' })), `${who} added a slip`);
    }
    assert.ok(refused(await as.visitor.rpc('bank_summary')));
  });

  test("contributors can't change or delete someone else's slip", async () => {
    assert.deepEqual(rows(await as.c.update('slips', `id=eq.${slip.bPrivate}`, { answer: 'changed' })), []);
    assert.deepEqual(rows(await as.c.update('slips', `id=eq.${slip.bPublic}`, { answer: 'changed' })), []);
    assert.deepEqual(rows(await as.c.remove('slips', `id=eq.${slip.bPublic}`)), []);
    assert.deepEqual(rows(await as.admin.remove('slips', `id=eq.${slip.bPrivate}`)), []);
    assert.equal((await dbSlip(slip.bPrivate)).answer, 'An answer');
    assert.equal((await dbSlip(slip.bPublic)).answer, 'An answer');
  });

  test("nobody can add a slip as someone else, and Mom can't add slips", async () => {
    const forged = await as.c.insert('slips', { author_id: b.personId, prompt: 'x', answer: 'x', from_name: 'x' });
    assert.ok(forged.status >= 400);
    assert.ok((await as.mom.insert('slips', { prompt: 'x', answer: 'x', from_name: 'x' })).status >= 400);
    const early = await as.c.insert('slips', { prompt: 'x', answer: 'x', from_name: 'x', released_on: today });
    assert.ok(early.status >= 400);
  });

  test("an author can't change who wrote a slip or mark it released", async () => {
    assert.ok((await as.b.update('slips', `id=eq.${slip.bPublic}`, { author_id: c.personId })).status >= 400);
    assert.ok((await as.b.update('slips', `id=eq.${slip.bPublic}`, { released_on: today })).status >= 400);
    assert.ok((await as.b.update('slips', `id=eq.${slip.bPublic}`, { hidden: true })).status >= 400);
    const ok = await as.b.update('slips', `id=eq.${slip.bPublic}`, { answer: 'Better answer' });
    assert.equal(rows(ok).length, 1);
  });

  test('Mom sees released slips, including private ones, and nothing else', async () => {
    await db.query('update public.slips set released_on = $2 where id = $1', [slip.bPrivate, addDays(today, -1)]);
    await db.query('update public.slips set released_on = $2 where id = $1', [slip.bPublic, today]);
    assert.deepEqual(ids(await as.mom.select('slips')), [slip.bPrivate, slip.bPublic].sort());

    // A release date in the future stays hidden from her.
    await db.query('update public.slips set released_on = $2 where id = $1', [slip.cPublic, addDays(today, 1)]);
    assert.ok(!ids(await as.mom.select('slips')).includes(slip.cPublic));
    await db.query('update public.slips set released_on = null where id = $1', [slip.cPublic]);

    // Still private from the other contributor after release.
    assert.deepEqual(rows(await as.c.select('slips', `id=eq.${slip.bPrivate}`)), []);
  });

  test('released slips are locked, even for their author', async () => {
    assert.deepEqual(rows(await as.b.update('slips', `id=eq.${slip.bPrivate}`, { answer: 'changed' })), []);
    assert.deepEqual(rows(await as.b.remove('slips', `id=eq.${slip.bPublic}`)), []);
    assert.deepEqual(rows(await as.mom.update('slips', `id=eq.${slip.bPublic}`, { answer: 'changed' })), []);
    assert.equal((await dbSlip(slip.bPrivate)).answer, 'An answer');
    assert.ok(await dbSlip(slip.bPublic));
  });

  test("a hidden released slip disappears from Mom's jar", async () => {
    await db.query('update public.slips set hidden = true where id = $1', [slip.bPublic]);
    assert.ok(!ids(await as.mom.select('slips')).includes(slip.bPublic));
    await db.query('update public.slips set hidden = false where id = $1', [slip.bPublic]);
  });

  test("Mom's stars and read flags are hers alone", async () => {
    const mark = await as.mom.insert('mom_marks', { slip_id: slip.bPrivate, starred: true, read_at: new Date().toISOString() });
    assert.equal(mark.status, 201, JSON.stringify(mark.data));
    // Not on a slip she can't see.
    assert.ok((await as.mom.insert('mom_marks', { slip_id: slip.cPublic, starred: true })).status >= 400);
    for (const who of ['b', 'c', 'admin', 'stranger']) {
      assert.deepEqual(rows(await as[who].select('mom_marks')), [], `${who} read Mom's marks`);
      assert.ok((await as[who].insert('mom_marks', { slip_id: slip.bPublic, starred: true })).status >= 400);
      assert.deepEqual(rows(await as[who].update('mom_marks', `slip_id=eq.${slip.bPrivate}`, { starred: false })), []);
    }
    const stored = (await db.query('select starred from public.mom_marks where slip_id = $1', [slip.bPrivate])).rows[0];
    assert.equal(stored.starred, true);
  });

  test('the bank summary counts private slips without showing them', async () => {
    slip.bPinned = await add('b', { prompt: 'B pinned private', private: true, pinned_date: addDays(today, 10) });
    const waiting = Number((await db.query('select count(*) from public.slips where released_on is null')).rows[0].count);
    const r = await as.c.rpc('bank_summary');
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.deepEqual(r.data, [{ waiting, pinned_dates: [addDays(today, 10)] }]);
    assert.deepEqual((await as.mom.rpc('bank_summary')).data, [{ waiting: 0, pinned_dates: [] }]);
    assert.deepEqual((await as.stranger.rpc('bank_summary')).data, [{ waiting: 0, pinned_dates: [] }]);
  });

  test("pinned dates: one slip per date, after today, not before the start date", async () => {
    // C can't see B's private pinned slip, but still can't take its date.
    const taken = await as.c.insert('slips', { prompt: 'x', answer: 'x', from_name: 'x', pinned_date: addDays(today, 10) });
    assert.ok(taken.status >= 400);
    assert.equal(taken.data.message, 'That date is already taken.');
    const past = await as.c.insert('slips', { prompt: 'x', answer: 'x', from_name: 'x', pinned_date: today });
    assert.equal(past.data.message, 'Pick a date after today.');
    await db.query('update public.settings set start_date = $1', [addDays(today, 20)]);
    const early = await as.c.insert('slips', { prompt: 'x', answer: 'x', from_name: 'x', pinned_date: addDays(today, 15) });
    assert.equal(early.data.message, 'Pick a date on or after the start date.');
    await db.query('update public.settings set start_date = $1', [addDays(today, -2)]);
  });

  test('a turned-off invite or a removed person loses all access, but their waiting slips stay', async () => {
    await db.query('update private.invites set active = false where id = $1', [c.inviteId]);
    assert.deepEqual(rows(await as.c.select('slips')), []);
    assert.ok(refused(await as.c.insert('slips', { prompt: 'x', answer: 'x', from_name: 'x' })));
    await db.query('update private.invites set active = true where id = $1', [c.inviteId]);
    assert.ok(rows(await as.c.select('slips')).length > 0);

    await db.query('update public.people set active = false where id = $1', [c.personId]);
    assert.deepEqual(rows(await as.c.select('slips')), []);
    assert.deepEqual(rows(await as.c.select('people')), []);
    assert.ok(await dbSlip(slip.cPublic), "removed person's waiting slip is still in the bank");
    assert.ok(ids(await as.b.select('slips')).includes(slip.cPublic));
    await db.query('update public.people set active = true where id = $1', [c.personId]);
  });

  test('invite secrets and account links are not reachable through the API', async () => {
    for (const table of ['invites', 'person_accounts']) {
      assert.equal((await as.admin.select(table)).status, 404);
      assert.ok((await as.admin.select(table, 'select=*', { 'Accept-Profile': 'private' })).status >= 400);
    }
    assert.ok((await as.admin.rpc('my_person_id')).status >= 400);
  });

  test('only the admin changes people and settings', async () => {
    assert.deepEqual(rows(await as.c.update('settings', 'id=eq.1', { start_date: today })), []);
    assert.ok((await as.c.insert('people', { name: 'Someone', role: 'contributor' })).status >= 400);
    assert.deepEqual(rows(await as.c.update('people', `id=eq.${c.personId}`, { role: 'admin' })), []);
    assert.deepEqual(rows(await as.mom.update('settings', 'id=eq.1', { time_zone: 'UTC' })), []);

    const moved = await as.admin.update('settings', 'id=eq.1', { time_zone: 'America/Chicago' });
    assert.equal(rows(moved).length, 1);
    assert.ok((await as.admin.update('settings', 'id=eq.1', { time_zone: 'Not/AZone' })).status >= 400);
    await db.query(`update public.settings set time_zone = 'America/New_York'`);
    const added = await as.admin.insert('people', { name: 'New Person', role: 'contributor' });
    assert.equal(added.status, 201);
  });

  test('photos follow their slip: private stays private, Mom only after release', async () => {
    slip.bWaitingPublic = await add('b', { prompt: 'B public waiting' });
    const pub = `${slip.bWaitingPublic}/photo.jpg`;
    const priv = `${slip.bPinned}/photo.jpg`;
    assert.equal(await as.b.upload(pub, JPEG), 200);
    assert.equal(await as.b.upload(priv, JPEG), 200);

    assert.equal(await as.b.download(priv), 200);
    assert.notEqual(await as.c.download(priv), 200, 'another contributor got a private photo');
    assert.notEqual(await as.admin.download(priv), 200, 'admin got a private photo');
    assert.notEqual(await as.mom.download(priv), 200, 'Mom got a photo before release');
    assert.notEqual(await as.stranger.download(priv), 200);
    assert.notEqual(await as.visitor.download(priv), 200);

    assert.equal(await as.c.download(pub), 200, 'contributors see photos of slips in the bank');
    assert.notEqual(await as.mom.download(pub), 200);

    await db.query('update public.slips set released_on = $2 where id = $1', [slip.bPinned, addDays(today, -2)]);
    assert.equal(await as.mom.download(priv), 200, 'Mom gets the photo once released');
    assert.notEqual(await as.c.download(priv), 200);

    // Uploads: only the author, only while waiting, JPEG only.
    assert.notEqual(await as.c.upload(`${slip.bWaitingPublic}/other.jpg`, JPEG), 200);
    assert.notEqual(await as.b.upload(`${slip.bPinned}/second.jpg`, JPEG), 200, 'upload to a released slip');
    assert.notEqual(await as.b.upload(`${slip.bWaitingPublic}/photo.png`, JPEG, 'image/png'), 200);
    assert.notEqual(await as.mom.upload(`${slip.bPinned}/mom.jpg`, JPEG), 200);
    assert.notEqual(await as.b.upload(`not-a-slip/photo.jpg`, JPEG), 200);
  });
});

if (missing) console.log(`Privacy tests skipped: ${missing}\nSecrets file: ${SECRETS_FILE}`);
