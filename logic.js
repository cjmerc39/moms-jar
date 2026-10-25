// All date and unlock math for the jar. Plain functions, no DOM, no storage.
//
// Dates are 'YYYY-MM-DD' strings in her local time. Internally they are turned
// into whole day counts via Date.UTC, so daylight saving and time zones never
// enter the arithmetic.
//
// State shape (stored on her phone):
//   { favorites: [id], read: [id], unlocked: { id: 'YYYY-MM-DD' } }
// `unlocked` remembers every slip she has been given and on which day, so a
// new pack that inserts or reorders slips never re-locks one she has seen.

export const APP_NAME = 'The Jar';
export const PACK_FORMAT = 1;

const DAY_MS = 86400000;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// ---------- dates ----------

export function isValidDate(s) {
  if (typeof s !== 'string') return false;
  const m = DATE_RE.exec(s);
  if (!m) return false;
  const [y, mo, d] = [+m[1], +m[2], +m[3]];
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}

function toDays(s) {
  const m = DATE_RE.exec(s);
  return Date.UTC(+m[1], +m[2] - 1, +m[3]) / DAY_MS;
}

function fromDays(n) {
  const t = new Date(n * DAY_MS);
  const y = t.getUTCFullYear();
  const mo = String(t.getUTCMonth() + 1).padStart(2, '0');
  const d = String(t.getUTCDate()).padStart(2, '0');
  return `${y}-${mo}-${d}`;
}

export function addDays(date, n) {
  return fromDays(toDays(date) + n);
}

