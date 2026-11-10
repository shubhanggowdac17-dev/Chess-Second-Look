// The Progress tab (habits and a chart across reviewed games) and the Friends tab.

import { $, esc, count, PIECE_NAME, lsGet, lsSet } from './util.js';
import { TAGS } from './analysis.js';
import { MOTIF_NAME } from './tactics.js';
import * as store from './store.js';
import { fetchStats, fetchArchives, fetchMonth } from './games.js';

let ctx = {};        // { onHistoryChange() }

export function initProgress(c) {
  ctx = c;
  $('exportBtn').onclick = exportHistory;
  $('importBtn').onclick = () => $('importFile').click();
  $('importFile').onchange = importHistory;
  $('clearBtn').onclick = () => {
    if (!confirm('Delete all saved games from this browser?')) return;
    store.storeHistory([]);
    changed('History cleared.');
  };
  $('friendForm').onsubmit = e => { e.preventDefault(); compareFriends(); };
  $('friendNames').value = lsGet('cc-friends', []).join(', ');
}
function changed(msg) {
  $('historyMsg').textContent = msg;
  renderProgress();
  ctx.onHistoryChange();
}
export function renderProgress() { renderChart(); renderPatterns(); }

// ---------- Backup ----------
function exportHistory() {
  const blob = new Blob([JSON.stringify(store.loadHistory())], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'second-look-history.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
async function importHistory(e) {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (!Array.isArray(data)) throw new Error('not a backup');
    const added = store.mergeHistory(data);
    changed(`Backup imported: ${count(added, 'new game', 'new games')}.`);
  } catch {
    $('historyMsg').textContent = 'That file is not a backup from this site.';
  }
  e.target.value = '';
}

// ---------- Progress chart: accuracy and blunders, game by game ----------
const blunders = r => r.mistakes.filter(m => m.kind === 'blunder').length;
const avg = list => (list.length ? list.reduce((s, x) => s + x, 0) / list.length : null);
function renderChart() {
  const el = $('progress');
  const hist = store.loadHistory().slice().sort((a, b) => (a.date || '').localeCompare(b.date || '') || (a.saved || 0) - (b.saved || 0));
  if (hist.length < 2) {
    el.innerHTML = '<p class="muted">Review at least two of your own games and a chart of your accuracy and blunders appears here.</p>';
    return;
  }
  const n = hist.length, W = 600, H = 220, L = 34, R = 26, T = 10, B = 26;
  const x = i => L + (n === 1 ? 0 : i / (n - 1)) * (W - L - R);
  const withAcc = hist.filter(r => r.acc != null);
  const lo = Math.max(0, Math.floor((Math.min(100, ...withAcc.map(r => r.acc)) - 5) / 10) * 10);
  const y = acc => T + (100 - acc) / (100 - lo) * (H - T - B);
  const maxB = Math.max(3, ...hist.map(blunders));
  const bw = Math.max(3, Math.min(18, (W - L - R) / n * 0.5));
  let bars = '', dots = '', path = '', pen = false;
  hist.forEach((r, i) => {
    const b = blunders(r), bh = b / maxB * (H - T - B) * 0.45;
    const tip = `${r.date || ''} vs ${r.opp || '?'}: ${r.acc != null ? r.acc.toFixed(1) + '% accuracy, ' : ''}${count(b, 'blunder', 'blunders')}`;
    bars += `<rect class="p-bar" x="${(x(i) - bw / 2).toFixed(1)}" y="${(H - B - bh).toFixed(1)}" width="${bw.toFixed(1)}" height="${bh.toFixed(1)}"><title>${esc(tip)}</title></rect>`;
    if (r.acc == null) { pen = false; return; }
    path += `${pen ? 'L' : 'M'}${x(i).toFixed(1)},${y(r.acc).toFixed(1)} `;
    pen = true;
    dots += `<circle class="p-dot ${r.result}" cx="${x(i).toFixed(1)}" cy="${y(r.acc).toFixed(1)}" r="3.5"><title>${esc(tip)}</title></circle>`;
  });
  let grid = '';
  for (let v = lo; v <= 100; v += (100 - lo) / 4) {
    grid += `<line class="p-grid" x1="${L}" x2="${W - R}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"/>`
      + `<text class="p-text" x="${L - 5}" y="${(y(v) + 4).toFixed(1)}" text-anchor="end">${Math.round(v)}%</text>`;
  }
  const first = hist[0].date || '', last = hist[n - 1].date || '';
  const recent = hist.slice(-5), earlier = hist.slice(-10, -5);
  const line = (label, list) => {
    const a = avg(list.filter(r => r.acc != null).map(r => r.acc));
    return `<b>${label}:</b> ${a != null ? a.toFixed(1) + '% accuracy, ' : ''}${avg(list.map(blunders)).toFixed(1)} blunders a game`;
  };
  el.innerHTML = `<p>${line('Last ' + count(recent.length, 'game', 'games'), recent)}`
    + (earlier.length ? `<br>${line('The ' + count(earlier.length, 'game', 'games') + ' before', earlier)}` : '') + '</p>'
    + `<div class="chart tall"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Accuracy and blunders in each reviewed game">${grid}${bars}`
    + `<path class="p-line" d="${path}"/>${dots}`
    + `<text class="p-text" x="${L}" y="${H - 6}">${esc(first)}</text><text class="p-text" x="${W - R}" y="${H - 6}" text-anchor="end">${esc(last)}</text>`
    + `</svg></div><p class="muted small"><span class="key-line"></span> accuracy in each game (dot colour: green won, red lost, grey drawn) `
    + `&nbsp; <span class="key-bar"></span> blunders in that game (tallest bar = ${maxB}). Oldest game on the left.`
    + (withAcc.length < n ? ' Games reviewed with the first version of the site have no accuracy figure; review them again to fill the gap.' : '') + '</p>';
}

// ---------- My patterns ----------
function renderPatterns() {
  const hist = store.loadHistory(), el = $('patterns');
  if (!hist.length) {
    el.innerHTML = '<p class="muted">No games saved yet. Type your Chess.com username on the Games tab and review a game.</p>';
    return;
  }
  const t = store.tallyHistory(hist);
  let h = `<p>${count(t.games, 'game', 'games')} saved in this browser, with `
    + `${count(t.slips, 'flagged move', 'flagged moves')} of yours.`
    + (t.games < 10 ? ' Patterns become reliable after about 10 games.' : '') + '</p>';
  const tags = Object.entries(t.tag).sort((a, b) => b[1] - a[1]);
  if (tags.length) {
    h += '<h3>Your most common slips</h3><ol>' + tags.map(([k, n]) =>
      `<li><b>${(TAGS[k] || TAGS.positional).label}</b>: ${count(n, 'time', 'times')}, in ${t.tagGames[k]} of ${t.games} games</li>`
    ).join('') + '</ol>';
    const motifs = Object.entries(t.motif).sort((a, b) => b[1] - a[1]);
    if (motifs.length) h += '<p><b>Tactics behind them:</b> ' + motifs.map(([k, n]) => `${(MOTIF_NAME[k] || k).toLowerCase()} (${n})`).join(', ') + '</p>';
    h += '<p><b>Stage of the game:</b> ' + ['opening', 'middlegame', 'endgame']
      .map(p => `${p} ${t.phase[p] || 0}`).join(' · ') + '</p>';
    const pieces = Object.entries(t.piece).sort((a, b) => b[1] - a[1]).slice(0, 3);
    h += '<p><b>Pieces you slip with most:</b> ' + pieces.map(([k, n]) => `${PIECE_NAME[k] || k} (${n})`).join(', ') + '</p>';
    if (t.clocked) h += `<p><b>Short of time:</b> ${t.low} of ${t.clocked} slips came with under 10% of your clock left.</p>`;
  }
  const ops = Object.entries(t.openings).sort((a, b) => b[1].games - a[1].games).slice(0, 6);
  h += '<h3>Your openings</h3><div class="scrollx"><table><tr><th>Opening</th><th>Games</th><th>Won</th><th>Drawn</th><th>Lost</th><th>Slips per game</th></tr>'
    + ops.map(([name, o]) => `<tr><td>${esc(name)}</td><td>${o.games}</td><td>${o.win}</td><td>${o.draw}</td>`
      + `<td>${o.loss}</td><td>${(o.slips / o.games).toFixed(1)}</td></tr>`).join('') + '</table></div>';
  el.innerHTML = h;
}

// ---------- Friends ----------
const KINDS = [['chess_rapid', 'Rapid'], ['chess_blitz', 'Blitz'], ['chess_bullet', 'Bullet'], ['chess_daily', 'Daily']];
let friendRun = 0;
async function compareFriends() {
  const run = ++friendRun;
  const typed = $('friendNames').value.split(/[\s,;]+/).map(s => s.trim()).filter(Boolean);
  const me = store.getUser();
  const names = [...new Map([...(me ? [me] : []), ...typed].map(n => [n.toLowerCase(), n])).values()].slice(0, 12);
  if (!names.length) { $('friendMsg').textContent = 'Type at least one username.'; return; }
  lsSet('cc-friends', typed);
  const rows = [];
  // One request at a time, as Chess.com asks of sites that use its public data.
  for (const [i, name] of names.entries()) {
    $('friendMsg').textContent = `Looking up ${name} (${i + 1} of ${names.length})…`;
    const row = { name, stats: null, form: [], last: 0, error: '' };
    try {
      row.stats = await fetchStats(name);
      const archives = await fetchArchives(name);
      if (archives.length) {
        const games = await fetchMonth(name, archives[archives.length - 1]);
        row.form = games.slice(0, 10).map(g => g.result);
        row.last = games.length ? games[0].end : 0;
      }
    } catch (err) { row.error = err.message; }
    if (run !== friendRun) return;
    rows.push(row);
    drawFriends(rows, me);
  }
  $('friendMsg').textContent = 'Ratings and results come straight from Chess.com and can be a few hours behind.';
}
function drawFriends(rows, me) {
  const top = {};
  for (const [k] of KINDS) top[k] = Math.max(0, ...rows.map(r => (r.stats && r.stats[k] && r.stats[k].last ? r.stats[k].last.rating : 0)));
  let h = '<table class="friends"><tr><th>Player</th>' + KINDS.map(([, label]) => `<th>${label}</th>`).join('')
    + '<th>Last 10 games <span class="muted">(newest first)</span></th><th>Last played</th></tr>';
  for (const r of rows) {
    h += `<tr><td><b>${esc(r.name)}</b>${me && r.name.toLowerCase() === me.toLowerCase() ? ' <span class="muted">(you)</span>' : ''}</td>`;
    if (r.error) { h += `<td colspan="6" class="error">${esc(r.error)}</td></tr>`; continue; }
    for (const [k] of KINDS) {
      const s = r.stats[k];
      if (!s || !s.last) { h += '<td class="muted">–</td>'; continue; }
      const rec = s.record || {};
      h += `<td${s.last.rating === top[k] && rows.length > 1 ? ' class="top"' : ''}><b>${s.last.rating}</b>`
        + (s.best ? `<br><span class="muted small">best ${s.best.rating}</span>` : '')
        + (rec.win != null ? `<br><span class="muted small">${rec.win}W ${rec.draw || 0}D ${rec.loss}L</span>` : '') + '</td>';
    }
    h += '<td>' + (r.form.length ? r.form.map(x => `<i class="form ${x}" title="${x}">${x === 'win' ? 'W' : x === 'loss' ? 'L' : 'D'}</i>`).join('') : '<span class="muted">no games this month</span>') + '</td>';
    h += `<td>${r.last ? esc(new Date(r.last).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })) : '–'}</td></tr>`;
  }
  $('friends').innerHTML = h + '</table>';
}
