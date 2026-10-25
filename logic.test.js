import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addDays, coverageEnd, dayNumber, emptyState, formatDate, isValidDate, localToday,
  mergeState, packVersionProblem, recordUnlocks, todaysSlip, unlockedSlips, validatePack,
} from './logic.js';

function slip(id, extra = {}) {
  return { id, prompt: `Prompt ${id}`, answer: `Answer ${id}`, from: 'CJ', photo: null, pinnedDate: null, ...extra };
}

function pack(slips, startDate = '2026-11-15', packVersion = 1) {
  return { format: 1, packVersion, startDate, slips };
}

const ids = (entries) => entries.map((e) => e.slip.id);
const dated = (entries) => entries.map((e) => `${e.date} ${e.slip.id}`);

// ---------- dates ----------

test('before start date: nothing unlocked, no slip today', () => {
  const p = pack([slip('a'), slip('b')]);
  assert.equal(dayNumber(p.startDate, '2026-11-14'), 0);
  assert.deepEqual(unlockedSlips(p, '2026-11-14'), []);
  assert.equal(todaysSlip(p, '2026-11-14'), null);
  assert.deepEqual(unlockedSlips(p, '2025-01-01'), []);
});

test('day 1: first slip unlocks on the start date', () => {
  const p = pack([slip('a'), slip('b')]);
  assert.equal(dayNumber(p.startDate, '2026-11-15'), 1);
  assert.deepEqual(dated(unlockedSlips(p, '2026-11-15')), ['2026-11-15 a']);
  assert.equal(todaysSlip(p, '2026-11-15').id, 'a');
});

test('pinned date mid sequence takes that day and the sequence pauses', () => {
  const p = pack([slip('a'), slip('b'), slip('xmas', { pinnedDate: '2026-11-17' }), slip('c'), slip('d')]);
  assert.deepEqual(dated(unlockedSlips(p, '2026-11-19')), [
    '2026-11-15 a',
    '2026-11-16 b',
    '2026-11-17 xmas',
    '2026-11-18 c',
    '2026-11-19 d',
  ]);
  assert.equal(todaysSlip(p, '2026-11-17').id, 'xmas');
  assert.equal(todaysSlip(p, '2026-11-18').id, 'c');
});

test('pinned date before its position in the list still lands on its date', () => {
  const p = pack([slip('early', { pinnedDate: '2026-11-16' }), slip('a'), slip('b')]);
  assert.deepEqual(dated(unlockedSlips(p, '2026-11-17')), [
    '2026-11-15 a',
    '2026-11-16 early',
    '2026-11-17 b',
  ]);
});

test('pinned date in the future stays hidden even when the sequence passes it', () => {
  const p = pack([slip('a'), slip('mday', { pinnedDate: '2027-05-09' }), slip('b'), slip('c')]);
  const got = unlockedSlips(p, '2026-11-20');
  assert.deepEqual(ids(got), ['a', 'b', 'c']);
  assert.equal(todaysSlip(p, '2026-11-20'), null);
  // Shows up on the day itself, and stays unlocked after.
  assert.equal(todaysSlip(p, '2027-05-09').id, 'mday');
  assert.ok(ids(unlockedSlips(p, '2027-06-01')).includes('mday'));
});

test('missed days: every skipped day has its slip waiting', () => {
  const p = pack([slip('a'), slip('b'), slip('c'), slip('d'), slip('e')]);
  let state = recordUnlocks(emptyState(), unlockedSlips(p, '2026-11-15'));
  state = { ...state, read: ['a'] };
  // She skips the 16th, 17th and 18th, opens the app on the 18th.
  const got = unlockedSlips(p, '2026-11-18', state);
  assert.deepEqual(dated(got), ['2026-11-15 a', '2026-11-16 b', '2026-11-17 c', '2026-11-18 d']);
  const unread = ids(got).filter((id) => !state.read.includes(id));
  assert.deepEqual(unread, ['b', 'c', 'd']);
  assert.equal(todaysSlip(p, '2026-11-18', state).id, 'd');
});

test('sequence exhausted: no slip today, earlier slips still there', () => {
  const p = pack([slip('a'), slip('b')]);
  assert.equal(todaysSlip(p, '2026-11-17'), null);
  assert.deepEqual(ids(unlockedSlips(p, '2026-11-17')), ['a', 'b']);
  assert.deepEqual(ids(unlockedSlips(p, '2027-11-17')), ['a', 'b']);
});

test('sequence exhausted but a pinned slip still to come shows on its day', () => {
  const p = pack([slip('a'), slip('xmas', { pinnedDate: '2026-12-25' })]);
  assert.equal(todaysSlip(p, '2026-12-01'), null);
  assert.equal(todaysSlip(p, '2026-12-25').id, 'xmas');
  assert.equal(todaysSlip(p, '2026-12-26'), null);
});

