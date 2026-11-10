# Second Look

A free chess coach for your own Chess.com games. Type your username, pick a game, and the page
reviews it with Stockfish running in your browser. Nothing is uploaded: games, history and
analysis stay on your device.

Live site: https://shubhanggowdac17-dev.github.io/Chess-Second-Look/

## What it does

- **Games**: every game of any month, grouped by day, with filters and a mark on the ones already reviewed.
- **Review**: move labels (brilliant to blunder), accuracy, a graph of who was winning, key moments,
  plain-English explanations, and a board you can move pieces on to try your own ideas.
- **Practice**: guess the move at each of your mistakes, and drills built from your saved mistakes.
- **Progress**: your habits across games, and a chart of accuracy and blunders over time.
- **Friends**: ratings and recent results of several players side by side.

## Files

Everything is a plain file; there is no build step. Edit in the GitHub web editor and commit.

| File | What it is |
| --- | --- |
| `index.html` | The page layout |
| `style.css` | All styling, including dark mode and the phone layout |
| `app.js` | Tabs and the Review tab; start reading here |
| `games.js` | Chess.com fetch and the month-by-month game list |
| `analysis.js` | Move labels, accuracy, key moments, explanations |
| `tactics.js` | Naming forks, pins, skewers and the rest |
| `engine.js` | Talks to Stockfish |
| `board.js` | The board (drag, tap, promotion) |
| `train.js` | Guess the move and practice |
| `progress.js` | Patterns, progress chart, friends |
| `store.js` | Everything saved in the browser |
| `sound.js` | Move sounds |
| `util.js` | Small shared helpers |
| `sw.js` | Offline support. If you add or rename a file, add it to the list in here and change `second-look-v1` to `v2` |
| `pieces.css` | Piece images (generated; do not edit by hand) |
| `openings.json` | Opening names (generated; do not edit by hand) |
| `chess.js` | Chess rules library (third party; do not edit) |
| `stockfish-19-lite-single.js`, `.wasm` | The engine (third party; do not edit) |

Settings worth knowing: label cut-offs are `THRESHOLDS` at the top of `analysis.js`; engine depths are
the `<select id="depth">` in `index.html`; practice strictness is `CLOSE_ENOUGH` in `train.js`.

## Saved data

Stored in the visitor's browser only: `cc-history` (reviewed games), `cc-user`, `cc-practice`,
`cc-friends`, `cc-settings`, `cc-voice`, and an IndexedDB database `second-look` holding finished analysis.

## Credits and licences

| Part | Author | Licence |
| --- | --- | --- |
| Stockfish.js 19 lite | Chess.com / nmrugg, based on Stockfish | GPLv3 |
| chess.js 1.4.0 | Jeff Hlywa | BSD 2-Clause |
| Piece images ("cburnett") | Colin M.L. Burnett, via lichess | GPLv2+ |
| Opening names | lichess-org/chess-openings | CC0 (public domain) |

This repository has no LICENSE file yet. The engine and the piece images are GPL, so GPLv3 is the natural choice if you add one.
Game data comes from the public Chess.com API. This site is not affiliated with Chess.com.
