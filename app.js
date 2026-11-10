// Second Look: the page itself. This file wires the tabs together and runs the Review tab.
//   games.js     fetching games and the month-by-month list
//   analysis.js  move labels, accuracy, explanations (no page code)
//   tactics.js   naming forks, pins and the rest
//   engine.js    Stockfish
//   board.js     the board you can move pieces on
//   train.js     guess-the-move and practice
//   progress.js  patterns, progress chart, friends
//   store.js     everything saved in the browser

import { $, esc, cap, count, lsGetText, lsSetText } from './util.js';
import { getEngine, ENGINE_FILE } from './engine.js';
import { Board } from './board.js';
import * as A from './analysis.js';
import { LABELS, isSlip, chances, fmt, describe } from './analysis.js';
import { MOTIF_NAME } from './tactics.js';
import * as store from './store.js';
import { settings, saveSettings } from './store.js';
import { initGames, loadPlayer, renderList, findGame, shortId } from './games.js';
import { initTrain, startGuess, renderTrainHome } from './train.js';
import { initProgress, renderProgress } from './progress.js';
import { playMoveSound } from './sound.js';

// ---------- Settings ----------
const VOICE_SPEED = 0.95;                    // 1 = normal speaking speed
const HABIT_AFTER = 2;                       // a type of slip counts as a habit after this many earlier times
const LIVE_DEPTH = 16;                       // how deep the engine looks while you try your own moves
const LIVE_LINES = 3;                        // "Engine lines" shows this many moves

let G = null;        // the game being reviewed
let ply = 0;         // position being shown (0 = start)
let flipped = false;
let X = null;        // your own line while trying moves: { base: ply it started from, line: [{ san, from, to, fen }] }
let live = null;     // the live engine look at the position on the board: { fen, lines, job }

// ---------- Tabs ----------
export function showTab(name) {
  for (const b of $('tabs').children) b.classList.toggle('active', b.dataset.tab === name);
  for (const t of document.querySelectorAll('.tab')) t.hidden = t.id !== 'tab-' + name;
  if (name === 'progress') renderProgress();
  if (name === 'practice') renderTrainHome();
  if (name !== 'review' && synth) synth.cancel();
}
$('tabs').onclick = e => { if (e.target.dataset.tab) showTab(e.target.dataset.tab); };

// ---------- Whose games are these? ----------
// Reviews are added to "my" history only for the player's own account, so that looking through
// a friend's games does not mix their mistakes into your patterns.
const myUser = () => store.getUser();
const isMe = user => !!user && user.toLowerCase() === myUser().toLowerCase();
let typedByPlayer = false;                   // true when the username came from the form, not from a link
function noteUser(user) {
  if (!myUser() && typedByPlayer) store.setUser(user);       // the first username typed here is taken to be the player's own
  typedByPlayer = false;
  const el = $('whoNote');
  el.hidden = isMe(user);
  if (!isMe(user)) {
    el.innerHTML = `Looking at <b>${esc(user)}</b>'s games. Reviews are saved to your history only for your own account`
      + (myUser() ? ` (<b>${esc(myUser())}</b>). ` : '. ')
      + `<button type="button" class="small" id="makeMe">${esc(user)} is my account</button>`;
    $('makeMe').onclick = () => { store.setUser(user); noteUser(user); };
  }
}

// ---------- Opening a game ----------
// opts.user: whose game it is (username).  opts.source: { user, monthKey, url } for games from Chess.com.
function openGame(pgn, opts = {}) {
  const user = opts.user != null ? opts.user : myUser();
  const g = A.parseGame(pgn, user);          // throws a readable Error if the PGN is bad
  if (synth) synth.cancel();
  G = g;
  G.source = opts.source || null;
  G.own = opts.pasted || isMe(user);         // may this review go into my history?
  G.prior = store.tallyHistory(store.loadHistory().filter(rec => rec.id !== G.id));
  ply = 0; X = null;
  flipped = G.me === 'b';
  renderPlayers();
  $('noGame').hidden = true;
  $('review').hidden = false;
  $('report').hidden = true;
  $('coach').textContent = '';
  $('shareBtn').hidden = !(G.source && shortId(G.source.url));
  $('shareMsg').textContent = '';
  showTab('review');
  setStatus('Getting ready…');
  render();
  startAnalysis();
  $('tabs').scrollIntoView({ block: 'start' });
}
function renderPlayers() {
  const h = G.headers;
  const name = side => esc(h[side] || side) + (h[side + 'Elo'] ? ` (${esc(h[side + 'Elo'])})` : '');
  $('players').innerHTML = `<b>${name('White')}</b> vs <b>${name('Black')}</b>`
    + (h.Result ? ` · ${esc(h.Result)}` : '')
    + `<br><span class="muted">${esc(G.opening.name)}</span>`;
}

