// Small helpers shared by every file.

export const $ = id => document.getElementById(id);
export const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
export const cap = s => s ? s[0].toUpperCase() + s.slice(1) : s;
export const count = (n, one, many) => n + ' ' + (n === 1 ? one : many);
export const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

export const FILES = 'abcdefgh';
export const VALUE = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
export const PIECE_NAME = { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king' };

// localStorage wrappers that never throw (private browsing, full storage, blocked cookies).
export function lsGet(key, fallback = null) {
  try { const v = localStorage.getItem(key); return v == null ? fallback : JSON.parse(v); }
  catch { return fallback; }
}
export function lsSet(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); return true; }
  catch { return false; }
}
// Plain-string versions, for keys written by the first version of the site (cc-user, cc-voice).
export function lsGetText(key) { try { return localStorage.getItem(key) || ''; } catch { return ''; } }
export function lsSetText(key, value) { try { localStorage.setItem(key, value); } catch {} }

export function hashText(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return 'g' + (h >>> 0).toString(36);
}
