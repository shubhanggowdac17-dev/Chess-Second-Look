// Guess the move, and practice from saved mistakes.
// Both use the same trainer: a position is shown with the answer hidden, the player moves a piece,
// and any move the engine rates close to its best is accepted. Hints are given step by step.
//   Guess the move: the player's own mistakes from the game that is open on the Review tab.
//   Practice:       positions from mistakes saved in the history, the ones that went wrong before first.

import { $, esc, count, PIECE_NAME, VALUE } from './util.js';
import { getEngine } from './engine.js';
import { Board } from './board.js';
import * as A from './analysis.js';
import { LABELS, isSlip, chances } from './analysis.js';
import { findMotif, missedText } from './tactics.js';
import * as store from './store.js';
import { playMoveSound } from './sound.js';

const CHECK_DEPTH = 12;      // how deep the engine looks when checking the player's move
const CLOSE_ENOUGH = 4;      // a move is accepted if it gives away less than this much winning chance (0-100)
const ROUND = 10;            // positions in one practice round

let ctx = null;              // { showTab(name), getGame() }
let board = null;
let T = null;                // the session: { kind, items, at, solved, ... }

export function initTrain(c) {
  ctx = c;
  board = new Board($('trainBoard'), { onMove: onMove });
  $('hintBtn').onclick = hint;
  $('revealBtn').onclick = () => finishItem(false, 'reveal');
  $('trainNext').onclick = () => show(T.at + 1);
  $('trainQuit').onclick = () => { T = null; renderTrainHome(); };
  $('trainFeedback').onclick = e => { if (e.target.id === 'tryAgain') resetItem(); };
  $('trainHome').onclick = e => {
    const b = e.target.closest('[data-do]');
    if (!b) return;
    if (b.dataset.do === 'guess') startGuess(ctx.getGame());
    if (b.dataset.do === 'practice') startPractice();
    if (b.dataset.do === 'review') ctx.showTab('review');
    if (b.dataset.do === 'games') ctx.showTab('games');
  };
}

// ---------- Choosing the positions ----------
function guessItems(g) {
  const items = [];
  if (!g || !g.done) return items;
  g.labels.forEach((label, i) => {
    const m = g.moves[i];
    if (!isSlip(label) || label === 'inaccuracy' || (g.me && m.color !== g.me)) return;
    const you = !!g.me && g.own !== false;
    items.push({ fen: g.fens[i], best: g.best[i], pv: g.pv[i], played: m.san, kind: label, mine: you,
      win: chances(g.ev[i], m.color), credit: i > 0 && g.moves[i - 1].captured ? VALUE[g.moves[i - 1].captured] : 0,
      title: `Move ${A.moveNumber(g.fens[i])}. ${you ? 'You' : (m.color === 'w' ? 'White' : 'Black')} played ${m.san} here, and it was ${LABELS[label].an}.` });
  });
  return items;
}
function practiceItems() {
  const stats = store.loadPractice(), weight = { blunder: 3, miss: 2, mistake: 2, inaccuracy: 1 }, seen = new Set(), all = [];
  for (const r of store.loadHistory()) for (const m of r.mistakes) {
    if (!m.fen || !m.best || seen.has(m.fen)) continue;
    seen.add(m.fen);
    const s = stats[m.fen] || { ok: 0, bad: 0, last: 0 };
    // Worse mistakes first, then the ones that keep going wrong; positions solved recently wait their turn.
    const score = (weight[m.kind] || 1) + 2 * s.bad - 1.5 * s.ok - (s.last && Date.now() - s.last < 864e5 ? 3 : 0) + Math.random();
    all.push({ fen: m.fen, best: m.best, played: m.san, kind: m.kind, mine: true, score,
      title: `From your game against ${r.opp || 'an opponent'}${r.date ? ' (' + r.date.replace(/\./g, '-') + ')' : ''}, move ${m.n}. `
        + `You played ${m.san}, ${(LABELS[m.kind] || LABELS.mistake).an}.` });
  }
  return all.sort((a, b) => b.score - a.score);
}

