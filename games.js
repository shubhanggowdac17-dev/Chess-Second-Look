// Getting games from the public Chess.com API and showing them a month at a time.
// The API needs no key and no login. It serves one month of games per request, so that is how
// the list works: one month on screen, fetched when chosen, kept in memory afterwards.

import { $, esc, count } from './util.js';

const API = 'https://api.chess.com/pub/player/';

// ---------- The API ----------
async function getJson(url, user) {
  let r;
  try { r = await fetch(url); }
  catch { throw new Error('Could not reach Chess.com. Check your connection and try again.'); }
  if (r.status === 404) throw new Error(`No Chess.com player called "${user}".`);
  if (r.status === 429) throw new Error('Chess.com is asking us to slow down. Wait a minute and try again.');
  if (!r.ok) throw new Error('Chess.com did not respond. Try again in a minute.');
  return r.json();
}
const archiveCache = new Map();              // username -> list of months
const monthCache = new Map();                // "username/2026-10" -> games

// The months in which the player has games, oldest first: [{ key: '2026-10', year, month, url }]
export async function fetchArchives(user, force) {
  const u = user.toLowerCase();
  if (!force && archiveCache.has(u)) return archiveCache.get(u);
  const data = await getJson(`${API}${encodeURIComponent(u)}/games/archives`, user);
  const list = (data.archives || []).map(url => {
    const m = url.match(/(\d{4})\/(\d{2})$/);
    return m ? { key: `${m[1]}-${m[2]}`, year: +m[1], month: +m[2], url } : null;
  }).filter(Boolean).sort((a, b) => a.key.localeCompare(b.key));
  archiveCache.set(u, list);
  return list;
}
// One month of standard chess games, newest first, in the simple shape the list needs.
export async function fetchMonth(user, archive, force) {
  const u = user.toLowerCase(), id = u + '/' + archive.key;
  if (!force && monthCache.has(id)) return monthCache.get(id);
  const data = await getJson(archive.url, user);
  const all = data.games || [];
  const games = all.filter(g => g.rules === 'chess' && g.pgn && g.white && g.black).map(g => {
    const meWhite = (g.white.username || '').toLowerCase() === u;
    const mine = meWhite ? g.white : g.black, opp = meWhite ? g.black : g.white;
    return {
      url: g.url, pgn: g.pgn, end: (g.end_time || 0) * 1000, monthKey: archive.key,
      timeClass: g.time_class || '', timeControl: g.time_control || '',
      color: meWhite ? 'w' : 'b',
      result: mine.result === 'win' ? 'win' : opp.result === 'win' ? 'loss' : 'draw',
      opp: opp.username || '?', oppRating: opp.rating || '', myRating: mine.rating || ''
    };
  }).sort((a, b) => b.end - a.end);
  games.otherKinds = all.length - games.length;            // variants (960, bughouse...) that were left out
  monthCache.set(id, games);
  return games;
}
export const fetchStats = user => getJson(`${API}${encodeURIComponent(user.toLowerCase())}/stats`, user);
// The id at the end of a game's address, e.g. "live-123456" (used in links to a game).
export const shortId = url => { const m = String(url).match(/\/(live|daily)\/(\d+)/); return m ? m[1] + '-' + m[2] : ''; };

