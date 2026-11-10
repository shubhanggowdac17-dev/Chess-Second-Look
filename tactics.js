// Naming the tactic behind a move: hung piece, fork, pin, skewer, discovered attack,
// back-rank mate, trapped piece.
//
// The rule in this file is "say less when unsure". A tactic is only named when
//   1. the shape is on the board (for example one knight attacking two bigger pieces), and
//   2. the engine's own line confirms it: the line really wins material or gives mate.
// When either test fails, findMotif returns null and the page falls back to a plain sentence.

import { Chess } from './chess.js';
import { VALUE, PIECE_NAME, FILES, cap } from './util.js';

// ---------- A tiny board, just for "what attacks what" ----------
const idx = sq => (sq.charCodeAt(0) - 97) + 8 * (+sq[1] - 1);
const name = i => FILES[i % 8] + (Math.floor(i / 8) + 1);
const other = c => (c === 'w' ? 'b' : 'w');
const worth = p => (p.t === 'k' ? 100 : VALUE[p.t]);       // for ordering and comparing pieces

export function parseBoard(fen) {
  const b = new Array(64).fill(null);
  fen.split(' ')[0].split('/').forEach((row, r) => {
    let f = 0;
    for (const ch of row) {
      if (/\d/.test(ch)) f += +ch;
      else { b[f + 8 * (7 - r)] = { t: ch.toLowerCase(), c: ch === ch.toLowerCase() ? 'b' : 'w' }; f++; }
    }
  });
  return b;
}
const KNIGHT = [[1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2]];
const KING = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
const ORTHO = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const DIAG = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
const dirsOf = t => (t === 'b' ? DIAG : t === 'r' ? ORTHO : t === 'q' ? [...ORTHO, ...DIAG] : []);
const step = (i, [df, dr]) => {
  const f = i % 8 + df, r = Math.floor(i / 8) + dr;
  return f < 0 || f > 7 || r < 0 || r > 7 ? -1 : f + 8 * r;
};
// Squares of the pieces of `color` that attack square `sq` (pins are ignored).
export function attackers(b, sq, color) {
  const out = [];
  for (const d of KNIGHT) { const j = step(sq, d); if (j >= 0 && b[j] && b[j].c === color && b[j].t === 'n') out.push(j); }
  for (const d of KING) { const j = step(sq, d); if (j >= 0 && b[j] && b[j].c === color && b[j].t === 'k') out.push(j); }
  const pr = color === 'w' ? -1 : 1;                        // a white pawn attacks from one rank below
  for (const df of [-1, 1]) { const j = step(sq, [df, pr]); if (j >= 0 && b[j] && b[j].c === color && b[j].t === 'p') out.push(j); }
  for (const d of [...ORTHO, ...DIAG]) {
    const diag = d[0] !== 0 && d[1] !== 0;
    for (let j = step(sq, d); j >= 0; j = step(j, d)) {
      if (!b[j]) continue;
      if (b[j].c === color && (b[j].t === 'q' || b[j].t === (diag ? 'b' : 'r'))) out.push(j);
      break;
    }
  }
  return out;
}
// Squares attacked by the piece standing on `from`.
function attacksFrom(b, from) {
  const p = b[from], out = [];
  if (!p) return out;
  if (p.t === 'n') for (const d of KNIGHT) { const j = step(from, d); if (j >= 0) out.push(j); }
  else if (p.t === 'k') for (const d of KING) { const j = step(from, d); if (j >= 0) out.push(j); }
  else if (p.t === 'p') for (const df of [-1, 1]) { const j = step(from, [df, p.c === 'w' ? 1 : -1]); if (j >= 0) out.push(j); }
  else for (const d of dirsOf(p.t)) for (let j = step(from, d); j >= 0; j = step(j, d)) { out.push(j); if (b[j]) break; }
  return out;
}
// Static exchange evaluation: the material `color` wins (in pawns, never below 0) by starting a
// series of captures on `sq`, when both sides always recapture with their cheapest piece.
export function see(board, sq, color) {
  const b = board.slice();
  const gains = [];
  let side = color, victim = b[sq];
  if (!victim) return 0;
  for (;;) {
    const from = attackers(b, sq, side).sort((x, y) => worth(b[x]) - worth(b[y]))[0];
    if (from == null) break;
    if (b[from].t === 'k' && attackers(b, sq, other(side)).length) break;   // a king cannot capture into check
    gains.push(VALUE[victim.t]);
    victim = b[from];
    b[sq] = b[from]; b[from] = null;
    side = other(side);
  }
  let score = 0;
  for (let i = gains.length - 1; i >= 0; i--) score = Math.max(0, gains[i] - score);
  return score;
}
// Material lost if the piece on `sq` simply stays there (0 when it is safe).
export const hangs = (b, sq) => (b[sq] ? see(b, sq, other(b[sq].c)) : 0);