// ---------- The Practice tab when no session is running ----------
export function renderTrainHome() {
  if (T) return;
  $('trainer').hidden = true;
  $('trainHome').hidden = false;
  const g = ctx.getGame(), fromGame = guessItems(g).length, saved = practiceItems().length;
  let h = '<h2>Practice</h2>';
  h += '<h3>Guess the move</h3>';
  if (fromGame) {
    h += `<p>The game you have open has ${count(fromGame, 'mistake', 'mistakes')} ${g.me && g.own ? 'of yours ' : ''}to try again. `
      + `The answer stays hidden until you find a good move or ask for it.</p>`
      + `<p><button type="button" class="primary" data-do="guess">Guess the move in this game</button></p>`;
  } else if (g && !g.done) h += '<p class="muted">The open game is still being analysed. Come back in a moment.</p>';
  else if (g) h += '<p class="muted">No mistakes or blunders to replay in the open game. Nicely played.</p>';
  else h += '<p class="muted">Open a game first, and you can replay your mistakes from it here. <button type="button" class="small" data-do="games">Pick a game</button></p>';
  h += '<h3>Practice my saved mistakes</h3>';
  h += saved
    ? `<p>${count(saved, 'position', 'positions')} from your reviewed games. Each round is up to ${ROUND} positions, and the ones you get wrong come back sooner.</p>`
      + `<p><button type="button" class="primary" data-do="practice">Start a round</button></p>`
    : '<p class="muted">Nothing saved yet. Review a few of your own games and your mistakes are collected here as exercises.</p>';
  $('trainHome').innerHTML = h;
}

// ---------- Running a session ----------
export function startGuess(g) { start('guess', guessItems(g)); }
export function startPractice() { start('practice', practiceItems().slice(0, ROUND)); }
function start(kind, items) {
  if (!items.length) { T = null; ctx.showTab('practice'); return; }
  T = { kind, items, at: 0, solved: 0 };
  ctx.showTab('practice');
  $('trainHome').hidden = true;
  $('trainer').hidden = false;
  show(0);
}
const turnOf = fen => fen.split(' ')[1];
function show(at) {
  if (at >= T.items.length) return finishSession();
  T.at = at;
  const it = T.items[at];
  Object.assign(T, { tries: 0, hints: 0, state: 'asking', token: {} });
  $('trainCount').textContent = `${T.kind === 'guess' ? 'Guess the move' : 'Practice'}: position ${at + 1} of ${T.items.length}`;
  $('trainTask').innerHTML = `<h3>${turnOf(it.fen) === 'w' ? 'White' : 'Black'} to move</h3><p>${esc(it.title)}</p>`
    + '<p><b>Find a better move.</b> Drag a piece, or tap it and then tap where it should go.</p>';
  $('trainFeedback').textContent = '';
  $('hintBtn').hidden = $('revealBtn').hidden = false;
  $('hintBtn').disabled = false;
  $('trainNext').hidden = true;
  setBoard(it.fen, true);
  // The engine's own answer for this position. For the game on the Review tab it is already known.
  it.base = it.win != null && it.pv
    ? Promise.resolve({ win: it.win, best: it.best, pv: it.pv })
    : getEngine().then(e => e.analyse(it.fen, { depth: CHECK_DEPTH, urgent: true })).then(lines => {
        if (!lines) return { win: null, best: it.best, pv: [it.best] };
        return { win: chances(A.toWhite(lines[0], it.fen), turnOf(it.fen)), best: lines[0].pv[0], pv: lines[0].pv };
      });
  it.base.catch(() => {});
}
function setBoard(fen, movable, extra = {}) {
  board.set({ fen, orientation: turnOf(T.items[T.at].fen), movable, ...extra });
}
function resetItem() {
  T.state = 'asking';
  $('trainFeedback').textContent = '';
  const it = T.items[T.at];
  setBoard(it.fen, true, T.hints >= 2 ? { marks: [it.best.slice(0, 2)] } : {});
}
function say(html, cls) { $('trainFeedback').innerHTML = `<div class="fb ${cls || ''}">${html}</div>`; }