// ---------- Analysis ----------
let runId = 0, runJob = null;
function setStatus(text, isError) {
  $('status').textContent = text;
  $('status').className = isError ? 'error' : 'muted';
}
async function startAnalysis() {
  const id = ++runId, g = G, depth = +$('depth').value;
  if (runJob) runJob.cancel();
  Object.assign(g, { ev: [], best: [], pv: [], alt: [], labels: [], tags: [], notes: [], drops: [], acc: null, keys: [], done: false });
  $('prog').value = 0;
  $('report').hidden = true;
  $('coach').textContent = '';

  // A game analysed before (at this depth or deeper) opens straight away.
  const saved = await store.getAnalysis(g.id);
  if (id !== runId) return;
  if (saved && saved.depth >= depth && await A.unpackAnalysis(g, saved)) {
    if (id !== runId) return;
    $('prog').value = 1;
    return analysisDone('Opened from your saved analysis.');
  }
  setStatus('Starting the engine…');
  let eng;
  try { eng = await getEngine(); }
  catch {
    if (id === runId) setStatus('The engine could not start. Check that ' + ENGINE_FILE +
      ' and its .wasm file are in the same folder as this page.', true);
    return;
  }
  if (id !== runId) return;
  const ok = await A.analyseGame(g, eng, depth, {
    cancelled: () => id !== runId,
    onJob: job => { runJob = job; },
    onProgress: i => {
      $('prog').value = (i + 1) / g.fens.length;
      setStatus(`Analysing move ${i} of ${g.fens.length - 1}…`);
      renderMoves();
      if (!X && i === ply) render();           // the move on the board just got its label
    }
  });
  if (!ok || id !== runId) return;
  store.putAnalysis(A.packAnalysis(g));
  analysisDone('Analysis complete.');
}
function analysisDone(done) {
  renderPlayers();                           // the opening name may have come from the openings list
  render();
  renderReport();
  if (!G.me) {
    setStatus(done);
    askSide();
    return;
  }
  if (!G.own) { setStatus(done + ' Not added to your history, because this is not your own account.'); offerQuiz(); return; }
  const ok = store.saveToHistory(A.historyRecord(G));
  renderList();
  setStatus(ok ? done + ' Saved to your history.' : done + ' The browser refused to save it to your history.', !ok);
  const rep = repeatNote();
  offerQuiz(rep);
  if (rep && voiceOn) speak(rep);
}
// For a pasted game where neither name matches the player's username.
function askSide() {
  $('coach').innerHTML = `<div class="ask"><p><b>Which side were you?</b> Say so and the review is added to your history.</p>
    <div class="row"><button type="button" data-side="w">I was White</button><button type="button" data-side="b">I was Black</button>
    <button type="button" data-side="">Neither</button></div></div>`;
  $('coach').onclick = e => {
    const side = e.target.dataset.side;
    if (side === undefined) return;
    $('coach').onclick = null;
    $('coach').textContent = '';
    if (!side) return;
    G.me = side; G.own = true; G.notes = [];
    flipped = side === 'b';
    analysisDone('Thanks.');
  };
}
// "Ask before telling": offer to quiz the player on their own mistakes before showing the answers.
function offerQuiz(extra) {
  const mine = G.labels.filter((l, i) => isSlip(l) && l !== 'inaccuracy' && G.moves[i].color === G.me).length;
  let h = extra ? `<p><b>${esc(extra)}</b></p>` : '';
  if (mine) {
    const name = G.headers[G.me === 'w' ? 'White' : 'Black'] || 'This player';
    h += `<div class="ask"><p><b>Before I show you the answers:</b> ${G.own ? 'you' : esc(name)} went wrong in ${count(mine, 'place', 'places')}. `
      + `${G.own ? `Want to try ${mine === 1 ? 'it' : 'them'} again first?` : 'Can you find better moves?'}</p>
      <div class="row"><button type="button" class="primary" id="quizBtn">Guess the move</button></div></div>`;
  }
  $('coach').innerHTML = h;
  if (mine) $('quizBtn').onclick = () => startGuess(G);
}
function repeatNote() {                      // compares this game with the earlier ones
  const here = {};
  G.labels.forEach((k, i) => {
    if (isSlip(k) && G.moves[i].color === G.me) { const t = G.tags[i] || 'positional'; here[t] = (here[t] || 0) + 1; }
  });
  const prior = G.prior.tag;
  const repeats = Object.keys(here).filter(k => (prior[k] || 0) >= HABIT_AFTER).sort((a, b) => prior[b] - prior[a]);
  if (!repeats.length) return '';
  const k = repeats[0];
  return `Seen before: ${A.TAGS[k].ing} happened ${count(here[k], 'time', 'times')} in this game, and `
    + `${count(prior[k], 'time', 'times')} in your ${count(G.prior.games, 'earlier game', 'earlier games')}.`;
}

