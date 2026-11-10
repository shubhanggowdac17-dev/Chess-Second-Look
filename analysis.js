// Everything that turns engine numbers into a review: reading a PGN, running the engine over a game,
// move labels, accuracy, key moments and the plain-English explanation of a move.
// Nothing in this file touches the page, so it can also be run in Node for testing.

import { Chess } from './chess.js';
import { VALUE, PIECE_NAME, hashText, clamp, cap } from './util.js';
import { findMotif, parseBoard, hangs, allowedText, missedText, playedText } from './tactics.js';

// ---------- Settings ----------
// A move is flagged when the mover's winning chances (0-100) drop by at least this much.
// These are the cut-offs Chess.com publishes for its own review (5%, 10%, 20%).
export const THRESHOLDS = { excellent: 2, inaccuracy: 5, mistake: 10, blunder: 20 };
export const ANALYSIS_LINES = 2;        // the engine reports its two best moves, so "only good move" can be spotted

// The move labels, best to worst. sym is what is drawn on the board square.
export const LABELS = {
  brilliant:  { name: 'Brilliant',  sym: '!!', an: 'a brilliant move' },
  great:      { name: 'Great',      sym: '!',  an: 'a great move' },
  best:       { name: 'Best',       sym: '★',  an: 'the best move' },
  excellent:  { name: 'Excellent',  sym: '✓',  an: 'an excellent move' },
  good:       { name: 'Good',       sym: '✓',  an: 'a good move' },
  book:       { name: 'Book',       sym: '▤',  an: 'a book move' },
  inaccuracy: { name: 'Inaccuracy', sym: '?!', an: 'an inaccuracy' },
  mistake:    { name: 'Mistake',    sym: '?',  an: 'a mistake' },
  miss:       { name: 'Miss',       sym: '✕',  an: 'a missed chance' },
  blunder:    { name: 'Blunder',    sym: '??', an: 'a blunder' }
};
export const isSlip = label => label === 'inaccuracy' || label === 'mistake' || label === 'miss' || label === 'blunder';
// Labels that are written after the move in the move list (the rest only get a colour).
export const SUFFIX = { brilliant: '!!', great: '!', inaccuracy: '?!', mistake: '?', miss: '?', blunder: '??' };

export const TAGS = {
  droppedMaterial: { label: 'Dropped material', ing: 'dropping material' },
  missedTactic:    { label: 'Missed a chance to win material', ing: 'missing a chance to win material' },
  missedMate:      { label: 'Missed a forced mate', ing: 'missing a forced mate' },
  allowedMate:     { label: 'Walked into a forced mate', ing: 'walking into a forced mate' },
  positional:      { label: 'Positional slip (no material lost straight away)', ing: 'a positional slip' }
};