// Today's date on this device, from local calendar fields. Never use
// toISOString() for this: it is UTC and rolls over to tomorrow in the evening.
export function localToday(now = new Date()) {
  const y = now.getFullYear();
  const mo = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${mo}-${d}`;
}

// 'Jan 1' style, for "covers through" and "Come back on".
export function formatDate(date, withYear = false) {
  const m = DATE_RE.exec(date);
  const s = `${MONTHS[+m[2] - 1]} ${+m[3]}`;
  return withYear ? `${s}, ${m[1]}` : s;
}

// Day 1 is startDate. Days before it are 0 or negative.
export function dayNumber(startDate, today) {
  return toDays(today) - toDays(startDate) + 1;
}

// ---------- unlocking ----------

// Walks day by day from startDate to `until`, handing out slips:
//   - a day that already has a remembered slip is used up by it;
//   - otherwise any pinned slip for that day takes it;
//   - otherwise the next unpinned slip in pack order.
// Pinned slips are never reached by the sequence, so future ones stay hidden.
// Returns [{ slip, date }] in unlock order.
function schedule(pack, state, until) {
  const start = pack.startDate;
  const slips = pack.slips || [];
  const byId = new Map(slips.map((s) => [s.id, s]));
  const remembered = (state && state.unlocked) || {};

  const out = [];
  const done = new Set();
  const rememberedByDate = new Map();
  for (const [id, date] of Object.entries(remembered)) {
    const slip = byId.get(id);
    if (!slip || done.has(id)) continue;
    done.add(id);
    // Once unlocked, always unlocked, even if the dates no longer line up
    // (phone clock moved back, start date edited).
    if (date < start || date > until) out.push({ slip, date });
    else {
      if (!rememberedByDate.has(date)) rememberedByDate.set(date, []);
      rememberedByDate.get(date).push(slip);
    }
  }

  const pinnedByDate = new Map();
  for (const slip of slips) {
    if (!slip.pinnedDate || done.has(slip.id)) continue;
    // A pin before the start date (validatePack flags it) unlocks on day 1.
    const date = slip.pinnedDate < start ? start : slip.pinnedDate;
    if (!pinnedByDate.has(date)) pinnedByDate.set(date, []);
    pinnedByDate.get(date).push(slip);
  }

  const queue = slips.filter((s) => !s.pinnedDate);
  let next = 0;
  let left = byId.size - done.size;

  for (let d = toDays(start), end = toDays(until); d <= end; d++) {
    const date = fromDays(d);
    const rem = rememberedByDate.get(date) || [];
    for (const slip of rem) out.push({ slip, date });

    let given = rem.length;
    for (const slip of pinnedByDate.get(date) || []) {
      if (done.has(slip.id)) continue;
      done.add(slip.id);
      out.push({ slip, date });
      given++;
      left--;
    }

    if (given === 0) {
      while (next < queue.length && done.has(queue[next].id)) next++;
      if (next < queue.length) {
        const slip = queue[next++];
        done.add(slip.id);
        out.push({ slip, date });
        left--;
      }
    }

    rememberedByDate.delete(date);
    if (left <= 0 && rememberedByDate.size === 0) break;
  }

  return out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

// Every slip she has, oldest first, as [{ slip, date }].
export function unlockedSlips(pack, today, state = null) {
  if (!pack || !isValidDate(pack.startDate) || !isValidDate(today)) return [];
  return schedule(pack, state, today);
}

// The slip for today, or null (before start, or the sequence ran out).
export function todaysSlip(pack, today, state = null) {
  const hit = unlockedSlips(pack, today, state).find((e) => e.date === today);
  return hit ? hit.slip : null;
}

// The last date a slip unlocks, assuming she has seen nothing yet. For the
// builder's "covers through". Null if the pack has no slips.
export function coverageEnd(pack) {
  const all = schedule(pack, null, '9999-12-31');
  return all.length ? all[all.length - 1].date : null;
}

// ---------- state ----------

export function emptyState() {
  return { favorites: [], read: [], unlocked: {} };
}

// Keeps favorites, read flags and unlock history for ids still in the pack.
export function mergeState(oldState, newPack) {
  const old = oldState || emptyState();
  const ids = new Set(((newPack && newPack.slips) || []).map((s) => s.id));
  const unlocked = {};
  for (const [id, date] of Object.entries(old.unlocked || {})) {
    if (ids.has(id)) unlocked[id] = date;
  }
  return {
    favorites: (old.favorites || []).filter((id) => ids.has(id)),
    read: (old.read || []).filter((id) => ids.has(id)),
    unlocked,
  };
}

// Adds newly unlocked slips to state.unlocked. Returns a new state.
export function recordUnlocks(state, entries) {
  const s = state || emptyState();
  const unlocked = { ...(s.unlocked || {}) };
  for (const { slip, date } of entries) {
    if (!(slip.id in unlocked)) unlocked[slip.id] = date;
  }
  return { ...s, unlocked };
}

// ---------- packs ----------

// Null if the new pack may replace the current one, otherwise the reason.
// The same version is allowed so a lost pack can be reloaded.
export function packVersionProblem(currentVersion, newPack) {
  if (currentVersion == null) return null;
  if (newPack.packVersion < currentVersion) {
    return `This is an older jar file (version ${newPack.packVersion}). ` +
      `Your jar already has version ${currentVersion}. Open the latest jar file CJ sent you.`;
  }
  return null;
}

function slipLabel(slip, i) {
  const prompt = slip && typeof slip.prompt === 'string' ? slip.prompt.trim() : '';
  if (!prompt) return `Slip ${i + 1}`;
  let short = prompt;
  if (prompt.length > 40) {
    // Cut at the last whole word that fits.
    const cut = prompt.slice(0, 41).lastIndexOf(' ');
    short = prompt.slice(0, cut > 0 ? cut : 40).trimEnd() + '…';
  }
  return `Slip ${i + 1} ("${short}")`;
}

function filled(v) {
  return typeof v === 'string' && v.trim() !== '';
}

// Plain-language problems with a pack. Empty list means it is fine.
// Accepts the parsed object or the raw file text.
export function validatePack(json) {
  let pack = json;
  if (typeof json === 'string') {
    try {
      pack = JSON.parse(json);
    } catch {
      return ["This file isn't a jar file. It couldn't be read."];
    }
  }
  if (!pack || typeof pack !== 'object' || Array.isArray(pack)) {
    return ["This file isn't a jar file."];
  }

  const problems = [];
  if (pack.format !== PACK_FORMAT) {
    problems.push(`This jar file is format ${pack.format ?? 'unknown'}, but this app reads format ${PACK_FORMAT}.`);
  }
  if (!Number.isInteger(pack.packVersion) || pack.packVersion < 1) {
    problems.push('The pack version is missing or not a whole number.');
  }
  const startOk = isValidDate(pack.startDate);
  if (!startOk) problems.push('The start date is missing or not a real date (it should look like 2026-11-15).');

  if (!Array.isArray(pack.slips)) {
    problems.push('The pack has no list of slips.');
    return problems;
  }
  if (pack.slips.length === 0) problems.push('The pack has no slips.');

  const seenIds = new Map();
  const pinnedOn = new Map();
  pack.slips.forEach((slip, i) => {
    const label = slipLabel(slip, i);
    if (!slip || typeof slip !== 'object') {
      problems.push(`${label} is not a slip.`);
      return;
    }
    if (!filled(slip.id)) problems.push(`${label} has no id.`);
    else if (seenIds.has(slip.id)) {
      problems.push(`${label} has the same id as slip ${seenIds.get(slip.id) + 1} (${slip.id}).`);
    } else seenIds.set(slip.id, i);

    if (!filled(slip.prompt)) problems.push(`${label} has no prompt.`);
    if (!filled(slip.answer)) problems.push(`${label} has no answer.`);
    if (!filled(slip.from)) problems.push(`${label} doesn't say who it's from.`);

    if (slip.photo != null && slip.photo !== '') {
      if (typeof slip.photo !== 'string' || !slip.photo.startsWith('data:image/jpeg;base64,')) {
        problems.push(`${label} has a photo that isn't a JPEG.`);
      }
    }

    if (slip.pinnedDate != null && slip.pinnedDate !== '') {
      if (!isValidDate(slip.pinnedDate)) {
        problems.push(`${label} has a pinned date that isn't a real date.`);
      } else {
        if (startOk && slip.pinnedDate < pack.startDate) {
          problems.push(`${label} is pinned to ${formatDate(slip.pinnedDate, true)}, before the start date.`);
        }
        if (pinnedOn.has(slip.pinnedDate)) {
          problems.push(`${label} is pinned to ${formatDate(slip.pinnedDate, true)}, the same day as slip ${pinnedOn.get(slip.pinnedDate) + 1}.`);
        } else pinnedOn.set(slip.pinnedDate, i);
      }
    }
  });

  return problems;
}
