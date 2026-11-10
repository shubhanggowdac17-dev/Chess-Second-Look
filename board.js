// The chess board: draws a position and lets the player move pieces by dragging or tapping.
// It knows the rules (through chess.js) but nothing about games, engines or the rest of the page.
//
//   const board = new Board(element, { onMove(move) { ... } });
//   board.set({ fen, orientation: 'w', movable: true, lastMove: { from, to }, tone: 'blunder',
//               badge: { square: 'e4', label: 'blunder', sym: '??' }, arrows: [{ from, to, color }], marks: ['e2'] });

import { Chess } from './chess.js';
import { FILES } from './util.js';

const PROMOTIONS = ['q', 'n', 'r', 'b'];
const PROMO_NAME = { q: 'queen', n: 'knight', r: 'rook', b: 'bishop' };

export class Board {
  constructor(el, opts = {}) {
    this.el = el;
    this.onMove = opts.onMove || (() => {});
    this.state = { fen: new Chess().fen(), orientation: 'w', movable: false, arrows: [] };
    this.selected = null;       // square of the piece picked up or tapped
    this.targets = [];          // legal moves of the selected piece
    this.drag = null;
    el.classList.add('board');
    el.addEventListener('pointerdown', e => this.down(e));
    el.addEventListener('pointermove', e => this.move(e));
    el.addEventListener('pointerup', e => this.up(e));
    el.addEventListener('pointercancel', () => { if (this.drag) this.drop(this.drag.piece); this.drag = null; });
    el.addEventListener('contextmenu', e => e.preventDefault());
    this.draw();
  }
  // Show a new position. Anything left out of `state` is cleared.
  set(state) {
    this.state = { orientation: 'w', movable: false, arrows: [], ...state };
    this.chess = null;
    this.selected = null; this.targets = []; this.drag = null; this.promo = null;
    this.draw();
  }
  rules() { return this.chess || (this.chess = new Chess(this.state.fen)); }
  // Column and row (0-7 from the top-left of the screen) of a square, for the current orientation.
  place(sq) {
    const f = sq.charCodeAt(0) - 97, r = +sq[1] - 1;
    return this.state.orientation === 'b' ? [7 - f, r] : [f, 7 - r];
  }
  squareAt(x, y) {
    const box = this.el.getBoundingClientRect();
    const c = Math.floor((x - box.left) / box.width * 8), r = Math.floor((y - box.top) / box.height * 8);
    if (c < 0 || c > 7 || r < 0 || r > 7) return null;
    return this.state.orientation === 'b' ? FILES[7 - c] + (r + 1) : FILES[c] + (8 - r);
  }