// ---------- Evaluation helpers (all evaluations are stored from White's point of view) ----------
// An evaluation is { cp } (centipawns), { mate } (moves to mate, + for White) or { winner } (game over).
export function whiteCp(e) {
  if (e.winner) return e.winner === 'w' ? 10000 : -10000;
  if (e.mate != null) return e.mate > 0 ? 10000 : -10000;
  return e.cp;
}
export const winPct = cp => 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * cp)) - 1);
// Winning chances (0-100) of `color` in evaluation e.
export const chances = (e, color) => winPct((color === 'w' ? 1 : -1) * whiteCp(e));
export function fmt(e) {
  if (e.winner) return 'checkmate';
  if (e.mate != null) return (e.mate > 0 ? '+' : '−') + 'M' + Math.abs(e.mate);
  const v = e.cp / 100;
  return (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(1);
}
export function describe(e) {                // the same evaluation in plain words
  if (e.winner) return 'checkmate';
  const side = whiteCp(e) > 0 ? 'White' : 'Black';
  if (e.mate != null) return `a forced mate in ${Math.abs(e.mate)} for ${side}`;
  const v = Math.abs(e.cp);
  if (v < 50) return 'about level';
  if (v < 150) return `slightly better for ${side}`;
  if (v < 400) return `clearly better for ${side}`;
  return `winning for ${side}`;
}
export function terminal(fen) {
  const c = new Chess(fen);
  if (c.isCheckmate()) return { winner: c.turn() === 'w' ? 'b' : 'w' };
  if (c.isStalemate() || c.isInsufficientMaterial()) return { cp: 0 };
  return null;
}
// Turns one engine line (scored for the side to move) into a White's-point-of-view evaluation.
export function toWhite(line, fen) {
  const s = fen.split(' ')[1] === 'w' ? 1 : -1;
  return line.type === 'mate' ? { mate: line.value * s } : { cp: line.value * s };
}
// UCI moves ("e2e4") to readable moves ("e4"), stopping at the first one that does not fit.
export function sanLine(fen, pv, max = 8) {
  const c = new Chess(fen), out = [];
  for (const u of (pv || []).slice(0, max)) {
    try { out.push(c.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] }).san); }
    catch { break; }
  }
  return out;
}
export const moveNumber = fen => +fen.split(' ')[5];
// "12. Nf3" or "12… Nf6"
export const moveLabel = (g, i) => `${moveNumber(g.fens[i])}${g.moves[i].color === 'w' ? '.' : '…'} ${g.moves[i].san}`;

// ---------- Openings (for "book" moves and the opening's name) ----------
// openings.json is built from the lichess chess-openings list (public domain, CC0).
let openings = null, openingsPromise = null;
export function posKey(fen) {
  const s = fen.split(' ').slice(0, 3).join(' ');
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761); h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const n = (4294967296 * (2097151 & h2) + (h1 >>> 0)) % 2821109907456;
  return n.toString(36).padStart(8, '0');
}
export function useOpenings(data) {          // data: the parsed openings.json
  openings = new Map();
  for (let i = 0; i < data.v.length; i++) openings.set(data.k.substr(i * 8, 8), data.n[data.v[i]]);
}
export function loadOpenings() {
  if (!openingsPromise) {
    openingsPromise = fetch('openings.json').then(r => r.json()).then(useOpenings)
      .catch(() => { openings = null; });    // no list: the review simply has no "book" label
  }
  return openingsPromise;
}
// Marks the opening moves that are in the list, and names the opening from the deepest known position.
export function markBook(g) {
  g.book = [];
  if (!openings || g.headers.FEN) return;
  for (let i = 0; i < g.moves.length; i++) {
    const hit = openings.get(posKey(g.fens[i + 1]));
    if (hit === undefined) break;
    g.book[i] = true;
    if (hit) g.bookName = hit.slice(4);      // drop the "C50 " code in front
  }
  if (g.bookName && (!g.opening.fromHeader)) g.opening = openingFamily(g.bookName);
}

