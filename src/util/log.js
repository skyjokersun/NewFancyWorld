'use strict';
const levels = { debug: 10, info: 20, warn: 30, error: 40 };
const current = levels[process.env.QIYU_LOG || 'info'] || 20;
function out(level, args) {
  if (levels[level] < current) return;
  const ts = new Date().toISOString().slice(11, 23);
  console[level === 'debug' ? 'log' : level](`[${ts}] ${level.toUpperCase()}`, ...args);
}
module.exports = {
  debug: (...a) => out('debug', a), info: (...a) => out('info', a),
  warn: (...a) => out('warn', a), error: (...a) => out('error', a),
};
