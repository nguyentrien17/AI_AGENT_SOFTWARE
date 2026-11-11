/* global process, setTimeout, clearTimeout, fetch, WebSocket, console */
/* eslint-disable no-console */
// Usage: start the API on a fresh data dir with the UI built (npm run build:web), then
// node scripts/ui-smoke.mjs http://127.0.0.1:8787   (EDGE_PATH=<chrome or edge executable> to override)
// or simply `npm run smoke:ui`, which builds the UI and starts/stops a throwaway API (scripts/ui-smoke-ci.mjs).
// UI smoke test: drives a headless Chromium browser (Edge or Chrome) through the Chrome DevTools Protocol
// (Node 22 WebSocket, no deps). Exits 1 when a step fails or the page logs a JavaScript error.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const CANDIDATES =
  process.platform === 'win32'
    ? ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe']
    : process.platform === 'darwin'
      ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge']
      : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge'];
const EDGE = process.env.EDGE_PATH ?? CANDIDATES.find((p) => existsSync(p));
if (!EDGE) {
  console.error(`No Chromium-based browser found; set EDGE_PATH. Looked in: ${CANDIDATES.join(', ')}`);
  process.exit(2);
}
const BASE = process.argv[2] ?? 'http://127.0.0.1:8797';
const PORT = Number(process.env.CDP_PORT ?? 9333);
const profile = mkdtempSync(path.join(tmpdir(), 'edge-cdp-'));
const flags = ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`];
// CI containers often lack the user namespaces Chrome's sandbox needs.
if (process.platform === 'linux') flags.push('--no-sandbox', '--disable-dev-shm-usage');
const browser = spawn(EDGE, [...flags, 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Watchdog: never hang a terminal or a CI job (e.g. a browser that dies or stops answering CDP).
const LIMIT_MS = Number(process.env.SMOKE_TIMEOUT_MS ?? 300_000);
setTimeout(() => {
  console.error(`ui-smoke: overall time limit of ${LIMIT_MS} ms exceeded`);
  browser.kill();
  process.exit(1);
}, LIMIT_MS).unref();

let targets = [];
for (let i = 0; i < 50 && !targets.find((t) => t.type === 'page'); i++) {
  await sleep(200);
  targets = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json()).catch(() => []);
}
const page = targets.find((t) => t.type === 'page');
if (!page) {
  console.error(`Browser did not expose a DevTools page on port ${PORT} (${EDGE}). Is loopback access allowed?`);
  browser.kill();
  process.exit(2);
}
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true });
  ws.addEventListener('error', () => reject(new Error('DevTools WebSocket failed to open')), { once: true });
});
let id = 0;
const pending = new Map();
const problems = [];
ws.addEventListener('message', (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  } else if (msg.method === 'Runtime.exceptionThrown') {
    problems.push(`exception: ${msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text}`);
  } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
    problems.push(`console.error: ${msg.params.args.map((a) => a.value ?? a.description).join(' ')}`);
  }
});
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const n = ++id;
    const timer = setTimeout(() => {
      pending.delete(n);
      reject(new Error(`CDP ${method} got no answer within 20 s`));
    }, 20_000);
    pending.set(n, (msg) => {
      clearTimeout(timer);
      resolve(msg);
    });
    ws.send(JSON.stringify({ id: n, method, params }));
  });
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error(`eval failed: ${r.result.exceptionDetails.text} :: ${expression.slice(0, 120)}`);
  return r.result?.result?.value;
};
const text = () => evaluate('document.body.innerText');
// Case-insensitive: innerText applies CSS `text-transform` (e.g. Tailwind `uppercase` labels read "MODEL CALLS").
async function waitFor(needle, timeout = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if ((await text()).toLowerCase().includes(needle.toLowerCase())) return;
    await sleep(200);
  }
  throw new Error(`timed out waiting for "${needle}". Page text:\n${(await text()).slice(0, 1500)}`);
}
async function waitForAny(needles, timeout = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const t = (await text()).toLowerCase();
    const hit = needles.find((n) => t.includes(n.toLowerCase()));
    if (hit) return hit;
    await sleep(250);
  }
  throw new Error(`timed out waiting for any of ${JSON.stringify(needles)}. Page text:\n${(await text()).slice(0, 1500)}`);
}
const go = async (p) => {
  await send('Page.navigate', { url: BASE + p });
  await sleep(500);
};
const click = (label, nth = 0) =>
  evaluate(`(() => { const b = [...document.querySelectorAll('button')].filter(b => b.textContent.trim() === ${JSON.stringify(label)})[${nth}]; if (!b) throw new Error('no button ${label}'); b.click(); return true; })()`);
const clickLink = (label) =>
  evaluate(`(() => { const a = [...document.querySelectorAll('a')].find(a => a.textContent.trim() === ${JSON.stringify(label)}); if (!a) throw new Error('no link ${label}'); a.click(); return true; })()`);
const fill = (label, value) =>
  evaluate(`(() => {
    const l = [...document.querySelectorAll('label')].find(l => l.querySelector('span')?.textContent.trim() === ${JSON.stringify(label)});
    if (!l) throw new Error('no field ${label}');
    const el = l.querySelector('input, textarea, select');
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
    return true;
  })()`);
const fillTextarea = (value) =>
  evaluate(`(() => { const el = document.querySelector('textarea'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);

const steps = [];
let failed = false;
const step = async (name, fn) => {
  await fn();
  steps.push(`ok  ${name}`);
};
try {
  await send('Runtime.enable');
  await send('Page.enable');
  await step('first run shows the owner setup', async () => {
    await go('/');
    await waitFor('Create the owner account');
  });
  await step('bootstrap + sign in through the form', async () => {
    await fill('Display name', 'UI Owner');
    await fill('Email', 'ui-owner@example.com');
    await fill('Password', 'a-long-ui-password');
    await click('Create account');
    await waitFor('New project');
  });
  await step('load agent library', async () => {
    await clickLink('Agents & workflows');
    await waitFor('Load agent library');
    await click('Load agent library');
    await waitFor('Business Analyst');
    await waitFor('Default SDLC');
    await waitFor('Secure coding');
  });
  await step('create a project', async () => {
    await clickLink('Projects');
    await waitFor('New project');
    await fill('Key', 'ui-smoke');
    await fill('Name', 'UI Smoke');
    await click('Create project');
    await waitFor('UI Smoke');
  });
  await step('open the project, write and approve the request', async () => {
    await clickLink('UI Smoke');
    await waitFor('Workflow runs');
    await fillTextarea('# Smoke\nA tiny app.');
    await click('Save & approve');
    await waitFor('v1 approved');
  });
  await step('start a workflow run', async () => {
    await click('Start');
    await waitFor('running');
    await click('Steps');
    await waitFor('requirements');
  });
  await step('tabs: tasks, artifacts, approvals, live events', async () => {
    await click('Tasks');
    await waitFor('Business analysis');
    await click('Artifacts');
    await waitFor('request.md');
    await evaluate(`[...document.querySelectorAll('button')].find(b => b.textContent.includes('request.md')).click()`);
    await waitFor('A tiny app.');
    await evaluate(`[...document.querySelectorAll('button')].find(b => b.textContent.startsWith('Approvals')).click()`);
    await waitFor('No approval requests');
    await click('Live events');
    await waitFor('streaming');
  });
  await step('task page with lineage', async () => {
    await click('Tasks');
    await waitFor('Business analysis');
    await clickLink('Business analysis');
    await waitFor('Why this task exists');
    await waitFor('Who scheduled it');
  });
  await step('AI: add a provider, a model, an assignment, view budgets', async () => {
    await clickLink('AI models');
    await waitFor('Add provider');
    await click('Local Ollama');
    await click('Add provider');
    await waitFor('local-ollama');
    await click('Models');
    await waitFor('Register a model');
    await fill('Model key', 'qwen2.5-coder');
    await click('Register');
    await waitFor('qwen2.5-coder');
    await click('Agent assignments');
    await waitFor('Assign a model');
    await click('Save');
    await waitFor('qwen2.5-coder	v1');
    await click('Which model for developer?');
    await waitFor('developer →');
    await click('Budgets');
    await waitFor('Set a budget');
  });
  await step('AI: replace and revoke a provider key (only a masked hint is shown)', async () => {
    await click('Providers');
    await waitFor('Replace or revoke a key');
    await fill('New API key', 'smoke-test-key-123456');
    await click('Save key');
    await waitFor('Key replaced');
    if ((await text()).includes('smoke-test-key-123456')) throw new Error('plaintext key visible in the page');
    await evaluate('window.confirm = () => true');
    await click('Revoke key');
    await waitFor('Key revoked');
  });
  await step('AI: playground run is recorded and shown (result or provider error)', async () => {
    await click('Playground');
    await waitFor('No benchmarks saved yet.');
    await evaluate(`(() => { const l = [...document.querySelectorAll('label')].find(l => l.textContent.includes('qwen2.5-coder')); l.querySelector('input').click(); return true; })()`);
    await fill('User prompt', 'Say hello.');
    await click('Run');
    // No Ollama runs in the smoke environment, so a provider error is the expected outcome; a live one shows results.
    await waitForAny(['contacting provider', 'Results', 'unknown_error', 'timeout']);
  });
  await step('costs page', async () => {
    await clickLink('Costs');
    await waitFor('Model calls');
    await waitFor('Estimated cost');
    await waitFor('By agent');
    await fill('Group by', 'model');
    await waitFor('By model');
  });
  await step('sign out returns to sign in', async () => {
    await click('Sign out');
    await waitFor('Sign in');
  });
} catch (err) {
  failed = true;
  steps.push(`FAIL ${err.message}`);
  try {
    steps.push(`URL: ${await evaluate('location.href')}`);
    steps.push(`HTML: ${(await evaluate('document.documentElement.outerHTML')).slice(0, 1500)}`);
  } catch (inner) {
    steps.push(`(page state unavailable: ${inner.message})`);
  }
}
console.log(steps.join('\n'));
console.log(problems.length ? `JS problems:\n${problems.join('\n')}` : 'JS problems: none');
ws.close();
browser.kill();
process.exit(failed || problems.length ? 1 : 0);