// ---------- Reading a game ----------
function openingFamily(name) {
  const fam = name.match(/^.*?\b(?:Opening|Defense|Defence|Game|Gambit|Attack|System)\b/);
  return { name, family: fam ? fam[0] : name };
}
function openingOf(h) {
  let name = h.Opening || '';
  if (!name && h.ECOUrl) {
    try { name = decodeURIComponent(h.ECOUrl.split('/').pop()).replace(/-\d.*$/, '').replace(/-/g, ' '); } catch {}
  }
  const o = openingFamily(name || h.ECO || 'Unknown opening');
  o.fromHeader = !!name;
  return o;
}
// Builds the game object the rest of the site works with. `me` is a username (or '' if unknown).
export function parseGame(pgn, me) {
  const c = new Chess();
  try { c.loadPgn(pgn); } catch { throw new Error('That PGN could not be read.'); }
  const hist = c.history({ verbose: true });
  if (!hist.length) throw new Error('No moves were found in that PGN.');
  const headers = {};
  for (const m of pgn.matchAll(/\[(\w+)\s+"([^"]*)"\]/g)) headers[m[1]] = m[2];
  const moves = hist.map(m => ({ san: m.san, color: m.color, piece: m.piece, from: m.from, to: m.to,
    captured: m.captured || null, flags: m.flags, uci: m.from + m.to + (m.promotion || '') }));
  const fens = [hist[0].before, ...hist.map(m => m.after)];

  // Clock times, when the PGN has one for every move (Chess.com games do).
  const clocks = [...pgn.matchAll(/\[%clk (\d+):(\d+):(\d+(?:\.\d+)?)\]/g)].map(m => +m[1] * 3600 + +m[2] * 60 + +m[3]);
  const tc = headers.TimeControl || '';
  const timed = /^\d+(\+\d+)?$/.test(tc);
  const base = timed ? parseInt(tc, 10) : 0;
  const inc = timed && tc.includes('+') ? +tc.split('+')[1] : 0;
  if (clocks.length === moves.length) {
    moves.forEach((m, i) => {
      m.clock = clocks[i];
      if (base) m.spent = Math.max(0, (i >= 2 ? clocks[i - 2] : base) - clocks[i] + inc);   // seconds used on this move
    });
  }
  const same = side => !!me && (headers[side] || '').toLowerCase() === me.toLowerCase();
  return {
    headers, moves, fens, base, inc,
    id: headers.Link || hashText(moves.map(m => m.san).join(' ')),
    me: same('White') ? 'w' : same('Black') ? 'b' : null,
    opening: openingOf(headers),
    ev: [], best: [], pv: [], alt: [], labels: [], tags: [], book: [], notes: [], drops: [],
    acc: null, keys: [], done: false
  };
}
export function resultFor(g) {               // 'win' | 'draw' | 'loss' | '?' for the player the game belongs to
  const r = g.headers.Result;
  return r === '1/2-1/2' ? 'draw'
    : r === '1-0' ? (g.me === 'w' ? 'win' : 'loss')
    : r === '0-1' ? (g.me === 'b' ? 'win' : 'loss') : '?';
}

// ---------- Sorting each slip into a type ----------
function material(fen) {                     // White's material minus Black's, in pawns
  let s = 0;
  for (const ch of fen.split(' ')[0]) {
    const v = VALUE[ch.toLowerCase()];
    if (v) s += ch === ch.toLowerCase() ? -v : v;
  }
  return s;
}
// Material won by the side to move if the engine's line is played out for a few moves.
function gain(fen, pv) {
  if (!pv || pv.length < 2) return 0;
  const s = fen.split(' ')[1] === 'w' ? 1 : -1;
  let n = Math.min(pv.length, 6);
  n -= n % 2;
  const c = new Chess(fen);
  try { for (const u of pv.slice(0, n)) c.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] }); }
  catch { return 0; }
  return s * (material(c.fen()) - material(fen));
}
function tagMistake(g, i) {
  const m = g.moves[i], s = m.color === 'w' ? 1 : -1, a = g.ev[i], b = g.ev[i + 1];
  const mateFor = e => e.mate != null && e.mate * s > 0;
  const mateAgainst = e => e.mate != null && e.mate * s < 0;
  if (mateFor(a) && !mateFor(b) && b.winner !== m.color) return 'missedMate';
  if (mateAgainst(b) && !mateAgainst(a)) return 'allowedMate';
  const playedNet = s * (material(g.fens[i + 1]) - material(g.fens[i])) - gain(g.fens[i + 1], g.pv[i + 1]);
  const bestNet = gain(g.fens[i], g.pv[i]);
  if (bestNet - playedNet >= 2) return playedNet <= -2 ? 'droppedMaterial' : 'missedTactic';
  return 'positional';
}
export function phaseOf(fen) {
  let pieces = 0;
  for (const ch of fen.split(' ')[0]) { const v = VALUE[ch.toLowerCase()]; if (v > 1) pieces += v; }
  if (pieces <= 26) return 'endgame';
  return moveNumber(fen) <= 10 ? 'opening' : 'middlegame';
}
// true or false when the game has clock times, null when it does not
export const isLowTime = (g, m) => (g.base && m.clock != null) ? m.clock < g.base * 0.1 : null;