// ---------- The board ----------
const board = new Board($('board'), { onMove: tryMove });

function renderBoard() {
  let e;
  if (X) {
    const at = lineEnd(), now = liveFor(at.fen);
    const reply = now ? now.lines[0].pv[0] : null;
    board.set({ fen: at.fen, orientation: flipped ? 'b' : 'w', movable: true, lastMove: at,
      arrows: reply ? [{ from: reply.slice(0, 2), to: reply.slice(2, 4), color: 'blue' }] : [] });
    e = now ? now.ev : null;
  } else {
    const mv = ply > 0 ? G.moves[ply - 1] : null;
    const label = ply > 0 ? G.labels[ply - 1] : null;
    const best = isSlip(label) ? G.best[ply - 1] : null;
    board.set({ fen: G.fens[ply], orientation: flipped ? 'b' : 'w', movable: true, lastMove: mv,
      tone: isSlip(label) ? label : null,
      badge: label && mv ? { square: mv.to, label, sym: LABELS[label].sym } : null,
      arrows: best ? [{ from: best.slice(0, 2), to: best.slice(2, 4), color: 'green' }] : [] });
    e = G.ev[ply];
  }
  setBar(e);
}

// ---------- Trying your own moves ----------
function tryMove(mv) {
  if (!X) X = { base: ply, line: [] };
  X.line.push({ san: mv.san, from: mv.from, to: mv.to, fen: mv.after, color: mv.color, captured: mv.captured });
  if (synth) synth.cancel();
  playMoveSound(mv);
  render();
}
function leaveLine() { X = null; render(); }
function undoLineMove() { X.line.pop(); if (!X.line.length) X = null; render(); }
function playReply() {
  const now = liveFor(lineEnd().fen);
  if (!now) return;
  const u = now.lines[0].pv[0];
  board.commit(u.slice(0, 2), u.slice(2, 4), u[4]);
}
const lineEnd = () => X.line[X.line.length - 1];
const liveFor = fen => (live && live.fen === fen && live.lines ? live : null);
function renderLineInfo() {
  const at = lineEnd(), start = G.fens[X.base];
  let n = A.moveNumber(start), white = start.split(' ')[1] === 'w', text = white ? '' : n + '… ';
  for (const m of X.line) { text += (white ? n + '. ' : '') + m.san + ' '; if (!white) n++; white = !white; }
  const over = A.terminal(at.fen);
  $('info').innerHTML = `<h3>Trying your own line</h3><p class="line">${esc(text.trim())}</p><div id="lineEval"></div>`
    + `<div class="row"><button type="button" class="primary" id="lineBack">Back to the game</button>`
    + `<button type="button" id="lineUndo">Undo</button>`
    + (over ? '' : `<button type="button" id="lineReply">Play the best reply</button>`) + '</div>';
  $('lineBack').onclick = leaveLine;
  $('lineUndo').onclick = undoLineMove;
  if (!over) $('lineReply').onclick = playReply;
  renderLineEval();
}
// The part of the panel that changes while the engine thinks. The buttons above are left alone,
// so a tap on one is never lost to a redraw.
function renderLineEval() {
  const el = $('lineEval'), at = lineEnd(), over = A.terminal(at.fen), now = liveFor(at.fen);
  if (!el) return;
  if (over) el.innerHTML = `<p><b>${over.winner ? 'Checkmate.' : 'A draw: neither side can win from here.'}</b></p>`;
  else if (now) {
    const turn = at.fen.split(' ')[1] === 'w' ? 'White' : 'Black';
    const reply = A.sanLine(at.fen, now.lines[0].pv, 1)[0];
    el.innerHTML = `<p>Evaluation: <b>${fmt(now.ev)}</b>, ${esc(describe(now.ev))}. <span class="muted">(depth ${now.lines[0].depth})</span></p>`
      + (reply ? `<p>Best reply for ${turn}: <b>${esc(reply)}</b> (blue arrow).</p>` : '');
  } else el.innerHTML = '<p class="muted">Thinking…</p>';
}
function setBar(e) {
  $('barFill').style.height = (e ? chances(e, 'w') : 50) + '%';
  $('bar').classList.toggle('flip', flipped);
}