test('daylight saving changeover day counts as one ordinary day', () => {
  // US clocks fall back on 2026-11-01 and spring forward on 2027-03-14.
  assert.equal(dayNumber('2026-10-31', '2026-11-01'), 2);
  assert.equal(dayNumber('2026-10-31', '2026-11-02'), 3);
  assert.equal(dayNumber('2027-03-13', '2027-03-14'), 2);
  assert.equal(dayNumber('2027-03-13', '2027-03-15'), 3);
  assert.equal(addDays('2026-10-31', 1), '2026-11-01');
  assert.equal(addDays('2027-03-14', 1), '2027-03-15');

  const p = pack([slip('a'), slip('b'), slip('c')], '2026-10-31');
  assert.deepEqual(dated(unlockedSlips(p, '2026-11-02')), ['2026-10-31 a', '2026-11-01 b', '2026-11-02 c']);

  // Late evening on the changeover day is still that day on her phone.
  assert.equal(localToday(new Date(2026, 10, 1, 23, 30)), '2026-11-01');
  assert.equal(localToday(new Date(2026, 10, 1, 0, 30)), '2026-11-01');
  assert.equal(localToday(new Date(2027, 2, 14, 23, 59)), '2027-03-14');
});

test('leap day is a real day in the sequence', () => {
  assert.equal(addDays('2028-02-28', 1), '2028-02-29');
  assert.equal(addDays('2028-02-29', 1), '2028-03-01');
  assert.equal(addDays('2027-02-28', 1), '2027-03-01');
  assert.equal(dayNumber('2028-02-28', '2028-03-01'), 3);
  assert.ok(isValidDate('2028-02-29'));
  assert.ok(!isValidDate('2027-02-29'));

  const p = pack([slip('a'), slip('leap', { pinnedDate: '2028-02-29' }), slip('b')], '2028-02-28');
  assert.deepEqual(dated(unlockedSlips(p, '2028-03-01')), ['2028-02-28 a', '2028-02-29 leap', '2028-03-01 b']);
});

// ---------- new packs ----------

test('new pack that edits one slip and deletes another keeps her state', () => {
  const v1 = pack([slip('a'), slip('b'), slip('c'), slip('d')], '2026-11-15', 1);
  let state = recordUnlocks(emptyState(), unlockedSlips(v1, '2026-11-17'));
  state = { ...state, favorites: ['a', 'c'], read: ['a', 'b', 'c'] };

  // v2: 'b' reworded (same id), 'c' deleted.
  const v2 = pack([slip('a'), slip('b', { answer: 'Better answer' }), slip('d')], '2026-11-15', 2);
  const merged = mergeState(state, v2);
  assert.deepEqual(merged.favorites, ['a']);
  assert.deepEqual(merged.read, ['a', 'b']);
  assert.deepEqual(merged.unlocked, { a: '2026-11-15', b: '2026-11-16' });

  const got = unlockedSlips(v2, '2026-11-17', merged);
  assert.equal(got.find((e) => e.slip.id === 'b').slip.answer, 'Better answer');
  assert.ok(!ids(got).includes('c'));
});

test('new pack that inserts and reorders never re-locks a slip she has seen', () => {
  const v1 = pack([slip('a'), slip('b'), slip('c'), slip('d'), slip('e')]);
  const state = recordUnlocks(emptyState(), unlockedSlips(v1, '2026-11-17'));
  assert.deepEqual(state.unlocked, { a: '2026-11-15', b: '2026-11-16', c: '2026-11-17' });

  // v2 inserts 'x' at the front and moves 'c' to the end.
  const v2 = pack([slip('x'), slip('a'), slip('b'), slip('d'), slip('e'), slip('c')], '2026-11-15', 2);
  const merged = mergeState(state, v2);
  assert.deepEqual(dated(unlockedSlips(v2, '2026-11-17', merged)), [
    '2026-11-15 a',
    '2026-11-16 b',
    '2026-11-17 c',
  ]);
  // The inserted slip comes next, then the rest in the new order.
  assert.equal(todaysSlip(v2, '2026-11-18', merged).id, 'x');
  assert.deepEqual(ids(unlockedSlips(v2, '2026-11-20', merged)), ['a', 'b', 'c', 'x', 'd', 'e']);
});

test('recordUnlocks keeps the first date a slip was given', () => {
  const p = pack([slip('a'), slip('b')]);
  const s1 = recordUnlocks(emptyState(), unlockedSlips(p, '2026-11-15'));
  const s2 = recordUnlocks(s1, unlockedSlips(p, '2026-11-16', s1));
  assert.deepEqual(s2.unlocked, { a: '2026-11-15', b: '2026-11-16' });
});

