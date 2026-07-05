#!/usr/bin/env node
/**
 * setup-gmgn.mjs — one-shot setup & verification for the GMGN API key
 * used by the Gold Standard Hunter (gold_standard_hunter.ts -> gmgn-cli).
 *
 * What it does (in order):
 *   1. Generates a local Ed25519 key pair (public + private PEM) if you don't have one.
 *   2. Prints the PUBLIC key and the exact steps to mint an API key at https://gmgn.ai/ai
 *   3. Reads your API key (from --api-key=, the GMGN_API_KEY env var, or an interactive prompt).
 *   4. Upserts GMGN_API_KEY into your project .env (without clobbering other vars).
 *   5. Ensures gmgn-cli is installed globally (npm i -g gmgn-cli).
 *   6. Smoke-tests the key with a read-only `gmgn-cli token info` call.
 *
 * The hunter only QUERIES token info, so you only need the API key — NOT the private key.
 * The private key is still saved locally in case you later enable gmgn-swap trading.
 *
 * Usage:
 *   node setup-gmgn.mjs                       # full guided flow
 *   node setup-gmgn.mjs --api-key=YOUR_KEY    # non-interactive key set
 *   node setup-gmgn.mjs --keys-only           # only generate keys + update .gitignore
 *   node setup-gmgn.mjs --test-only           # only run the smoke test
 *   Flags: --no-install  --no-test  --force(regenerate keys)  --env=path/to/.env
 */

import { generateKeyPairSync } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout, platform } from 'node:process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = process.cwd();
const IS_WIN = platform === 'win32';
const SOL_TEST_MINT = 'So11111111111111111111111111111111111111112'; // wrapped SOL

// ---- tiny arg parser -------------------------------------------------------
const args = process.argv.slice(2);
const getFlag = (name) => args.includes(`--${name}`);
const getOpt = (name, dflt = undefined) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};

const KEYS_ONLY = getFlag('keys-only');
const TEST_ONLY = getFlag('test-only');
const NO_INSTALL = getFlag('no-install');
const NO_TEST = getFlag('no-test');
const FORCE = getFlag('force');
const ENV_PATH = resolve(PROJECT_ROOT, getOpt('env', '.env'));
const KEY_DIR = join(PROJECT_ROOT, 'gmgn_keys');
const PUB_PATH = join(KEY_DIR, 'gmgn_public.pem');
const PRIV_PATH = join(KEY_DIR, 'gmgn_private.pem');

const log = (...m) => console.log(...m);
const hr = () => log('-'.repeat(64));

// ---- step 1: key generation ------------------------------------------------
function generateKeys() {
  if (existsSync(PUB_PATH) && existsSync(PRIV_PATH) && !FORCE) {
    log(`\u2713 Key pair already exists in ${KEY_DIR} (use --force to regenerate).`);
    return;
  }
  mkdirSync(KEY_DIR, { recursive: true });
  const { publicKey, privateKey } = generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  writeFileSync(PUB_PATH, publicKey, 'utf8');
  writeFileSync(PRIV_PATH, privateKey, 'utf8');
  try { chmodSync(PRIV_PATH, 0o600); } catch { /* best effort (no-op on Windows) */ }
  log(`\u2713 Generated Ed25519 key pair:`);
  log(`    public : ${PUB_PATH}`);
  log(`    private: ${PRIV_PATH}  (keep secret; never commit)`);
}

// ---- step 1b: keep secrets out of git --------------------------------------
function ensureGitignore() {
  const giPath = join(PROJECT_ROOT, '.gitignore');
  const need = ['.env', 'gmgn_keys/'];
  let body = existsSync(giPath) ? readFileSync(giPath, 'utf8') : '';
  const lines = new Set(body.split(/\r?\n/).map((l) => l.trim()));
  const toAdd = need.filter((n) => !lines.has(n));
  if (toAdd.length) {
    const sep = body.length && !body.endsWith('\n') ? '\n' : '';
    body += `${sep}# GMGN secrets (added by setup-gmgn.mjs)\n${toAdd.join('\n')}\n`;
    writeFileSync(giPath, body, 'utf8');
    log(`\u2713 Added to .gitignore: ${toAdd.join(', ')}`);
  }
}

function printUploadInstructions() {
  hr();
  log('NEXT: mint your API key (read-only \u2014 no private key upload needed)');
  hr();
  log('1. Open  https://gmgn.ai/ai   (IPv4 only \u2014 GMGN rejects IPv6).');
  log('2. Upload the PUBLIC key below (include the BEGIN/END lines):');
  log('');
  log(existsSync(PUB_PATH) ? readFileSync(PUB_PATH, 'utf8').trim() : '(no public key found)');
  log('');
  log('3. Copy the API key it gives you, then re-run:');
  log('     node setup-gmgn.mjs --api-key=PASTE_KEY_HERE');
  hr();
}