// ---------- The live engine (your own line, and "Engine lines") ----------
function updateLive() {
  const fen = X ? X.line[X.line.length - 1].fen : G.fens[ply];
  const wanted = X || settings.lines;
  if (live && live.fen === fen && wanted) return;
  if (live && live.job) live.job.cancel();
  live = null;
  if (!wanted || A.terminal(fen)) return;
  const mine = live = { fen, lines: null, ev: null, job: null };
  getEngine().then(eng => {
    if (live !== mine) return;
    mine.job = eng.analyse(fen, { depth: LIVE_DEPTH, multipv: settings.lines ? LIVE_LINES : 1, urgent: true,
      onInfo: lines => {
        if (live !== mine || !lines[0]) return;
        mine.lines = lines.map(l => ({ ...l }));
        mine.ev = A.toWhite(lines[0], fen);
        if (X) {
          const u = lines[0].pv[0];
          board.setArrows([{ from: u.slice(0, 2), to: u.slice(2, 4), color: 'blue' }]);
          setBar(mine.ev);
          renderLineEval();
        }
        renderLines();
      } });
  }).catch(() => {});
}
function renderLines() {
  const el = $('lines');
  if (!settings.lines) { el.textContent = ''; return; }
  const fen = X ? X.line[X.line.length - 1].fen : G.fens[ply];
  if (A.terminal(fen)) { el.innerHTML = '<p class="muted">The game is over in this position.</p>'; return; }
  if (!live || live.fen !== fen || !live.lines) { el.innerHTML = '<p class="muted">Engine lines: thinking…</p>'; return; }
  el.innerHTML = `<p class="muted small">The engine's best moves here (depth ${live.lines[0].depth}):</p><ol class="pvs">`
    + live.lines.map(l => `<li><b>${fmt(A.toWhite(l, fen))}</b> ${esc(A.sanLine(fen, l.pv, 7).join(' '))}</li>`).join('') + '</ol>';
}

// ---------- The move list ----------
function renderMoves() {
  const el = $('moves');
  if (el._game !== G) {                       // build the list once per game
    el._game = G;
    el.textContent = '';
    G.moves.forEach((m, i) => {
      if (m.color === 'w' || i === 0) {
        const n = document.createElement('span');
        n.className = 'num';
        n.textContent = A.moveNumber(G.fens[i]) + '.';
        el.append(n);
        if (m.color === 'b') el.append(document.createElement('span'));
      }
      const b = document.createElement('button');
      b.type = 'button';
      b.onclick = () => go(i + 1);
      el.append(b);
    });
  }
  el.querySelectorAll('button').forEach((b, i) => {   // after that, only update labels and colours
    const label = G.labels[i];
    const text = G.moves[i].san + (A.SUFFIX[label] || '');
    const cls = (label ? 'l-' + label : '') + (i + 1 === ply && !X ? ' active' : '');
    if (b.textContent !== text) b.textContent = text;
    if (b.className !== cls) b.className = cls;
    if (label) b.title = LABELS[label].name;
  });
}

// ---------- The coach's words about the move on the board ----------
// How often you made this type of slip in earlier games (0 for the opponent's moves).
function habitCount(i) {
  const tag = G.tags[i];
  return tag && G.own && G.moves[i].color === G.me ? (G.prior.tag[tag] || 0) : 0;
}
const betterLine = i => A.sanLine(G.fens[i], G.pv[i]);                                  // what should have been played
const bestReply = i => A.sanLine(G.fens[i + 1], (G.pv[i + 1] || []).slice(0, 1))[0];    // strongest answer to the move played
function renderInfo() {
  const el = $('info');
  if (X) return renderLineInfo();
  if (ply === 0) {
    el.innerHTML = '<p class="muted">Starting position. Step through with the buttons or the ← → keys. '
      + 'At any point you can move a piece on the board to try your own idea.</p>';
    return;
  }
  const i = ply - 1, m = G.moves[i], title = A.moveLabel(G, i);
  if (!G.ev[ply] || !G.labels[i]) {
    el.innerHTML = `<h3>${esc(title)}</h3><p class="muted">Not analysed yet.</p>`;
    return;
  }
  const label = G.labels[i], L = LABELS[label], note = A.explain(G, i);
  let h = `<h3 class="l-${label}"><span class="chip l-${label}">${L.sym}</span> ${esc(title)} · ${L.name}</h3>`;
  h += `<p>Evaluation after this move: <b>${fmt(G.ev[ply])}</b> <span class="muted">(${esc(describe(G.ev[ply]))})</span></p>`;
  if (isSlip(label)) {
    const line = betterLine(i), reply = bestReply(i), tag = G.tags[i], n = habitCount(i);
    h += `<p>Better was <b>${esc(line[0] || G.best[i] || '?')}</b> (green arrow).</p>`;
    h += note.lines.map(t => `<p>${esc(t)}</p>`).join('');
    if (line.length > 1) h += `<p class="muted">Likely continuation: ${esc(line.join(' '))}</p>`;
    if (reply) h += `<p>Strongest reply now: <b>${esc(reply)}</b></p>`;
    if (tag) h += `<p class="muted">Type: ${A.TAGS[tag].label}${note.motif ? ' · ' + MOTIF_NAME[note.motif] : ''}.`
      + (n >= HABIT_AFTER ? ` <b>A habit of yours: ${n} times in earlier games.</b>` : '') + '</p>';
    if (A.isLowTime(G, m)) h += `<p class="muted">Played with ${Math.round(m.clock)} seconds left on the clock.</p>`;
  } else if (label === 'book') {
    h += `<p class="muted">A known opening move${G.bookName ? ' (' + esc(G.bookName) + ')' : ''}.</p>`;
  } else {
    if (label === 'best') h += `<p class="muted">This was the engine's first choice.</p>`;
    h += note.lines.map(t => `<p>${esc(t)}</p>`).join('');
    if (label === 'good' || label === 'excellent') {
      const line = betterLine(i);
      if (line[0] && line[0] !== m.san) h += `<p class="muted">The engine slightly preferred ${esc(line[0])}.</p>`;
    }
  }
  el.innerHTML = h;
}

