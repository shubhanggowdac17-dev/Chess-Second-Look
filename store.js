// What the site remembers, all of it inside this browser only.
//   cc-history    the reviewed games and their mistakes (same key and shape as the first version)
//   cc-user       the player's own Chess.com username
//   cc-practice   how each practice position went
//   cc-friends    usernames on the Friends tab
//   cc-settings   theme, sound, voice and so on
//   IndexedDB "second-look"   finished engine analysis, so a game opens instantly the second time

import { lsGet, lsSet, lsGetText, lsSetText } from './util.js';

export const HISTORY_KEY = 'cc-history';
export const MAX_HISTORY = 300;              // oldest games drop off after this many
const MAX_SAVED_ANALYSES = 150;

// ---------- History ----------
export function loadHistory() {
  const h = lsGet(HISTORY_KEY, []);
  // Entries saved by older versions have fewer fields; anything unusable is skipped rather than crashing.
  return Array.isArray(h) ? h.filter(r => r && r.id && Array.isArray(r.mistakes)) : [];
}
export function storeHistory(h) { return lsSet(HISTORY_KEY, h); }
export function saveToHistory(rec) {
  const hist = loadHistory().filter(r => r.id !== rec.id);
  hist.push(rec);
  if (hist.length > MAX_HISTORY) hist.splice(0, hist.length - MAX_HISTORY);
  return storeHistory(hist);
}
export function mergeHistory(records) {      // used by "Import backup"
  const byId = new Map(loadHistory().map(r => [r.id, r]));
  let added = 0;
  for (const r of records) if (r && r.id && Array.isArray(r.mistakes)) { if (!byId.has(r.id)) added++; byId.set(r.id, r); }
  const all = [...byId.values()].sort((a, b) => (a.saved || 0) - (b.saved || 0));
  if (all.length > MAX_HISTORY) all.splice(0, all.length - MAX_HISTORY);
  storeHistory(all);
  return added;
}
export function tallyHistory(hist) {
  const t = { games: hist.length, slips: 0, tag: {}, tagGames: {}, phase: {}, piece: {}, motif: {}, low: 0, clocked: 0, openings: {} };
  for (const r of hist) {
    const key = r.family || 'Unknown opening';
    const o = t.openings[key] || (t.openings[key] = { games: 0, win: 0, draw: 0, loss: 0, slips: 0 });
    o.games++;
    if (r.result === 'win' || r.result === 'draw' || r.result === 'loss') o[r.result]++;
    o.slips += r.mistakes.length;
    const seen = new Set();
    for (const m of r.mistakes) {
      t.slips++;
      t.tag[m.tag] = (t.tag[m.tag] || 0) + 1;
      if (!seen.has(m.tag)) { seen.add(m.tag); t.tagGames[m.tag] = (t.tagGames[m.tag] || 0) + 1; }
      t.phase[m.phase] = (t.phase[m.phase] || 0) + 1;
      t.piece[m.piece] = (t.piece[m.piece] || 0) + 1;
      if (m.motif) t.motif[m.motif] = (t.motif[m.motif] || 0) + 1;
      if (m.low != null) { t.clocked++; if (m.low) t.low++; }
    }
  }
  return t;
}

// ---------- Small settings ----------
export const getUser = () => lsGetText('cc-user');
export const setUser = u => lsSetText('cc-user', u);
export const settings = Object.assign({ theme: '', sound: true, lines: false, depth: '12' }, lsGet('cc-settings', {}));
export function saveSettings() { lsSet('cc-settings', settings); }

// ---------- Practice results ----------
export const loadPractice = () => lsGet('cc-practice', {});
export function recordPractice(fen, solved) {
  const p = loadPractice();
  const r = p[fen] || (p[fen] = { ok: 0, bad: 0, last: 0 });
  if (solved) r.ok++; else r.bad++;
  r.last = Date.now();
  lsSet('cc-practice', p);
}

// ---------- Saved analysis (IndexedDB) ----------
let dbPromise = null;
function db() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open('second-look', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('analysis', { keyPath: 'id' });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    dbPromise.catch(() => {});
  }
  return dbPromise;
}
const done = req => new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
// Every function below quietly does nothing when the browser has no usable IndexedDB.
export async function getAnalysis(id) {
  try { return await done((await db()).transaction('analysis').objectStore('analysis').get(id)); }
  catch { return null; }
}
export async function putAnalysis(packed) {
  try {
    const open = mode => db().then(d => d.transaction('analysis', mode).objectStore('analysis'));
    await done((await open('readwrite')).put(packed));
    if (await done((await open('readonly')).count()) > MAX_SAVED_ANALYSES + 20) {     // now and then, drop the oldest
      const all = await done((await open('readonly')).getAll());
      all.sort((a, b) => a.t - b.t);
      const store = await open('readwrite');
      for (const old of all.slice(0, all.length - MAX_SAVED_ANALYSES)) store.delete(old.id);
    }
  } catch {}
}
export async function clearAnalyses() {
  try { await done((await db()).transaction('analysis', 'readwrite').objectStore('analysis').clear()); } catch {}
}