async function onMove(mv) {
  if (!T || T.state !== 'asking') return;
  const it = T.items[T.at], token = T.token, uci = mv.from + mv.to + (mv.promotion || '');
  const color = turnOf(it.fen);
  T.state = 'checking';
  T.tries++;
  playMoveSound(mv);
  setBoard(mv.after, false, { lastMove: mv });
  say('Checking your move…');
  let base;
  try { base = await it.base; }
  catch { say('The engine could not start, so this move cannot be checked.', 'bad'); return; }
  if (T.token !== token) return;
  if (uci === base.best || uci === it.best) return finishItem(true, 'best', mv);
  if (mv.san === it.played) {
    T.state = 'wrong';
    return say(`<b>${esc(mv.san)}</b> is the move that was played in the game. Look for something different. <button type="button" id="tryAgain">Try again</button>`, 'bad');
  }
  const over = A.terminal(mv.after);
  if (over && over.winner === color) return finishItem(true, 'near', mv);
  let lines = null;
  if (!over) {
    const eng = await getEngine();
    lines = await eng.analyse(mv.after, { depth: CHECK_DEPTH, urgent: true });
    if (T.token !== token) return;
  }
  const win = over ? 50 : lines ? chances(A.toWhite(lines[0], mv.after), color) : null;
  const loss = win == null || base.win == null ? null : base.win - win;
  if (loss != null && loss <= CLOSE_ENOUGH) return finishItem(true, 'near', mv);
  T.state = 'wrong';
  const reply = lines ? A.sanLine(mv.after, lines[0].pv, 1)[0] : null;
  const u = lines ? lines[0].pv[0] : null;
  setBoard(mv.after, false, { lastMove: mv, tone: 'mistake', arrows: u ? [{ from: u.slice(0, 2), to: u.slice(2, 4), color: 'red' }] : [] });
  say(`Not quite. <b>${esc(mv.san)}</b>` + (loss != null ? ` gives away about ${Math.round(loss)}% of the winning chances` : ' is not close to the best move')
    + (reply ? `; the reply is <b>${esc(reply)}</b> (red arrow)` : '') + `. <button type="button" id="tryAgain">Try again</button>`, 'bad');
}
function hint() {
  const it = T.items[T.at];
  if (T.state !== 'asking' && T.state !== 'wrong') return;
  if (T.state === 'wrong') resetItem();
  T.hints++;
  const from = it.best.slice(0, 2), piece = board.rules().get(from);
  if (T.hints === 1) say(`Hint: the best move is made with your <b>${piece ? PIECE_NAME[piece.type] : 'piece'}</b>.`);
  else {
    say(`Hint: move the ${piece ? PIECE_NAME[piece.type] : 'piece'} on <b>${from}</b> (marked on the board). Where should it go?`);
    setBoard(it.fen, true, { marks: [from] });
    $('hintBtn').disabled = true;
  }
}
// The position is finished: solved, or the answer was asked for.
async function finishItem(found, how, mv) {
  const it = T.items[T.at], token = T.token;
  T.state = 'done';
  const base = await it.base.catch(() => ({ best: it.best, pv: [it.best] }));
  if (T.token !== token) return;
  const best = base.best || it.best, bestSan = A.sanLine(it.fen, [best], 1)[0] || best;
  const clean = found && T.tries === 1 && T.hints === 0;
  if (clean) T.solved++;
  if (T.kind === 'practice') store.recordPractice(it.fen, clean);
  let h;
  if (how === 'best') h = `<b>Correct${clean ? ', first try' : ''}!</b> ${esc(mv.san)} is the engine's first choice.`;
  else if (how === 'near') h = `<b>Good move.</b> ${esc(mv.san)} is about as strong as the engine's first choice, ${esc(bestSan)}.`;
  else h = `The best move was <b>${esc(bestSan)}</b> (green arrow).`;
  // Saved positions do not record whether a trade was under way, so "takes it for free" is left unsaid for them.
  const motif = findMotif(it.fen, base.pv, false, it.credit || 0);
  if (motif && (it.credit != null || motif.type !== 'hung')) h += ` ${esc(missedText(motif, it.mine).replace(/^You could have played/, 'The idea:').replace(/^Stronger was/, 'The idea:'))}`;
  const line = A.sanLine(it.fen, base.pv, 6);
  if (line.length > 1) h += `<br><span class="muted">Likely continuation: ${esc(line.join(' '))}</span>`;
  say(h, found ? 'good' : '');
  setBoard(it.fen, false, { arrows: [{ from: best.slice(0, 2), to: best.slice(2, 4), color: 'green' }] });
  $('hintBtn').hidden = $('revealBtn').hidden = true;
  $('trainNext').hidden = false;
  $('trainNext').textContent = T.at + 1 < T.items.length ? 'Next position' : 'Finish';
}
function finishSession() {
  const n = T.items.length, s = T.solved, kind = T.kind;
  T = null;
  $('trainer').hidden = true;
  $('trainHome').hidden = false;
  $('trainHome').innerHTML = `<h2>${kind === 'guess' ? 'Guess the move' : 'Practice round'} finished</h2>`
    + `<p>You found a good move at the first attempt, without hints, in <b>${s} of ${n}</b> ${n === 1 ? 'position' : 'positions'}.</p>`
    + `<p>${s === n ? 'Excellent: nothing got past you this time.' : s >= n / 2 ? 'Good work. The ones you missed will come back in practice.' : 'These are hard because they are your own blind spots. They will come back in practice until they stick.'}</p>`
    + `<div class="row">` + (kind === 'guess' ? '<button type="button" class="primary" data-do="review">Back to the review</button>' : '')
    + `<button type="button" data-do="practice">${kind === 'guess' ? 'Practice my saved mistakes' : 'Another round'}</button></div>`;
}