// ---------- The game report: accuracy, label counts, graph, key moments, clock ----------
function renderReport() {
  $('report').hidden = false;
  const n = A.countLabels(G), h = G.headers;
  const acc = c => (G.acc[c] == null ? '–' : G.acc[c].toFixed(1) + '%');
  let t = `<table class="counts"><tr><th></th><th>${esc(h.White || 'White')}</th><th>${esc(h.Black || 'Black')}</th></tr>`
    + `<tr class="accrow"><td>Accuracy</td><td><b>${acc('w')}</b></td><td><b>${acc('b')}</b></td></tr>`;
  for (const k of Object.keys(LABELS)) {
    if (k === 'book' && !G.book.length) continue;
    t += `<tr><td><span class="chip l-${k}">${LABELS[k].sym}</span> ${LABELS[k].name}</td><td>${n.w[k] || 0}</td><td>${n.b[k] || 0}</td></tr>`;
  }
  $('summary').innerHTML = t + '</table><p class="muted small">Accuracy is worked out the way lichess does it, from how much winning chance each move gave away. '
    + 'Chess.com uses its own private formula, so its number for the same game will differ a little.</p>';

  $('keysBox').hidden = !G.keys.length;
  $('keys').innerHTML = G.keys.map(k => {
    const m = G.moves[k.i], who = G.me && G.own ? (m.color === G.me ? 'You' : 'Opponent') : (m.color === 'w' ? 'White' : 'Black');
    const from = Math.round(chances(G.ev[k.i], m.color)), to = Math.round(chances(G.ev[k.i + 1], m.color));
    const what = isSlip(k.label) ? `winning chances fell from ${from}% to ${to}%`
      : k.label === 'brilliant' ? 'a sacrifice that works' : 'the only good move';
    return `<button type="button" class="key" data-ply="${k.i + 1}"><span class="chip l-${k.label}">${LABELS[k.label].sym}</span> `
      + `<b>${esc(A.moveLabel(G, k.i))}</b> · ${who}: ${LABELS[k.label].name.toLowerCase()}, ${what}</button>`;
  }).join('');
  renderGraph();
  renderClock();
}
$('keys').onclick = e => { const b = e.target.closest('[data-ply]'); if (b) { go(+b.dataset.ply); $('board').scrollIntoView({ block: 'center', behavior: 'smooth' }); } };