// ---- step 3: obtain the API key --------------------------------------------
async function resolveApiKey() {
  const fromArg = getOpt('api-key');
  if (fromArg) return fromArg.trim();
  if (process.env.GMGN_API_KEY && process.env.GMGN_API_KEY.trim()) {
    return process.env.GMGN_API_KEY.trim();
  }
  if (!stdin.isTTY) return null; // non-interactive and nothing supplied
  const rl = createInterface({ input: stdin, output: stdout });
  const ans = (await rl.question('Paste your GMGN API key (blank to skip): ')).trim();
  rl.close();
  return ans || null;
}

// ---- step 4: upsert into .env ----------------------------------------------
function upsertEnv(key, value) {
  let body = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, 'utf8') : '';
  const eol = body.includes('\r\n') ? '\r\n' : '\n';
  const re = new RegExp(`^${key}=.*$`, 'm');
  if (re.test(body)) {
    body = body.replace(re, `${key}=${value}`);
  } else {
    const sep = body.length && !body.endsWith('\n') ? eol : '';
    body += `${sep}${key}=${value}${eol}`;
  }
  writeFileSync(ENV_PATH, body, 'utf8');
  log(`\u2713 Wrote ${key} to ${ENV_PATH}`);
}

// ---- helper: run a shell command, capture output ---------------------------
function run(cmd, cmdArgs, opts = {}) {
  return spawnSync(cmd, cmdArgs, {
    encoding: 'utf8',
    shell: IS_WIN, // gmgn-cli/npm are .cmd shims on Windows
    ...opts,
  });
}

// ---- step 5: ensure gmgn-cli installed -------------------------------------
function ensureGmgnCli() {
  const bin = process.env.GMGN_CLI_BIN || 'gmgn-cli';
  const probe = run(bin, ['--version']);
  if (probe.status === 0) {
    log(`\u2713 gmgn-cli present (${(probe.stdout || '').trim() || 'ok'}).`);
    return true;
  }
  log('gmgn-cli not found \u2014 installing globally (npm i -g gmgn-cli)...');
  const inst = run('npm', ['install', '-g', 'gmgn-cli'], { stdio: 'inherit' });
  if (inst.status !== 0) {
    log('\u2717 Failed to install gmgn-cli. Install it manually: npm i -g gmgn-cli');
    return false;
  }
  log('\u2713 gmgn-cli installed.');
  return true;
}

// ---- step 6: smoke test ----------------------------------------------------
function smokeTest() {
  const bin = process.env.GMGN_CLI_BIN || 'gmgn-cli';
  log(`Running smoke test: ${bin} token info --chain sol --address ${SOL_TEST_MINT} --raw`);
  const res = run(bin, ['token', 'info', '--chain', 'sol', '--address', SOL_TEST_MINT, '--raw'], {
    env: { ...process.env },
  });
  if (res.status === 0 && res.stdout) {
    try {
      const j = JSON.parse(res.stdout);
      log('\u2713 SMOKE TEST PASSED \u2014 GMGN key works. Sample keys:', Object.keys(j).slice(0, 8).join(', ') || '(object)');
      return true;
    } catch {
      log('\u26a0 gmgn-cli returned non-JSON output:\n', (res.stdout || '').slice(0, 300));
      return false;
    }
  }
  log('\u2717 SMOKE TEST FAILED.');
  if (res.stderr) log('  stderr:', res.stderr.slice(0, 400));
  log('  Common causes: missing/invalid GMGN_API_KEY, IPv6-only network (GMGN needs IPv4), or gmgn-cli not installed.');
  return false;
}

// ---- main ------------------------------------------------------------------
async function main() {
  log('GMGN setup helper');
  log(`  project root: ${PROJECT_ROOT}`);
  log(`  .env path   : ${ENV_PATH}`);
  hr();

  if (TEST_ONLY) {
    if (!NO_INSTALL) ensureGmgnCli();
    process.exitCode = smokeTest() ? 0 : 1;
    return;
  }

  generateKeys();
  ensureGitignore();

  if (KEYS_ONLY) {
    printUploadInstructions();
    return;
  }

  const apiKey = await resolveApiKey();
  if (!apiKey) {
    printUploadInstructions();
    log('No API key provided yet \u2014 mint one with the public key above, then re-run with --api-key=.');
    return;
  }

  upsertEnv('GMGN_API_KEY', apiKey);
  process.env.GMGN_API_KEY = apiKey; // so the smoke test sees it this run

  if (!NO_INSTALL) {
    const ok = ensureGmgnCli();
    if (!ok && !NO_TEST) { process.exitCode = 1; return; }
  }
  if (!NO_TEST) {
    process.exitCode = smokeTest() ? 0 : 1;
  }
  hr();
  log('Done. To enable the hunter, set GOLD_HUNTER_ENABLED=true in your .env.');
}

main().catch((e) => { console.error('Fatal:', e?.message || e); process.exitCode = 1; });