  draw() {
    const s = this.state, pos = {};
    s.fen.split(' ')[0].split('/').forEach((row, r) => {
      let f = 0;
      for (const ch of row) {
        if (/\d/.test(ch)) f += +ch;
        else { pos[FILES[f] + (8 - r)] = ch; f++; }
      }
    });
    this.pos = pos;
    let html = '';
    for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
      const file = s.orientation === 'b' ? 7 - c : c, rank = s.orientation === 'b' ? r + 1 : 8 - r;
      const sq = FILES[file] + rank;
      html += `<div class="${this.squareClass(sq)}" data-s="${sq}">`
        + (c === 0 ? `<span class="coord rk">${rank}</span>` : '')
        + (r === 7 ? `<span class="coord fl">${FILES[file]}</span>` : '') + '</div>';
    }
    const turn = s.fen.split(' ')[1];
    for (const sq in pos) {
      const p = pos[sq], color = p === p.toUpperCase() ? 'w' : 'b';
      const [c, r] = this.place(sq);
      const mine = s.movable && color === turn;
      html += `<div class="pc ${color}${p.toUpperCase()}${mine ? ' mine' : ''}" data-sq="${sq}" `
        + `style="transform:translate(${c * 100}%,${r * 100}%)"></div>`;
    }
    if (s.badge) {
      const [c, r] = this.place(s.badge.square);
      html += `<div class="badge l-${s.badge.label}" style="left:${(c + 1) * 12.5}%;top:${r * 12.5}%">${s.badge.sym}</div>`;
    }
    html += this.arrowSvg();
    if (this.promo) {
      const color = turn;
      html += `<div class="promo"><div class="promo-box"><span>Promote to</span>`
        + PROMOTIONS.map(p => `<button type="button" class="pc ${color}${p.toUpperCase()}" data-promo="${p}" title="${PROMO_NAME[p]}" aria-label="${PROMO_NAME[p]}"></button>`).join('')
        + `<button type="button" data-promo="">Cancel</button></div></div>`;
    }
    this.el.innerHTML = html;
  }

  arrowSvg() {
    let arrows = '';
    for (const a of this.state.arrows || []) {
      const [c1, r1] = this.place(a.from), [c2, r2] = this.place(a.to);
      const x1 = c1 + .5, y1 = r1 + .5;
      let x2 = c2 + .5, y2 = r2 + .5;
      const len = Math.hypot(x2 - x1, y2 - y1) || 1;
      x2 -= (x2 - x1) / len * .3; y2 -= (y2 - y1) / len * .3;
      const color = a.color || 'green';
      arrows += `<line class="arrow ${color}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" marker-end="url(#ah-${color})"/>`;
    }
    return `<svg viewBox="0 0 8 8"><defs>`
      + ['green', 'blue', 'red'].map(k => `<marker id="ah-${k}" class="arrow-head ${k}" markerWidth="4" markerHeight="4" refX="2.2" refY="2" orient="auto"><path d="M0,0 L4,2 L0,4 Z"/></marker>`).join('')
      + `</defs>${arrows}</svg>`;
  }
  // Change only the arrows, leaving the pieces (and a piece being dragged) alone.
  setArrows(arrows) {
    this.state.arrows = arrows;
    const svg = this.el.querySelector('svg');
    if (svg) svg.outerHTML = this.arrowSvg();
  }
  squareClass(sq) {
    const s = this.state, last = s.lastMove;
    const file = sq.charCodeAt(0) - 97, rank = +sq[1];
    let cls = 'sq ' + ((file + rank) % 2 ? 'd' : 'l');
    if (last && (sq === last.from || sq === last.to)) cls += ' hl' + (s.tone ? ' t-' + s.tone : '');
    if (sq === this.selected) cls += ' sel';
    if (s.marks && s.marks.includes(sq)) cls += ' mark';
    const target = this.targets.find(m => m.to === sq);
    if (target) cls += this.pos[sq] || target.flags.includes('e') ? ' cap' : ' dot';
    return cls;
  }
  // Selecting a piece only repaints the squares (dots and highlight). The pieces stay in place, so a
  // finger that is already dragging one keeps hold of it.
  select(sq) {
    this.selected = sq;
    this.targets = sq ? this.rules().moves({ square: sq, verbose: true }) : [];
    this.el.querySelectorAll('.sq').forEach(d => { d.className = this.squareClass(d.dataset.s); });
  }
  drop(piece) {                               // put a dragged piece back on its square
    if (!piece) return;
    const [c, r] = this.place(piece.dataset.sq);
    piece.classList.remove('dragging');
    piece.style.transform = `translate(${c * 100}%,${r * 100}%)`;
  }
  canPick(sq) {
    if (!this.state.movable || !sq) return false;
    const p = this.rules().get(sq);
    return !!p && p.color === this.rules().turn();
  }
  down(e) {
    if (e.button > 0) return;
    const promo = e.target.closest('[data-promo]');
    if (this.promo) {
      if (promo) { const p = this.promo; this.promo = null; if (promo.dataset.promo) this.commit(p.from, p.to, promo.dataset.promo); else this.draw(); }
      return;
    }
    if (!this.state.movable) return;
    const sq = this.squareAt(e.clientX, e.clientY);
    if (!sq) return;
    if (this.selected && this.targets.some(m => m.to === sq)) { this.tryMove(this.selected, sq); return; }
    if (this.canPick(sq)) {
      const again = this.selected === sq;
      this.select(sq);
      const piece = this.el.querySelector(`.pc[data-sq="${sq}"]`);
      this.drag = { sq, piece, x: e.clientX, y: e.clientY, moved: false, again, id: e.pointerId };
      try { this.el.setPointerCapture(e.pointerId); } catch {}
      e.preventDefault();
    } else if (this.selected) this.select(null);
  }
  move(e) {
    const d = this.drag;
    if (!d || !d.piece) return;
    const dx = e.clientX - d.x, dy = e.clientY - d.y;
    if (!d.moved && Math.hypot(dx, dy) < 5) return;
    d.moved = true;
    const box = this.el.getBoundingClientRect(), size = box.width / 8;
    d.piece.classList.add('dragging');
    d.piece.style.transform = `translate(${e.clientX - box.left - size / 2}px,${e.clientY - box.top - size / 2}px) scale(1.15)`;
  }
  up(e) {
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    const sq = this.squareAt(e.clientX, e.clientY);
    if (d.moved && sq && sq !== d.sq && this.targets.some(m => m.to === sq)) { this.tryMove(d.sq, sq); return; }
    if (!d.moved && d.again) this.select(null);            // tapping the selected piece again puts it down
    this.drop(d.piece);
  }
  tryMove(from, to) {
    const options = this.targets.filter(m => m.to === to);
    if (options.some(m => m.promotion)) { this.promo = { from, to }; this.selected = null; this.targets = []; this.draw(); return; }
    this.commit(from, to);
  }
  commit(from, to, promotion) {
    let mv;
    try { mv = new Chess(this.state.fen).move({ from, to, promotion }); } catch { mv = null; }
    this.selected = null; this.targets = [];
    if (!mv) { this.draw(); return; }
    // Show the move straight away; the page decides what happens next and usually calls set() again.
    this.state = { ...this.state, fen: mv.after, lastMove: { from, to }, tone: null, badge: null, arrows: [], marks: [] };
    this.chess = null;
    this.draw();
    this.onMove(mv);
  }
}