function material(b, color) {
  let s = 0;
  for (const p of b) if (p) s += p.c === color ? VALUE[p.t] : -VALUE[p.t];
  return s;
}

// ---------- The motif finder ----------
// fen: the position.  pv: the engine's line from it, as UCI moves (the first move is the one being named).
// mate: true when the engine says this line forces mate.
// Returns null, or { type, ... } describing the tactic the first move of the line carries out.
// credit: the value of whatever the other side captured with the move just before this position.
//         It is taken off the winnings, so that simply taking back in a trade is never called a tactic.
export function findMotif(fen, pv, mate = false, credit = 0) {
  if (!pv || !pv.length) return null;
  const c = new Chess(fen);
  const us = c.turn(), them = other(us);
  const before = parseBoard(fen);
  const played = [];                                       // the line, as chess.js moves
  for (const u of pv.slice(0, 9)) {
    try { played.push(c.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] })); }
    catch { break; }
  }
  if (!played.length) return null;
  const first = played[0];
  const from = idx(first.from), to = idx(first.to);
  const after = parseBoard(first.after);
  const mover = after[to];

  // Back-rank mate: the line ends in checkmate on the loser's own first rank, given by a rook or queen
  // along that rank, with the king shut in by its own pieces.
  if (c.isCheckmate() && played.length <= 5 && played.length % 2 === 1) {
    const end = parseBoard(c.fen());
    const k = end.findIndex(p => p && p.t === 'k' && p.c === them);
    const rank = Math.floor(k / 8), home = them === 'w' ? 0 : 7;
    const checkers = attackers(end, k, us);
    if (rank === home && checkers.length === 1) {
      const ch = checkers[0];
      const front = [-1, 0, 1].map(df => step(k, [df, them === 'w' ? 1 : -1])).filter(j => j >= 0);
      if ((end[ch].t === 'r' || end[ch].t === 'q') && Math.floor(ch / 8) === home
          && front.every(j => end[j] && end[j].c === them)) {
        return { type: 'backRank', san: first.san, moves: Math.ceil(played.length / 2) };
      }
    }
  }

  // Everything below must be backed by the engine line winning at least two pawns' worth of material.
  const n = Math.min(played.length, 6), end = parseBoard(played[n - 1].after);
  let won = material(end, us) - material(before, us);
  // If the line stops on our own move, whatever that last piece can be taken back for is not won yet.
  if (n % 2 === 1) won -= hangs(end, idx(played[n - 1].to));
  won -= credit;
  // Our later moves in the line that capture something, as { sq, piece taken }.
  const laterCaptures = played.filter((m, i) => i >= 2 && i % 2 === 0 && m.captured).map(m => idx(m.to));
  const confirmed = won >= 2 || mate;
  if (!confirmed) return null;

  const pieceAt = (b, i) => ({ sq: name(i), piece: PIECE_NAME[b[i].t] });

  // Hung piece: the first move simply takes something that was not (enough) defended.
  if (first.captured && first.captured !== 'p' && !first.flags.includes('e')) {
    const free = see(before, to, us);
    if (free >= 2) {
      const defended = attackers(before, to, them).length > 0;
      return { type: 'hung', san: first.san, target: { sq: first.to, piece: PIECE_NAME[first.captured] }, defended,
               by: PIECE_NAME[first.piece] };
    }
  }

  const safe = hangs(after, to) === 0;                     // the piece that moved cannot just be taken
  const juicy = (b, j, attackerWorth) => {                 // is the enemy piece on j worth attacking?
    const p = b[j];
    if (!p || p.c !== them || p.t === 'p') return false;
    return p.t === 'k' || worth(p) > attackerWorth || attackers(b, j, them).length === 0;
  };

  // Fork: the piece that moved attacks two or more valuable enemy pieces, and the line goes on to take one.
  if (mover && safe) {
    const targets = attacksFrom(after, to).filter(j => juicy(after, j, worth(mover)));
    if (targets.length >= 2 && laterCaptures.some(j => targets.includes(j))) {
      targets.sort((x, y) => worth(after[y]) - worth(after[x]));
      return { type: 'fork', san: first.san, by: PIECE_NAME[mover.t], targets: targets.slice(0, 2).map(j => pieceAt(after, j)) };
    }
  }

  // Discovered attack: moving away opens a line from one of our long-range pieces to a valuable target.
  for (const d of [...ORTHO, ...DIAG]) {
    const diag = d[0] !== 0 && d[1] !== 0;
    let j = step(from, d);
    while (j >= 0 && !after[j]) j = step(j, d);
    if (j < 0 || j === to) continue;
    const slider = after[j];
    if (!slider || slider.c !== us || !(slider.t === 'q' || slider.t === (diag ? 'b' : 'r'))) continue;
    const back = [-d[0], -d[1]];
    let t = step(from, back);
    while (t >= 0 && !after[t]) t = step(t, back);
    if (t < 0 || t === to || !juicy(after, t, worth(slider))) continue;
    // The target must still be there to take later, or be the king (a discovered check).
    if (after[t].t === 'k' || laterCaptures.includes(t) || laterCaptures.some(x => attacksFrom(after, to).includes(x))) {
      return { type: 'discovered', san: first.san, by: PIECE_NAME[mover.t], slider: PIECE_NAME[slider.t],
               target: pieceAt(after, t), check: after[t].t === 'k' };
    }
  }

  // Pin and skewer: a long-range piece lines up two enemy pieces.
  if (mover && safe && 'bqr'.includes(mover.t)) {
    for (const d of dirsOf(mover.t)) {
      let a = step(to, d);
      while (a >= 0 && !after[a]) a = step(a, d);
      if (a < 0 || after[a].c !== them) continue;
      let z = step(a, d);
      while (z >= 0 && !after[z]) z = step(z, d);
      if (z < 0 || after[z].c !== them) continue;
      const front = after[a], behind = after[z];
      if (front.t !== 'k' && front.t !== 'p' && worth(behind) > worth(front)
          && (behind.t === 'k' || worth(behind) > worth(mover)) && laterCaptures.includes(a)) {
        return { type: 'pin', san: first.san, by: PIECE_NAME[mover.t], pinned: pieceAt(after, a), behind: pieceAt(after, z) };
      }
      if ((front.t === 'k' || worth(front) > worth(mover)) && worth(front) > worth(behind) && behind.t !== 'p'
          && laterCaptures.includes(z)) {
        return { type: 'skewer', san: first.san, by: PIECE_NAME[mover.t], front: pieceAt(after, a), behind: pieceAt(after, z) };
      }
    }
  }

  // Trapped piece: an enemy piece is attacked, every square it could go to loses it as well,
  // and the line does go on to take it.
  if (!first.san.includes('+') && played.length >= 3) {
    for (let t = 0; t < 64; t++) {
      const p = after[t];
      if (!p || p.c !== them || p.t === 'k' || p.t === 'p' || VALUE[p.t] < 3) continue;
      if (!laterCaptures.includes(t) || idx(played[2].to) !== t) continue;
      if (hangs(after, t) < 2 || hangs(before, t) >= 2) continue;          // newly attacked by this move
      const probe = new Chess(first.after);
      const escapes = probe.moves({ square: name(t), verbose: true });
      const anySafe = escapes.some(m => hangs(parseBoard(m.after), idx(m.to)) - (m.captured ? VALUE[m.captured] : 0) < 2);
      if (!anySafe) return { type: 'trapped', san: first.san, target: pieceAt(after, t) };
    }
  }
  return null;
}