// ---------- Move labels ----------
// Does the move put the moved piece where it can be won, for more than whatever it captured?
const sqIndex = sq => (sq.charCodeAt(0) - 97) + 8 * (+sq[1] - 1);
function isSacrifice(g, i) {
  const m = g.moves[i];
  if (m.piece === 'p' || m.piece === 'k' || m.flags.includes('p')) return false;
  if (hangs(parseBoard(g.fens[i]), sqIndex(m.from)) >= 2) return false;            // it was already lost: not a sacrifice
  if (hangs(parseBoard(g.fens[i + 1]), sqIndex(m.to)) - (m.captured ? VALUE[m.captured] : 0) < 2) return false;
  // ... and the opponent must really be allowed to take it (a pinned piece cannot).
  return new Chess(g.fens[i + 1]).moves({ verbose: true }).some(x => x.to === m.to && x.captured);
}
const inCheck = fen => new Chess(fen).isCheck();
// Labels move i. Needs the evaluations of the positions before and after it.
export function labelMove(g, i) {
  const m = g.moves[i], a = g.ev[i], b = g.ev[i + 1];
  const before = chances(a, m.color), after = chances(b, m.color);
  const isBest = m.uci === g.best[i];
  const drop = isBest ? 0 : Math.max(0, before - after);
  g.drops[i] = drop;
  g.tags[i] = undefined;
  if (g.book[i]) return (g.labels[i] = 'book');

  let label = isBest ? 'best'
    : drop >= THRESHOLDS.blunder ? 'blunder'
    : drop >= THRESHOLDS.mistake ? 'mistake'
    : drop >= THRESHOLDS.inaccuracy ? 'inaccuracy'
    : drop >= THRESHOLDS.excellent ? 'good' : 'excellent';

  if (isSlip(label)) {
    const tag = g.tags[i] = tagMistake(g, i);
    // A "miss": the player had a real chance (a tactic, a mate, or a gift from the opponent's last
    // move) and let it go, but is not in trouble afterwards.
    const gift = i > 0 && (g.labels[i - 1] === 'mistake' || g.labels[i - 1] === 'blunder') && before >= 65;
    if (label !== 'inaccuracy' && after >= 40 && (tag === 'missedMate' || tag === 'missedTactic' || gift)) label = 'miss';
  } else if (label === 'best' || label === 'excellent') {
    const alt = g.alt[i];                    // the engine's second choice in the position before the move
    const second = alt ? chances(alt.ev, m.color) : null;
    const recapture = i > 0 && m.captured && g.moves[i - 1].captured && g.moves[i - 1].to === m.to;
    if (after >= 50 && (second == null || second < 97) && isSacrifice(g, i)) label = 'brilliant';
    else if (isBest && second != null && before - second >= THRESHOLDS.blunder && before >= 35 && second <= 80 && !b.winner && !inCheck(g.fens[i])
             && !recapture && !(m.captured && VALUE[m.captured] >= 3 && hangs(parseBoard(g.fens[i]), sqIndex(m.to)) >= 2)) {
      label = 'great';
    }
  }
  return (g.labels[i] = label);
}

