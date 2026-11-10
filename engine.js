// Stockfish in a Web Worker, with a small job queue.
// One engine is shared by the whole page. Jobs run one at a time; an "urgent" job (the live
// evaluation while you try your own moves) jumps ahead of the queued background jobs.

export const ENGINE_FILE = 'stockfish-19-lite-single.js';   // must sit next to index.html, with its .wasm file

class Engine {
  constructor(url) {
    this.onLine = null;
    this.queue = [];
    this.current = null;
    this.multipv = 1;
    this.w = new Worker(url);
    this.failed = new Promise((_, reject) => { this.w.onerror = () => reject(new Error('engine failed to load')); });
    this.failed.catch(() => {});
    this.w.onmessage = e => {
      for (const line of String(e.data).split('\n')) if (this.onLine) this.onLine(line.trim());
    };
  }
  send(cmd) { this.w.postMessage(cmd); }
  wait(cmd, token) {
    return new Promise(resolve => {
      this.onLine = line => { if (line === token) { this.onLine = null; resolve(); } };
      this.send(cmd);
    });
  }
  async init() {
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('engine timed out')), 30000));
    const start = (async () => { await this.wait('uci', 'uciok'); await this.wait('isready', 'readyok'); })();
    await Promise.race([start, this.failed, timeout]);
  }

  // Analyse one position. Returns a promise with a .cancel() method.
  // Resolves with an array of lines, best first: { type: 'cp' | 'mate', value, depth, pv: [uci moves] },
  // scored from the side to move's point of view. Resolves with null if cancelled.
  //   opts.depth    search depth
  //   opts.multipv  how many lines to report (default 1)
  //   opts.onInfo   called with the lines so far, every time the engine reports progress
  //   opts.urgent   run before the queued background jobs
  analyse(fen, opts = {}) {
    const job = { fen, depth: opts.depth || 12, multipv: opts.multipv || 1, onInfo: opts.onInfo, cancelled: false };
    const promise = new Promise(resolve => { job.resolve = resolve; });
    promise.cancel = () => {
      if (job.done || job.cancelled) return;
      job.cancelled = true;
      if (this.current === job) this.send('stop');            // bestmove follows, which ends the job
      else { this.queue = this.queue.filter(j => j !== job); job.done = true; job.resolve(null); }
    };
    if (opts.urgent) this.queue.unshift(job); else this.queue.push(job);
    this.pump();
    return promise;
  }
  async pump() {
    if (this.current || !this.queue.length) return;
    const job = this.current = this.queue.shift();
    if (job.multipv !== this.multipv) {
      this.multipv = job.multipv;
      this.send('setoption name MultiPV value ' + job.multipv);
      await this.wait('isready', 'readyok');
    }
    if (job.cancelled) {                       // cancelled while the option was being set
      this.current = null; job.done = true; job.resolve(null);
      return this.pump();
    }
    const lines = [];
    this.onLine = line => {
      if (line.startsWith('info') && line.includes(' pv ') && !line.includes('bound')) {
        const m = line.match(/score (cp|mate) (-?\d+)/);
        if (!m) return;
        const k = +(line.match(/ multipv (\d+)/) || [0, 1])[1] - 1;
        const depth = +(line.match(/ depth (\d+)/) || [0, 0])[1];
        lines[k] = { type: m[1], value: +m[2], depth, pv: line.split(' pv ')[1].trim().split(/\s+/) };
        if (job.onInfo && !job.cancelled) job.onInfo(lines.filter(Boolean));
      } else if (line.startsWith('bestmove')) {
        this.onLine = null;
        this.current = null;
        job.done = true;
        const out = lines.filter(Boolean);
        job.resolve(job.cancelled || !out.length ? null : out);
        this.pump();
      }
    };
    this.send('position fen ' + job.fen);
    this.send('go depth ' + job.depth);
  }
}

let enginePromise = null;
// Starts the engine on first use. Rejects if the engine files are missing.
export function getEngine() {
  if (!enginePromise) {
    enginePromise = (async () => { const e = new Engine(ENGINE_FILE); await e.init(); return e; })()
      .catch(err => { enginePromise = null; throw err; });
  }
  return enginePromise;
}