// ---------- Plain-English sentences ----------
const the = (x, owner) => `${owner} ${x.piece} on ${x.sq}`;

// The tactic described from the point of view of the side that carries it out.
//   subject: "you" or "White"/"Black" (who plays the tactic);  victim: "your" / "White's" / "the" (whose pieces suffer)
function body(m, victim) {
  switch (m.type) {
    case 'fork':
      return `a fork: the ${m.by} attacks ${the(m.targets[0], victim)} and ${the(m.targets[1], victim)} at the same time, and only one of them can be saved`;
    case 'pin':
      return `a pin: ${the(m.pinned, victim)} cannot move away because ${the(m.behind, victim)} is right behind it, so the pinned piece gets won`;
    case 'skewer':
      return `a skewer: ${the(m.front, victim)} has to step out of the line of fire, and ${the(m.behind, victim)} behind it is lost`;
    case 'discovered':
      return m.check
        ? `a discovered check: the ${m.by} steps aside and the ${m.slider} behind it gives check, so the ${m.by} is free to do damage`
        : `a discovered attack: the ${m.by} steps aside and uncovers the ${m.slider}'s attack on ${the(m.target, victim)}`;
    case 'trapped':
      return `a move that traps ${the(m.target, victim)}: it is attacked and has no safe square to go to`;
    case 'backRank':
      return `a back-rank mate${m.moves > 1 ? ' in ' + m.moves : ''}: the king is shut in behind its own pawns and cannot escape a check along the back row`;
    default: return '';
  }
}
// Sentence for a tactic the player allowed (the opponent can now play it).
export function allowedText(m, mine) {
  const victim = mine ? 'your' : 'the';
  if (m.type === 'hung') {
    return m.defended
      ? `This loses material: ${m.san} wins ${the(m.target, victim)} for less than it is worth.`
      : `This leaves ${the(m.target, victim)} with no defender, so ${m.san} takes it for free.`;
  }
  return `This allows ${m.san}, ${body(m, victim)}.`;
}
// Sentence for a tactic the player could have played but did not.
export function missedText(m, mine) {
  const victim = mine ? "your opponent's" : 'the';
  const could = mine ? 'You could have played' : 'Stronger was';
  if (m.type === 'hung') {
    return m.defended
      ? `${could} ${m.san}, winning ${the(m.target, victim)} for less than it is worth.`
      : `${the(m.target, cap(victim))} had no defender: ${m.san} takes it for free.`;
  }
  return `${could} ${m.san}, ${body(m, victim)}.`;
}

export const MOTIF_NAME = {
  hung: 'Hung piece', fork: 'Fork', pin: 'Pin', skewer: 'Skewer',
  discovered: 'Discovered attack', trapped: 'Trapped piece', backRank: 'Back-rank mate'
};
// Sentence for a tactic the player did play.
export function playedText(m, mine) {
  const victim = mine ? "your opponent's" : 'the';
  if (m.type === 'hung') {
    return m.defended ? `This wins ${the(m.target, victim)} for less than it is worth.`
                      : `${the(m.target, cap(victim))} had no defender, and this takes it for free.`;
  }
  return `This is ${body(m, victim)}.`;
}