// ---------- Accuracy ----------
// The same method lichess publishes: each move gets a score from how much winning chance it gave away,
// and the game score blends a weighted average (tense positions count more) with a harmonic mean.
const moveAccuracy = drop => clamp(103.1668100711649 * Math.exp(-0.04354415386753951 * drop) - 3.166924740191411 + 1, 0, 100);
export function accuracy(g) {
  const n = g.moves.length;
  const wins = g.ev.map(e => chances(e, 'w'));
  const size = clamp(Math.round(n / 10), 2, 8);
  const windows = [];
  for (let k = 0; k < Math.min(size, wins.length) - 2; k++) windows.push(wins.slice(0, size));
  for (let j = 0; j + size <= wins.length; j++) windows.push(wins.slice(j, j + size));
  const weights = windows.map(win => {
    const mean = win.reduce((t, x) => t + x, 0) / win.length;
    return clamp(Math.sqrt(win.reduce((t, x) => t + (x - mean) ** 2, 0) / win.length), 0.5, 12);
  });
  const out = { w: null, b: null };
  for (const color of ['w', 'b']) {
    let sw = 0, swa = 0, sinv = 0, k = 0;
    g.moves.forEach((m, i) => {
      if (m.color !== color) return;
      const acc = moveAccuracy(g.drops[i] || 0);
      const wt = weights[i] == null ? 1 : weights[i];
      sw += wt; swa += wt * acc; sinv += 1 / Math.max(acc, 1); k++;
    });
    if (k) out[color] = Math.round(((swa / sw) + (k / sinv)) / 2 * 10) / 10;
  }
  return out;
}

// ---------- Key moments ----------
function keyMoments(g) {
  const list = [];
  g.labels.forEach((label, i) => {
    const weight = label === 'brilliant' ? 30 : label === 'great' ? 18
      : (label === 'blunder' || label === 'miss' || label === 'mistake') ? g.drops[i] : 0;
    if (weight) list.push({ i, label, weight });
  });
  return list.sort((x, y) => y.weight - x.weight).slice(0, 6).sort((x, y) => x.i - y.i);
}
export function countLabels(g) {
  const n = { w: {}, b: {} };
  g.labels.forEach((label, i) => { if (label) n[g.moves[i].color][label] = (n[g.moves[i].color][label] || 0) + 1; });
  return n;
}

// ---------- Running the engine over a game ----------
// hooks.onProgress(i) is called after each position; hooks.cancelled() can stop the run.
// Returns true when the whole game was analysed.
export async function analyseGame(g, engine, depth, hooks = {}) {
  await loadOpenings();
  markBook(g);
  for (let i = 0; i < g.fens.length; i++) {
    if (hooks.cancelled && hooks.cancelled()) return false;
    const fen = g.fens[i];
    let e = terminal(fen);
    if (!e) {
      const job = engine.analyse(fen, { depth, multipv: ANALYSIS_LINES });
      if (hooks.onJob) hooks.onJob(job);
      const lines = await job;
      if (hooks.cancelled && hooks.cancelled()) return false;
      if (!lines) { e = { cp: 0 }; g.pv[i] = []; }
      else {
        e = toWhite(lines[0], fen);
        g.best[i] = lines[0].pv[0];
        g.pv[i] = lines[0].pv;
        g.alt[i] = lines[1] ? { ev: toWhite(lines[1], fen), pv: lines[1].pv } : null;
      }
    }
    g.ev[i] = e;
    if (i > 0) labelMove(g, i - 1);
    if (hooks.onProgress) hooks.onProgress(i);
  }
  finish(g, depth);
  return true;
}
// Fills in everything that needs the whole game: accuracy and key moments.
export function finish(g, depth) {
  g.acc = accuracy(g);
  g.keys = keyMoments(g);
  g.depth = depth;
  g.done = true;
}
// The engine results of a game in a compact form, for the saved-analysis cache; and back again.
export const packAnalysis = g => ({ id: g.id, depth: g.depth, n: g.moves.length, ev: g.ev, best: g.best, pv: g.pv.map(p => (p || []).slice(0, 10)),
  alt: g.alt.map(a => (a ? { ev: a.ev, pv: a.pv.slice(0, 6) } : null)), t: Date.now() });
export async function unpackAnalysis(g, saved) {
  if (!saved || saved.n !== g.moves.length || !saved.ev || saved.ev.length !== g.fens.length) return false;
  await loadOpenings();
  markBook(g);
  g.ev = saved.ev; g.best = saved.best; g.pv = saved.pv; g.alt = saved.alt || [];
  for (let i = 0; i < g.moves.length; i++) labelMove(g, i);
  finish(g, saved.depth);
  return true;
}