// ---------- Dates (always the viewer's own time zone) ----------
const pad = n => String(n).padStart(2, '0');
const dayKey = ms => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const dayLabel = ms => new Date(ms).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
const timeLabel = ms => new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
export const monthLabel = a => new Date(a.year, a.month - 1, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
function controlLabel(tc) {
  if (/^\d+\/\d+$/.test(tc)) { const d = +tc.split('/')[1] / 86400; return (d >= 1 ? count(Math.round(d), 'day', 'days') : 'daily') + ' a move'; }
  const [base, inc] = tc.split('+').map(Number);
  if (!base) return '';
  const mins = base >= 60 ? (base / 60) + ' min' : base + ' sec';
  return inc ? `${mins} +${inc}` : mins;
}

// ---------- The list ----------
const RESULT = { win: 'Won', loss: 'Lost', draw: 'Draw' };
let S = null;        // { user, archives, at (index into archives), games }
let hooks = {};      // { onOpen(game, user), onBatch(games, user), reviewed() -> Map(id -> record), onUser(user) }
let loadId = 0;

export function initGames(h) {
  hooks = h;
  $('prevMonth').onclick = () => showMonth(S.at - 1);
  $('nextMonth').onclick = () => showMonth(S.at + 1);
  $('monthSel').onchange = () => showMonth(+$('monthSel').value);
  $('refreshMonth').onclick = () => showMonth(S.at, true);
  for (const id of ['fTime', 'fColor', 'fResult']) $(id).onchange = renderList;
  $('fOpp').oninput = renderList;
  $('daySel').onchange = () => {
    const group = document.querySelector(`#games [data-day="${$('daySel').value}"]`);
    // Done in a few steps: days that were off screen only get their real height once they are scrolled near.
    for (let k = 0; group && k < 4; k++) $('games').scrollTop += group.getBoundingClientRect().top - $('games').getBoundingClientRect().top;
    $('daySel').value = '';
  };
  $('games').onclick = e => {
    const clear = e.target.closest('[data-clear]');
    if (clear) { clearFilters(); return; }
    const older = e.target.closest('[data-older]');
    if (older) { showMonth(S.at - 1); return; }
    const batch = e.target.closest('[data-batch]');
    if (batch) { hooks.onBatch(visibleGames().filter(g => dayKey(g.end) === batch.dataset.batch), S.user); return; }
    const row = e.target.closest('[data-i]');
    if (row) hooks.onOpen(S.games[+row.dataset.i], S.user);
  };
}
function setMsg(text, isError) {
  $('loadMsg').textContent = text;
  $('loadMsg').className = isError ? 'error' : 'muted';
}
// Loads a player: the list of months, then the newest month.
export async function loadPlayer(user, wantKey) {
  const id = ++loadId;
  S = null;
  $('monthBar').hidden = true;
  $('games').textContent = '';
  $('listInfo').textContent = '';
  setMsg('Fetching games from Chess.com…');
  let archives;
  try { archives = await fetchArchives(user, true); }
  catch (err) { if (id === loadId) setMsg(err.message, true); return false; }
  if (id !== loadId) return false;
  hooks.onUser(user);
  if (!archives.length) { setMsg(`${user} has not played any games on Chess.com yet.`); return false; }
  S = { user, archives, at: archives.length - 1, games: [] };
  $('monthSel').innerHTML = archives.map((a, i) => `<option value="${i}">${esc(monthLabel(a))}</option>`).reverse().join('');
  $('monthBar').hidden = false;
  const want = wantKey ? archives.findIndex(a => a.key === wantKey) : -1;
  await showMonth(want >= 0 ? want : archives.length - 1);
  return true;
}
async function showMonth(at, force) {
  if (!S || at < 0 || at >= S.archives.length) return;
  const id = ++loadId;
  S.at = at;
  const a = S.archives[at];
  $('monthSel').value = at;
  $('prevMonth').disabled = at === 0;
  $('nextMonth').disabled = at === S.archives.length - 1;
  setMsg(`Fetching ${monthLabel(a)}…`);
  let games;
  try { games = await fetchMonth(S.user, a, force); }
  catch (err) { if (id === loadId) { setMsg(err.message, true); $('games').textContent = ''; } return; }
  if (id !== loadId) return;               // the player moved on to another month while this one loaded
  S.games = games;
  setMsg('');
  renderList();
  $('games').scrollTop = 0;
}
function clearFilters() {
  $('fTime').value = $('fColor').value = $('fResult').value = $('fOpp').value = '';
  renderList();
}
function visibleGames() {
  const time = $('fTime').value, color = $('fColor').value, result = $('fResult').value;
  const opp = $('fOpp').value.trim().toLowerCase();
  return S.games.filter(g => (!time || g.timeClass === time) && (!color || g.color === color)
    && (!result || g.result === result) && (!opp || g.opp.toLowerCase().includes(opp)));
}
// Redraws the list for the current month and filters. Also called after a review is saved.
export function renderList() {
  if (!S) return;
  const a = S.archives[S.at], list = $('games'), month = monthLabel(a);
  const shown = visibleGames(), reviewed = hooks.reviewed();
  if (!S.games.length) {
    list.innerHTML = `<p class="empty">No standard chess games in ${esc(month)}`
      + (S.games.otherKinds ? ` (only ${count(S.games.otherKinds, 'game', 'games')} of other kinds, such as Chess960, which this site does not review)` : '') + '.'
      + (S.at > 0 ? ' <button type="button" data-older="1">Go to the month before</button>' : '') + '</p>';
    $('listInfo').textContent = '';
    $('daySel').innerHTML = '<option value="">Jump to a date</option>';
    return;
  }
  const days = new Map();                    // local date -> games, newest day first
  shown.forEach(g => { const k = dayKey(g.end); if (!days.has(k)) days.set(k, []); days.get(k).push(g); });
  const totals = {};
  S.games.forEach(g => { const k = dayKey(g.end); totals[k] = (totals[k] || 0) + 1; });
  const index = new Map(S.games.map((g, i) => [g, i]));
  let html = '', done = 0;
  for (const [k, games] of days) {
    const n = games.length === totals[k] ? count(games.length, 'game', 'games') : `${games.length} of ${totals[k]} games`;
    html += `<section class="day" data-day="${k}"><h3><span>${esc(dayLabel(games[0].end))} · ${n}</span>`
      + `<button type="button" class="small" data-batch="${k}" title="Analyse every game listed for this day, one after another">Review all</button></h3>`;
    for (const g of games) {
      const rec = reviewed.get(g.url);
      if (rec) done++;
      html += `<button type="button" class="game" data-i="${index.get(g)}">`
        + `<span class="res ${g.result}">${RESULT[g.result]}</span>`
        + `<span class="who"><i class="side ${g.color}" title="${g.color === 'w' ? 'You had White' : 'You had Black'}"></i>${esc(g.opp)} <small>(${esc(g.oppRating)})</small></span>`
        + `<span class="meta">${esc(g.timeClass)} · ${esc(controlLabel(g.timeControl))} · ${esc(timeLabel(g.end))}</span>`
        + (rec ? `<span class="rev" title="Already reviewed">✓${rec.acc != null ? ' ' + Math.round(rec.acc) + '%' : ''}</span>` : '')
        + '</button>';
    }
    html += '</section>';
  }
  if (!shown.length) html = '<p class="empty">No games match these filters. <button type="button" data-clear="1">Clear the filters</button></p>';
  list.innerHTML = html;
  $('listInfo').textContent = `${count(S.games.length, 'game', 'games')} in ${month}`
    + (shown.length !== S.games.length ? `, ${shown.length} shown` : '') + (done ? ` · ${done} reviewed` : '')
    + '. Dates and times are in your own time zone.';
  $('daySel').innerHTML = '<option value="">Jump to a date</option>'
    + [...days].map(([k, games]) => `<option value="${k}">${esc(dayLabel(games[0].end))} (${games.length})</option>`).join('');
}
// For a link to one game: finds it in its month. Returns the game or null.
export async function findGame(user, monthKey, id) {
  const archives = await fetchArchives(user);
  const a = archives.find(x => x.key === monthKey);
  if (!a) return null;
  return (await fetchMonth(user, a)).find(g => shortId(g.url) === id) || null;
}
export const currentMonthKey = () => (S ? S.archives[S.at].key : '');