test('slips she has seen stay unlocked if the phone clock moves back', () => {
  const p = pack([slip('a'), slip('b'), slip('c')]);
  const state = recordUnlocks(emptyState(), unlockedSlips(p, '2026-11-17'));
  assert.deepEqual(ids(unlockedSlips(p, '2026-11-15', state)), ['a', 'b', 'c']);
});

test('mergeState handles no previous state', () => {
  assert.deepEqual(mergeState(null, pack([slip('a')])), emptyState());
});

test('packVersionProblem refuses older packs, allows same or newer', () => {
  assert.equal(packVersionProblem(null, pack([], '2026-11-15', 1)), null);
  assert.equal(packVersionProblem(3, pack([], '2026-11-15', 3)), null);
  assert.equal(packVersionProblem(3, pack([], '2026-11-15', 4)), null);
  assert.match(packVersionProblem(3, pack([], '2026-11-15', 2)), /older jar file \(version 2\).*version 3/);
});

// ---------- builder helpers ----------

test('coverageEnd: last unlock date, counting pinned days', () => {
  assert.equal(coverageEnd(pack([])), null);
  assert.equal(coverageEnd(pack([slip('a'), slip('b'), slip('c')])), '2026-11-17');
  // Pinned day mid-run pushes the sequence back one day.
  assert.equal(coverageEnd(pack([slip('a'), slip('p', { pinnedDate: '2026-11-16' }), slip('b')])), '2026-11-17');
  // Pinned day far out wins.
  assert.equal(coverageEnd(pack([slip('a'), slip('p', { pinnedDate: '2027-05-09' })])), '2027-05-09');
});

test('formatDate', () => {
  assert.equal(formatDate('2027-01-01'), 'Jan 1');
  assert.equal(formatDate('2026-11-15', true), 'Nov 15, 2026');
});

// ---------- validatePack ----------

test('validatePack: a good pack has no problems', () => {
  const p = pack([
    slip('a', { photo: 'data:image/jpeg;base64,/9j/AAAA' }),
    slip('b', { pinnedDate: '2026-12-25' }),
  ]);
  assert.deepEqual(validatePack(p), []);
  assert.deepEqual(validatePack(JSON.stringify(p)), []);
});

test('validatePack: unreadable or wrong files', () => {
  assert.deepEqual(validatePack('not json'), ["This file isn't a jar file. It couldn't be read."]);
  assert.deepEqual(validatePack('[1,2]'), ["This file isn't a jar file."]);
  assert.deepEqual(validatePack(null), ["This file isn't a jar file."]);
});

test('validatePack: pack-level problems', () => {
  const problems = validatePack({ format: 2, packVersion: 0, startDate: '2026-13-01', slips: [] });
  assert.equal(problems.length, 4);
  assert.match(problems[0], /format 2/);
  assert.match(problems[1], /pack version/);
  assert.match(problems[2], /start date/);
  assert.match(problems[3], /no slips/);
  assert.match(validatePack({ format: 1, packVersion: 1, startDate: '2026-11-15' })[0], /no list of slips/);
});

test('validatePack: slip-level problems in plain language', () => {
  const p = pack([
    slip('a'),
    slip('a', { prompt: 'Duplicate id' }),
    slip('c', { prompt: '', answer: ' ', from: '' }),
    slip('d', { photo: 'data:image/png;base64,iVBOR' }),
    slip('e', { pinnedDate: '2026-11-01' }),
    slip('f', { pinnedDate: '2026-12-25' }),
    slip('g', { pinnedDate: '2026-12-25' }),
    slip('h', { pinnedDate: '2026-02-30' }),
    slip('', { prompt: 'No id here' }),
  ]);
  assert.deepEqual(validatePack(p), [
    'Slip 2 ("Duplicate id") has the same id as slip 1 (a).',
    'Slip 3 has no prompt.',
    'Slip 3 has no answer.',
    "Slip 3 doesn't say who it's from.",
    'Slip 4 ("Prompt d") has a photo that isn\'t a JPEG.',
    'Slip 5 ("Prompt e") is pinned to Nov 1, 2026, before the start date.',
    'Slip 7 ("Prompt g") is pinned to Dec 25, 2026, the same day as slip 6.',
    'Slip 8 ("Prompt h") has a pinned date that isn\'t a real date.',
    'Slip 9 ("No id here") has no id.',
  ]);
});

test('validatePack: long prompts are shortened in messages', () => {
  const long = 'The thing you always said to us at the door every morning';
  const [msg] = validatePack(pack([slip('a', { prompt: long, answer: '' })]));
  assert.equal(msg, 'Slip 1 ("The thing you always said to us at the…") has no answer.');
});