// White's winning chances across the game, as a filled line. Click or tap to jump to a move.
function renderGraph() {
  const n = G.fens.length - 1;
  if (!G.done || n < 1) { $('graph').textContent = ''; return; }
  const W = 600, H = 120, x = i => (i / n) * W, y = e => H - chances(e, 'w') / 100 * H;
  let d = `M0,${H} `;
  G.ev.forEach((e, i) => { d += `L${x(i).toFixed(1)},${y(e).toFixed(1)} `; });
  d += `L${W},${H} Z`;
  let dots = '';
  G.labels.forEach((label, i) => {
    if (isSlip(label) && label !== 'inaccuracy' || label === 'brilliant' || label === 'great') {
      dots += `<circle class="l-${label}" cx="${x(i + 1).toFixed(1)}" cy="${y(G.ev[i + 1]).toFixed(1)}" r="4"><title>${esc(A.moveLabel(G, i))} ${LABELS[label].name}</title></circle>`;
    }
  });
  $('graph').innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Winning chances across the game">`
    + `<rect class="g-black" width="${W}" height="${H}"/><path class="g-white" d="${d}"/>`
    + `<line class="g-mid" x1="0" y1="${H / 2}" x2="${W}" y2="${H / 2}"/>${dots}`
    + `<line class="g-now" id="graphNow" x1="0" y1="0" x2="0" y2="${H}"/></svg>`;
  markGraph();
}
function markGraph() {
  const n = G.fens.length - 1, now = $('graphNow');
  if (now) { const px = (ply / n) * 600; now.setAttribute('x1', px); now.setAttribute('x2', px); }
  const bar = document.querySelector('#clock .now');
  if (bar) bar.classList.remove('now');
  const cur = ply > 0 && document.querySelector(`#clock [data-ply="${ply}"]`);
  if (cur) cur.classList.add('now');
}
$('graph').onclick = e => {
  if (!G || !G.done) return;
  const box = $('graph').getBoundingClientRect();
  go(Math.round((e.clientX - box.left) / box.width * (G.fens.length - 1)));
};
// Seconds spent on each move: White's bars go up, Black's go down.
function renderClock() {
  const has = G.moves.some(m => m.spent != null);
  $('clockBox').hidden = !has;
  if (!has) return;
  const n = G.moves.length, W = 600, H = 120, mid = H / 2;
  const max = Math.max(5, ...G.moves.map(m => m.spent || 0));
  const bw = W / n;
  let bars = '';
  G.moves.forEach((m, i) => {
    const hgt = Math.max(1, Math.sqrt((m.spent || 0) / max) * (mid - 2));     // square root, so quick moves stay visible
    const label = G.labels[i];
    bars += `<rect class="${m.color === 'w' ? 'c-w' : 'c-b'}${isSlip(label) && label !== 'inaccuracy' ? ' l-' + label : ''}" data-ply="${i + 1}" `
      + `x="${(i * bw).toFixed(1)}" y="${(m.color === 'w' ? mid - hgt : mid).toFixed(1)}" width="${Math.max(1, bw - 1).toFixed(1)}" height="${hgt.toFixed(1)}">`
      + `<title>${esc(A.moveLabel(G, i))}: ${Math.round(m.spent || 0)}s</title></rect>`;
  });
  $('clock').innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Time spent on each move">`
    + `<line class="g-mid" x1="0" y1="${mid}" x2="${W}" y2="${mid}"/>${bars}</svg>`
    + `<p class="muted small">White above the line, Black below. The longest think was ${Math.round(max)} seconds. Coloured bars are mistakes and blunders.</p>`;
}
$('clock').onclick = e => { const r = e.target.closest('[data-ply]'); if (r) go(+r.dataset.ply); };

function render() {
  if (!G) return;
  updateLive();
  renderBoard(); renderMoves(); renderInfo(); renderLines(); markGraph();
}
function go(p) {
  if (!G) return;
  X = null;
  const before = ply;
  ply = Math.max(0, Math.min(G.moves.length, p));
  render();
  const box = $('moves'), a = box.querySelector('.active');
  if (a && (a.offsetTop < box.scrollTop || a.offsetTop + a.offsetHeight > box.scrollTop + box.clientHeight)) {
    box.scrollTop = a.offsetTop - box.clientHeight / 2;
  }
  if (ply > 0 && ply !== before) playMoveSound(G.moves[ply - 1]);
  if (voiceOn) speak(spokenText());
}

// ---------- Voice ----------
const synth = window.speechSynthesis;
let voiceOn = false;
const PIECE = { K: 'king', Q: 'queen', R: 'rook', B: 'bishop', N: 'knight' };