// ---------- Explaining a move in words ----------
// Returns { lines: [sentences], motif: 'fork' | ... | null }. Worked out once per move and kept.
export function explain(g, i) {
  if (g.notes[i]) return g.notes[i];
  const m = g.moves[i], s = m.color === 'w' ? 1 : -1, a = g.ev[i], b = g.ev[i + 1];
  const label = g.labels[i], mine = g.own !== false && g.me === m.color;    // "your knight" only in your own games
  const out = { lines: [], motif: null };
  if (!a || !b) return out;
  const mateFor = e => e.mate != null && e.mate * s > 0;
  const mateAgainst = e => (e.mate != null && e.mate * s < 0);
  const taken = k => (k >= 0 && g.moves[k].captured ? VALUE[g.moves[k].captured] : 0);   // what move k captured

  if (isSlip(label)) {
    const allowed = findMotif(g.fens[i + 1], g.pv[i + 1], mateAgainst(b), taken(i));
    const missed = findMotif(g.fens[i], g.pv[i], mateFor(a), taken(i - 1));
    const preferMissed = g.tags[i] === 'missedTactic' || g.tags[i] === 'missedMate';
    const pick = preferMissed ? (missed ? ['missed', missed] : allowed ? ['allowed', allowed] : null)
                              : (allowed ? ['allowed', allowed] : missed ? ['missed', missed] : null);
    if (pick) {
      out.motif = pick[1].type;
      out.lines.push(pick[0] === 'allowed' ? allowedText(pick[1], mine) : missedText(pick[1], mine));
    }
    const hadMate = mateFor(a), stillMate = mateFor(b) || b.winner === m.color;
    if (hadMate && !stillMate) out.lines.push(`This missed a forced mate in ${Math.abs(a.mate)}.`);
    else if (mateAgainst(b) && !mateAgainst(a)) out.lines.push(`This allows a forced mate in ${Math.abs(b.mate)}.`);
    else out.lines.push(`Before this move the position was ${describe(a)}. After it, the position is ${describe(b)}.`);
  } else if (label === 'brilliant') {
    out.lines.push(`A sacrifice that works: the ${PIECE_NAME[m.piece]} can be taken, but taking it does not help. The position stays ${describe(b)}.`);
  } else if (label === 'great') {
    out.lines.push('The only good move here: every other move would have given ground.');
  }
  if (!isSlip(label) && label !== 'book' && (label === 'best' || label === 'great' || label === 'brilliant' || label === 'excellent')) {
    const did = findMotif(g.fens[i], [m.uci, ...(g.pv[i + 1] || [])], mateFor(b) || b.winner === m.color, taken(i - 1));
    if (did) { out.motif = did.type; out.lines.push(playedText(did, mine)); }
  }
  return (g.notes[i] = out);
}
// The history entry for one game (the shape saved under cc-history; new fields are optional extras).
export function historyRecord(g) {
  const h = g.headers, mistakes = [];
  g.labels.forEach((kind, i) => {
    const m = g.moves[i];
    if (!isSlip(kind) || m.color !== g.me) return;
    const rec = { n: moveNumber(g.fens[i]), san: m.san, kind, tag: g.tags[i] || 'positional',
      phase: phaseOf(g.fens[i]), piece: m.piece, low: isLowTime(g, m), fen: g.fens[i], best: g.best[i] || '' };
    const motif = explain(g, i).motif;
    if (motif) rec.motif = motif;
    mistakes.push(rec);
  });
  return { id: g.id, date: h.UTCDate || h.Date || '', color: g.me, result: resultFor(g),
    opp: (g.me === 'w' ? h.Black : h.White) || '', opening: g.opening.name, family: g.opening.family,
    moves: g.moves.length, mistakes, saved: Date.now(),
    acc: g.acc ? g.acc[g.me] : null, oppAcc: g.acc ? g.acc[g.me === 'w' ? 'b' : 'w'] : null,
    counts: countLabels(g)[g.me], timeClass: h.TimeControl || '' };
}
export { cap };
