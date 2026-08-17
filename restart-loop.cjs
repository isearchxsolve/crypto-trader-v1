"use strict";

/** Pure supervisor decision: a restart loop is fatal only inside its time window. */
function evaluateRestartLoop({ crashCount, lastCrashTime, now = Date.now(), maxRestarts, windowMs }) {
  const validCount = Number.isInteger(crashCount) && crashCount >= 0 ? crashCount : 0;
  const validLimit = Number.isInteger(maxRestarts) && maxRestarts > 0 ? maxRestarts : 8;
  const validWindow = Number.isFinite(windowMs) && windowMs > 0 ? windowMs : 300000;
  const withinWindow = Number.isFinite(lastCrashTime) && now >= lastCrashTime && now - lastCrashTime < validWindow;
  return {
    halt: withinWindow && validCount >= validLimit,
    crashCount: validCount,
    maxRestarts: validLimit,
    withinWindow,
  };
}

module.exports = { evaluateRestartLoop };
