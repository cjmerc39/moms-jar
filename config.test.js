import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as config from './config.js';
import { TEST_PROJECT_REF } from './db/tests/test-project.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const REAL_REF = 'ogseunsakzzjvgyhcoyg';

test('config.js points the app at the real project and nothing else', () => {
  assert.deepEqual(Object.keys(config).sort(), ['SUPABASE_PUBLISHABLE_KEY', 'SUPABASE_URL']);
  assert.equal(config.SUPABASE_URL, `https://${REAL_REF}.supabase.co`);
  assert.match(config.SUPABASE_PUBLISHABLE_KEY, /^sb_publishable_/);
});

test('config.js is only comments and two fixed string constants', () => {
  // No code that could pick a different project at runtime.
  const code = fs.readFileSync(path.join(root, 'config.js'), 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '' && !line.trim().startsWith('//'));
  assert.deepEqual(code.map((l) => l.replace(/'[^']*'/, "'…'")), [
    "export const SUPABASE_URL = '…';",
    "export const SUPABASE_PUBLISHABLE_KEY = '…';",
  ]);
});

test('nothing outside db/tests knows about the test project', () => {
  const skip = new Set(['.git', 'node_modules', path.join('db', 'tests')]);
  const hits = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const rel = path.join(dir, entry.name);
      if (skip.has(rel) || skip.has(entry.name)) continue;
      if (entry.isDirectory()) walk(rel);
      else if (rel !== 'config.test.js') {
        const text = fs.readFileSync(path.join(root, rel), 'utf8');
        if (text.includes(TEST_PROJECT_REF) || /TEST_SUPABASE/.test(text)) hits.push(rel);
      }
    }
  })('');
  assert.deepEqual(hits, []);
});
