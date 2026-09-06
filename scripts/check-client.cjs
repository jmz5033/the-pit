#!/usr/bin/env node
// Load-time smoke test for public/index.html.
//
// Parsing the script (new vm.Script) is NOT enough: a temporal dead zone
// violation — reading a `const`/`let` declared further down the file — parses
// fine and throws at evaluation. Because the client is one big script block,
// that kills everything after it, including the join handler, and the app
// sits on the login screen with a dead button. That shipped once.
//
// This executes the block against stubbed browser globals and asserts the
// key globals actually bound. Run: node scripts/check-client.cjs
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const file = process.argv[2] || path.join(__dirname, '..', 'public', 'index.html');
const html = fs.readFileSync(file, 'utf8');

const blocks = [...html.matchAll(/<script(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/g)]
  .filter((m) => !/type\s*=\s*["']module["']/.test(m[1] || ''));

const noop = () => {};
const el = () => new Proxy({}, {
  get: (t, k) => {
    if (k === 'classList') return { add: noop, remove: noop, toggle: noop, contains: () => false };
    if (k === 'style') return {};
    if (k === 'addEventListener') return noop;
    if (k === 'querySelector' || k === 'closest') return () => null;
    if (k === 'querySelectorAll') return () => [];
    if (k === 'getAttribute') return () => null;
    if (k === 'focus' || k === 'blur' || k === 'click') return noop;
    return undefined;
  },
  set: () => true,
});

const sandbox = {
  console,
  document: {
    getElementById: () => el(), querySelector: () => el(), querySelectorAll: () => [],
    addEventListener: noop, createElement: () => el(), body: el(), documentElement: el(),
    visibilityState: 'visible',
  },
  window: {
    addEventListener: noop, location: { origin: 'https://x', href: 'https://x/', hostname: 'x' },
    matchMedia: () => ({ matches: false, addEventListener: noop }), navigator: {},
  },
  navigator: { serviceWorker: { register: () => Promise.resolve({}), ready: Promise.resolve({}) }, userAgent: 'node' },
  localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
  location: { origin: 'https://x', href: 'https://x/', hostname: 'x' },
  fetch: () => Promise.resolve({ ok: true, status: 200, json: async () => ({}), text: async () => '' }),
  setTimeout, clearTimeout, setInterval, clearInterval,
  Date, Math, JSON, Intl, Promise, Set, Map, Object, Array, String, Number, Boolean, RegExp, Error,
  encodeURIComponent, decodeURIComponent, parseInt, parseFloat, isNaN, isFinite, btoa, atob,
  crypto: { getRandomValues: (a) => a, subtle: {} },
  alert: noop, confirm: () => true, requestAnimationFrame: noop,
};
sandbox.window.document = sandbox.document;
sandbox.globalThis = sandbox;
sandbox.self = sandbox;
vm.createContext(sandbox);

// Globals whose absence means the app is broken, not merely different.
const REQUIRED = [
  'SEED_POOL', 'FOLLOW_PORTFOLIOS', 'THEMES', 'MARKET_HOLIDAYS',
  'subPicker', 'activeSubItem', 'currentSeedPool', 'renderDraftPane',
  'addPick', 'isQuotable', 'getQuotesBatch',
  'getLockTime', 'firstTradingDay', 'lastTradingDay',
  'computePlayerStats', 'weekPortfolios', 'renderStats',
  'switchTab', 'loadWeek', 'renderWeek',
];

let failed = false;
console.log(`checking ${path.relative(process.cwd(), file)} — ${blocks.length} non-module script block(s)`);

blocks.forEach((b, i) => {
  try {
    new vm.Script(b[2], { filename: `index.html:block${i}` }).runInContext(sandbox, { timeout: 10000 });
    console.log(`  block ${i}: executed OK`);
  } catch (e) {
    console.log(`  block ${i}: RUNTIME ERROR -> ${e.name}: ${e.message}`);
    failed = true;
  }
});

const missing = REQUIRED.filter((n) => {
  try { return !new vm.Script(`typeof ${n} !== 'undefined'`).runInContext(sandbox); }
  catch { return true; }
});
if (missing.length) {
  console.log(`  missing globals: ${missing.join(', ')}`);
  failed = true;
} else {
  console.log(`  all ${REQUIRED.length} required globals bound`);
}

console.log(failed ? 'FAILED' : 'OK');
process.exit(failed ? 1 : 0);