// Turns chess notation into words: "Nxf3+" becomes "knight takes F 3, check".
function sayMove(san) {
  const tail = san.endsWith('#') ? ', checkmate' : san.endsWith('+') ? ', check' : '';
  if (san.startsWith('O-O-O')) return 'castles queenside' + tail;
  if (san.startsWith('O-O')) return 'castles kingside' + tail;
  const m = san.match(/^([KQRBN])?([a-h])?([1-8])?(x)?([a-h])([1-8])(?:=([QRBN]))?[+#]?$/);
  if (!m) return san;
  const [, pc, fromFile, fromRank, takes, toFile, toRank, promo] = m;
  const parts = [];
  if (pc) parts.push(PIECE[pc]); else if (!takes) parts.push('pawn');
  if (fromFile) parts.push(fromFile.toUpperCase());
  if (fromRank) parts.push(fromRank);
  parts.push(takes ? 'takes' : 'to', toFile.toUpperCase(), toRank);
  return parts.join(' ') + (promo ? ', promoting to a ' + PIECE[promo] : '') + tail;
}
function who(color) {
  if (!G.me || !G.own) return color === 'w' ? 'White' : 'Black';
  return color === G.me ? 'You' : 'Your opponent';
}
// Written moves inside a sentence ("This allows Nc7+, a fork") read aloud as words.
const sayText = t => t.replace(/\b(?:O-O(?:-O)?|[KQRBN]?[a-h]?[1-8]?x?[a-h][1-8](?:=[QRBN])?)[+#]?/g, m => sayMove(m).replace(/^pawn to /, ''));
function spokenText() {
  if (!G) return '';
  if (ply === 0) return 'Starting position.';
  const i = ply - 1, m = G.moves[i];
  let t = `Move ${A.moveNumber(G.fens[i])}. ${who(m.color)} played ${sayMove(m.san)}.`;
  const label = G.labels[i];
  if (!G.ev[ply] || !label) return t;
  if (isSlip(label)) {
    t += ` That is ${LABELS[label].an}.`;
    const better = betterLine(i)[0], reply = bestReply(i), n = habitCount(i);
    if (better) t += ` Better was ${sayMove(better)}.`;
    t += ' ' + A.explain(G, i).lines.map(sayText).join(' ');
    if (reply) t += ` The strongest reply now is ${sayMove(reply)}.`;
    if (n >= HABIT_AFTER) t += ` This is a habit. ${cap(A.TAGS[G.tags[i]].ing)} has happened ${n} times in your earlier games.`;
  } else if (label === 'best' || label === 'great' || label === 'brilliant') {
    t += ` That was ${LABELS[label].an}. ` + A.explain(G, i).lines.map(sayText).join(' ');
  }
  return t;
}
function speak(text) {
  if (!synth || !text) return;
  synth.cancel();
  const u = new SpeechSynthesisUtterance(text);
  const v = synth.getVoices().find(x => x.name === $('voiceSel').value);
  if (v) { u.voice = v; u.lang = v.lang; } else { u.lang = 'en-US'; }
  u.rate = VOICE_SPEED;
  synth.speak(u);
}
function fillVoices() {
  const voices = synth.getVoices().filter(v => v.lang.startsWith('en'));
  if (!voices.length) return;
  const saved = lsGetText('cc-voice');
  const sel = $('voiceSel');
  sel.textContent = '';
  for (const v of voices) {
    const o = document.createElement('option');
    o.value = v.name;
    o.textContent = `${v.name} (${v.lang})`;
    if (v.name === saved) o.selected = true;
    sel.append(o);
  }
}
if (synth) { fillVoices(); synth.onvoiceschanged = fillVoices; }
else { $('voice').hidden = true; }

// ---------- Wiring: review controls ----------
$('first').onclick = () => go(0);
$('prev').onclick = () => (X ? undoLineMove() : go(ply - 1));
$('next').onclick = () => go(ply + 1);
$('last').onclick = () => G && go(G.moves.length);
$('flip').onclick = () => { flipped = !flipped; render(); };
$('nextBad').onclick = () => {
  if (!G) return;
  const bad = k => isSlip(k) && k !== 'inaccuracy';
  let i = G.labels.findIndex((k, idx) => bad(k) && idx >= ply);
  if (i < 0) i = G.labels.findIndex(bad);
  if (i >= 0) go(i + 1);
  else setStatus(G.done ? 'No mistakes or blunders in this game.' : 'Nothing found yet: the analysis is still running.');
};
$('voice').onclick = () => {
  voiceOn = !voiceOn;
  $('voice').textContent = voiceOn ? 'Voice: on' : 'Voice: off';
  $('voiceSel').hidden = !voiceOn;
  if (voiceOn) speak(spokenText()); else synth.cancel();
};
$('voiceSel').onchange = () => {
  lsSetText('cc-voice', $('voiceSel').value);
  if (voiceOn) speak(spokenText());
};
function paintToggles() {
  $('soundBtn').textContent = 'Sound: ' + (settings.sound ? 'on' : 'off');
  $('linesBtn').textContent = 'Engine lines: ' + (settings.lines ? 'on' : 'off');
  const dark = document.documentElement.dataset.theme === 'dark'
    || (!document.documentElement.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches);
  $('themeBtn').textContent = dark ? 'Light mode' : 'Dark mode';
}
$('soundBtn').onclick = () => { settings.sound = !settings.sound; saveSettings(); paintToggles(); };
$('linesBtn').onclick = () => { settings.lines = !settings.lines; saveSettings(); paintToggles(); render(); };
$('themeBtn').onclick = () => {
  const dark = $('themeBtn').textContent === 'Light mode';
  settings.theme = dark ? 'light' : 'dark';
  document.documentElement.dataset.theme = settings.theme;
  saveSettings(); paintToggles();
};
$('depth').value = settings.depth;
if (!$('depth').value) $('depth').value = '12';
$('depth').onchange = () => { settings.depth = $('depth').value; saveSettings(); if (G) { X = null; startAnalysis(); render(); } };
document.addEventListener('keydown', e => {
  if (!G || $('tab-review').hidden || /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
  if (e.key === 'ArrowLeft') { X ? undoLineMove() : go(ply - 1); e.preventDefault(); }
  if (e.key === 'ArrowRight') { go(ply + 1); e.preventDefault(); }
});

// ---------- A link to this game ----------
$('shareBtn').onclick = async () => {
  const s = G.source;
  const link = location.origin + location.pathname + `#u=${encodeURIComponent(s.user)}&m=${s.monthKey}&g=${shortId(s.url)}`;
  try { await navigator.clipboard.writeText(link); $('shareMsg').textContent = 'Link copied. Anyone who opens it sees this game reviewed in their own browser.'; }
  catch { $('shareMsg').textContent = 'Copy this link: ' + link; }
};
async function openFromLink() {
  const p = new URLSearchParams(location.hash.slice(1));
  const user = p.get('u'), month = p.get('m'), id = p.get('g');
  if (!user || !month || !id) return false;
  $('user').value = user;
  $('loadMsg').textContent = 'Opening the linked game…';
  try {
    const game = await findGame(user, month, id);
    history.replaceState(null, '', location.pathname);     // so a reload does not reopen it over the player's own work
    await loadPlayer(user, month);
    if (!game) { $('loadMsg').textContent = 'That link points to a game that could not be found.'; return true; }
    openGame(game.pgn, { user, source: { user, monthKey: game.monthKey, url: game.url } });
  } catch (err) { $('loadMsg').textContent = err.message; }
  return true;
}

// ---------- Reviewing a whole day in one go ----------
let batchId = 0;
async function reviewBatch(games, user) {
  const id = ++batchId, depth = +$('depth').value;
  $('batch').hidden = false;
  $('batchProg').value = 0;
  let eng, done = 0, skipped = 0;
  try { eng = await getEngine(); }
  catch { $('batchMsg').textContent = 'The engine could not start.'; return; }
  for (const [k, game] of games.entries()) {
    if (id !== batchId) return;
    $('batchMsg').textContent = `Reviewing game ${k + 1} of ${games.length} (against ${game.opp})…`;
    let g;
    try { g = A.parseGame(game.pgn, user); } catch { skipped++; continue; }
    const saved = await store.getAnalysis(g.id);
    let ok = !!saved && saved.depth >= depth && await A.unpackAnalysis(g, saved);
    if (!ok) {
      ok = await A.analyseGame(g, eng, depth, {
        cancelled: () => id !== batchId,
        onProgress: i => { $('batchProg').value = (k + (i + 1) / g.fens.length) / games.length; }
      });
      if (!ok) return;
      await store.putAnalysis(A.packAnalysis(g));
    }
    if (g.me && isMe(user)) store.saveToHistory(A.historyRecord(g));
    done++;
    $('batchProg').value = (k + 1) / games.length;
    renderList();
  }
  if (id !== batchId) return;
  $('batchMsg').textContent = `Done: ${count(done, 'game', 'games')} reviewed` + (skipped ? `, ${skipped} could not be read` : '')
    + (isMe(user) ? '. Open any of them to see the review; your Progress tab is up to date.' : '. Open any of them to see the review straight away.');
  $('batchStop').hidden = true;
}
$('batchStop').onclick = () => { batchId++; $('batchMsg').textContent = 'Stopped. The games already finished are kept.'; $('batchStop').hidden = true; };

// ---------- Wiring: the Games tab ----------
initGames({
  onOpen: (game, user) => {
    try { openGame(game.pgn, { user, source: { user, monthKey: game.monthKey, url: game.url } }); }
    catch (err) { $('loadMsg').textContent = err.message; $('loadMsg').className = 'error'; }
  },
  onBatch: (games, user) => { $('batchStop').hidden = false; reviewBatch(games, user); },
  reviewed: () => new Map(store.loadHistory().map(r => [r.id, r])),
  onUser: noteUser
});
$('userForm').onsubmit = e => {
  e.preventDefault();
  const user = $('user').value.trim();
  if (user) { typedByPlayer = true; loadPlayer(user); }
};
$('pgnBtn').onclick = () => {
  $('pgnMsg').textContent = '';
  try { openGame($('pgn').value.trim(), { pasted: true }); }
  catch (err) { $('pgnMsg').textContent = err.message; }
};

initTrain({ showTab, getGame: () => G });
initProgress({ onHistoryChange: () => { renderList(); } });
paintToggles();
$('user').value = myUser();
$('loadMsg').textContent = 'Enter your Chess.com username, or paste a PGN.';

openFromLink().then(opened => {
  // Returning players see their games straight away.
  if (!opened && myUser() && navigator.onLine !== false) loadPlayer(myUser());
});

// Offline support: after the first visit the page and the engine load without a connection.
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

// A game link pasted into a tab that already has the site open.
window.addEventListener('hashchange', () => { openFromLink(); });

// For looking at the page's state from the browser console (and from automated tests).
export const currentGame = () => G;
