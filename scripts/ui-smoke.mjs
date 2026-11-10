/* global process, setTimeout, fetch, WebSocket, console */
/* eslint-disable no-console */
// Usage: start the API on a fresh data dir with the UI built (npm run build:web), then
// node scripts/ui-smoke.mjs http://127.0.0.1:8787   (EDGE_PATH=<chrome or edge executable> to override)
// UI smoke test: drives headless Edge through the Chrome DevTools Protocol (Node 22 WebSocket, no deps).
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const EDGE = process.env.EDGE_PATH ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const BASE = process.argv[2] ?? 'http://127.0.0.1:8797';
const PORT = 9333;
const profile = mkdtempSync(path.join(tmpdir(), 'edge-cdp-'));
const browser = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let targets = [];
for (let i = 0; i < 50 && !targets.find((t) => t.type === 'page'); i++) {
  await sleep(200);
  targets = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json()).catch(() => []);
}
const page = targets.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
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
  new Promise((resolve) => {
    const n = ++id;
    pending.set(n, resolve);
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
  await step('costs page', async () => {
    await clickLink('Costs');
    await waitFor('Model calls');
    await waitFor('Estimated cost');
    await waitFor('By agent');
    await waitFor('No model calls yet.');
    await fill('Group by', 'model');
    await waitFor('By model');
  });
  await step('sign out returns to sign in', async () => {
    await click('Sign out');
    await waitFor('Sign in');
  });
} catch (err) {
  steps.push(`FAIL ${err.message}`);
  steps.push(`URL: ${await evaluate('location.href')}`);
  steps.push(`HTML: ${(await evaluate('document.documentElement.outerHTML')).slice(0, 1500)}`);
}
console.log(steps.join('\n'));
console.log(problems.length ? `JS problems:\n${problems.join('\n')}` : 'JS problems: none');
ws.close();
browser.kill();
process.exit(0);
