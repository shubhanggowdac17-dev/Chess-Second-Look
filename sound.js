// Move sounds, made on the spot with the browser's Web Audio (no sound files to download or license).

import { settings } from './store.js';

let ctx = null;
function click(at, freq, length, volume) {
  const osc = ctx.createOscillator(), gain = ctx.createGain();
  osc.type = 'triangle';
  osc.frequency.setValueAtTime(freq, at);
  osc.frequency.exponentialRampToValueAtTime(freq / 2.2, at + length);
  gain.gain.setValueAtTime(volume, at);
  gain.gain.exponentialRampToValueAtTime(0.001, at + length);
  osc.connect(gain).connect(ctx.destination);
  osc.start(at);
  osc.stop(at + length + 0.02);
}
// mv: a move with .san and .captured (from chess.js or from the game being reviewed)
export function playMoveSound(mv) {
  if (!settings.sound || !mv) return;
  try {
    ctx = ctx || new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') ctx.resume();
    const t = ctx.currentTime;
    click(t, mv.captured ? 320 : 220, 0.07, 0.25);                 // the piece landing
    if (mv.captured) click(t + 0.05, 180, 0.08, 0.2);              // a second knock for a capture
    if (/[+#]/.test(mv.san || '')) click(t + 0.1, 660, 0.12, 0.12); // a higher note for check
  } catch {}                                                        // no sound is never a reason to break the page
}
