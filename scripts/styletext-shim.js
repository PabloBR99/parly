// Polyfill util.styleText for Node < 22.
// React Native 0.84 CLI uses util.styleText (added in Node 22.0). On
// Node 20 we provide a minimal implementation that strips formatting —
// terminal output loses colour but the start command runs.
const util = require('node:util');
if (util.styleText === undefined) {
  util.styleText = function styleText(_format, text) {
    return String(text);
  };
}
