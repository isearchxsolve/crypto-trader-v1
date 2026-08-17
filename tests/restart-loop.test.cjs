const test = require("node:test");
const assert = require("node:assert/strict");
const { evaluateRestartLoop } = require("../restart-loop.cjs");

const cases = [
  [0, 8, true, false], [7, 8, true, false], [8, 8, true, true], [9, 8, true, true],
  [8, 8, false, false], [8, 1, true, true], [1, 1, true, true], [0, 1, true, false],
];

for (const [crashCount, maxRestarts, withinWindow, halt] of cases) {
  test(`restart loop count=${crashCount} limit=${maxRestarts} within=${withinWindow}`, () => {
    const now = 1_000_000;
    const result = evaluateRestartLoop({
      crashCount,
      maxRestarts,
      now,
      lastCrashTime: withinWindow ? now - 1 : now - 300_001,
      windowMs: 300_000,
    });
    assert.equal(result.halt, halt);
    assert.equal(result.maxRestarts, maxRestarts);
  });
}
