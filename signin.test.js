import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildLink, describeWhen, formatCode, isCode, needsInstallFirst, normalizeCode,
  parseLinkHash, parseSignInInput, smsLink,
} from './signin.js';
import { deviceKind } from './supabase/functions/redeem-invite/index.ts';

const KEY = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdE'; // 43 chars
const APP = 'https://example.github.io/jar/';

const UA = {
  iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  ipadDesktop: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
  android: 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36',
  windows: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
};

test('key is 43 characters', () => assert.equal(KEY.length, 43));

test('backup codes ignore case, spaces and dashes', () => {
  assert.equal(normalizeCode(' abcde-fghjk '), 'ABCDEFGHJK');
  assert.ok(isCode('abcde fghjk'));
  assert.ok(isCode('ABCDE-FGHJK'));
  assert.ok(!isCode('ABCDE-FGHJ')); // too short
  assert.ok(!isCode('ABCDE-FGHJ0')); // 0 isn't in the alphabet
  assert.ok(!isCode('ABCDE-FGHIK')); // nor is I
  assert.equal(formatCode('abcdefghjk'), 'ABCDE-FGHJK');
});

test('links round-trip through buildLink and parseLinkHash', () => {
  const link = buildLink(`${APP}#old`, KEY, 'abcdefghjk');
  assert.equal(link, `${APP}#k=${KEY}&c=ABCDE-FGHJK`);
  assert.deepEqual(parseLinkHash(new URL(link).hash), { key: KEY, code: 'ABCDE-FGHJK' });
});

test('parseLinkHash ignores junk', () => {
  assert.deepEqual(parseLinkHash(''), { key: null, code: null });
  assert.deepEqual(parseLinkHash('#k=short&c=nope'), { key: null, code: null });
  assert.deepEqual(parseLinkHash('#c=ABCDE-FGHJK'), { key: null, code: 'ABCDE-FGHJK' });
});

test('whatever she pastes or types is understood', () => {
  assert.deepEqual(parseSignInInput(`  ${APP}#k=${KEY}&c=ABCDE-FGHJK `), { key: KEY });
  assert.deepEqual(parseSignInInput(`Here's your link: ${APP}#k=${KEY}&c=ABCDE-FGHJK`), { key: KEY });
  assert.deepEqual(parseSignInInput(KEY), { key: KEY });
  assert.deepEqual(parseSignInInput('abcde fghjk'), { code: 'ABCDE-FGHJK' });
  assert.equal(parseSignInInput(''), null);
  assert.equal(parseSignInInput('hello'), null);
  assert.equal(parseSignInInput(`${APP}#nothing`), null);
});

test('iPhones and iPads in Safari install first; installed apps and other phones sign in directly', () => {
  assert.equal(needsInstallFirst(UA.iphone, false), true);
  assert.equal(needsInstallFirst(UA.iphone, true), false);
  assert.equal(needsInstallFirst(UA.ipadDesktop, false, 5), true); // iPadOS pretends to be a Mac
  assert.equal(needsInstallFirst(UA.ipadDesktop, false, 0), false); // a real Mac
  assert.equal(needsInstallFirst(UA.android, false), false);
  assert.equal(needsInstallFirst(UA.windows, false), false);
});

test('the server function names devices plainly', () => {
  assert.equal(deviceKind(UA.iphone), 'iPhone');
  assert.equal(deviceKind(UA.android), 'Android');
  assert.equal(deviceKind(UA.windows), 'Windows');
  assert.equal(deviceKind(UA.ipadDesktop), 'Mac');
  assert.equal(deviceKind(''), 'Other');
});

test('describeWhen for the admin screen', () => {
  const tz = 'America/New_York';
  const now = new Date('2026-10-25T18:00:00Z'); // 2:00 PM in New York
  assert.equal(describeWhen(null, now, tz), 'Never');
  assert.equal(describeWhen('2026-10-25T17:59:30Z', now, tz), 'Just now');
  assert.equal(describeWhen('2026-10-25T13:14:00Z', now, tz), 'Today, 9:14 AM');
  assert.equal(describeWhen('2026-10-25T03:30:00Z', now, tz), 'Yesterday, 11:30 PM'); // still the 24th in New York
  assert.equal(describeWhen('2026-10-20T15:00:00Z', now, tz), 'Oct 20');
  assert.equal(describeWhen('2025-12-31T15:00:00Z', now, tz), 'Dec 31, 2025');
});

test('smsLink fills in the message', () => {
  assert.equal(smsLink('Hi & welcome'), 'sms:?&body=Hi%20%26%20welcome');
});
