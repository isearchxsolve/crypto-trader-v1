import assert from 'node:assert';
import { evaluateNewMintGate, GateInput } from '../server/lib/newMintGate.js';

const defaultEnv = {
  NEW_MINT_MIN_SCORE: 65,
  EDGE_POCKET_ONLY: 'true',
  EDGE_MIN_SCORE: 80,
  EDGE_HIGH_CONF_SCORE: 90,
  EDGE_EXPLOSIVE_SCORE: 85,
  EDGE_EXPLOSIVE_ML: 80,
  EDGE_EXPLOSIVE_PX5M: 8,
  EDGE_EXPLOSIVE_VOLMOM: 1.5,
  ENTRY_CONFIRM_MIN_BP: 0.50,
  ENTRY_CONFIRM_MIN_PC5M: 0
};

function createInput(overrides: Partial<GateInput>): GateInput {
  return {
    tier: 'NEW_MINT',
    sigScore: 0,
    combinedScore: 0,
    mlScore: 0,
    px5m: 0,
    volMom: 0,
    bp5m: 0,
    pc5m: 0,
    qualifiedMode: null,
    isMicroWallet: false,
    env: { ...defaultEnv },
    ...overrides
  };
}

function runTests() {
  console.log("Running newMintGate tests...");

  // $H8NoF4 score 75, pc5m +30.6% -> ADMIT (mode SNIPER)
  const t1 = evaluateNewMintGate(createInput({ combinedScore: 75, pc5m: 30.6 }));
  assert.strictEqual(t1.admit, true, "t1 should be admitted");
  assert.strictEqual(t1.mode, 'SNIPER', "t1 mode should be SNIPER");

  // $3zYGCp score 67, pc5m +12.8% -> ADMIT
  const t2 = evaluateNewMintGate(createInput({ combinedScore: 67, pc5m: 12.8 }));
  assert.strictEqual(t2.admit, true, "t2 should be admitted");

  // $ztXmc4 score 66, pc5m +1% -> ADMIT
  const t3 = evaluateNewMintGate(createInput({ combinedScore: 66, pc5m: 1 }));
  assert.strictEqual(t3.admit, true, "t3 should be admitted");

  // $xGatR5 score 63 -> REJECT at 65
  const t4 = evaluateNewMintGate(createInput({ combinedScore: 63 }));
  assert.strictEqual(t4.admit, false, "t4 should be rejected");

  // $6kA2JK score 35 -> REJECT
  const t5 = evaluateNewMintGate(createInput({ combinedScore: 35 }));
  assert.strictEqual(t5.admit, false, "t5 should be rejected");

  // A tier:'NEW_MINT' survivor must bypass EDGE_POCKET (admit at score 67 even though < 80)
  // t2 already covers this, but let's be explicit
  assert.strictEqual(t2.admit, true, "t2 bypassing EDGE_POCKET");

  // A tier:'HIGH'/scanner token at score 67 must still be REJECTED (global 90 wall intact)
  const t6 = evaluateNewMintGate(createInput({ tier: 'HIGH', combinedScore: 67 }));
  assert.strictEqual(t6.admit, false, "t6 should be rejected (global 90 wall)");

  // A tier:'LEGENDARY' token at sigScore 82 -> boosted to 90, forced SNIPER, passes 90 gate
  const t7 = evaluateNewMintGate(createInput({ tier: 'LEGENDARY', sigScore: 82 }));
  assert.strictEqual(t7.admit, true, "t7 LEGENDARY should be admitted");
  
  // A scanner token at 90 -> ADMIT
  const t8 = evaluateNewMintGate(createInput({ tier: 'HIGH', combinedScore: 90, qualifiedMode: 'SNIPER' }));
  assert.strictEqual(t8.admit, true, "t8 should be admitted");

  console.log("All unit tests passed!");
}

runTests();
