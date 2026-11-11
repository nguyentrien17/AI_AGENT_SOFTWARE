// @vitest-environment jsdom
/**
 * Web UI component tests (R29). The API is replaced by a TEST-ONLY in-memory `fetch` stub (Blueprint §20.3):
 * it answers only the routes each test declares and records every request so the tests can assert on what
 * the UI actually sent.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AiPage } from '../src/pages/Ai';
import { CostsPage } from '../src/pages/Costs';
import { ErrorNote, Table, Td } from '../src/components/ui';
import { ApiError } from '../src/api/client';

interface Recorded {
  method: string;
  path: string;
  body: unknown;
}
type Handler = (req: Recorded) => { status?: number; body: unknown };

/** TEST-ONLY: route table keyed by "METHOD /path" (path without the /api/v1 prefix, query string included). */
function stubApi(routes: Record<string, Handler | unknown>): Recorded[] {
  const calls: Recorded[] = [];
  vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const path = String(input).replace(/^\/api\/v1/, '');
    const req: Recorded = { method, path, body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(req);
    const route = routes[`${method} ${path}`];
    if (route === undefined) {
      return new Response(JSON.stringify({ code: 'route_not_found', detail: `TEST-ONLY stub has no ${method} ${path}` }), { status: 404 });
    }
    const out = typeof route === 'function' ? (route as Handler)(req) : { body: route };
    return new Response(JSON.stringify(out.body), { status: out.status ?? 200, headers: { 'content-type': 'application/json' } });
  });
  return calls;
}

function renderWithQuery(ui: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const totals = (n: number, cost: string, unpriced = 0) => ({
  invocations: n,
  succeeded: n,
  failed: 0,
  inputTokens: n * 100,
  outputTokens: n * 10,
  cachedTokens: 0,
  reasoningTokens: 0,
  estimatedCostUsd: cost,
  actualCostUsd: null,
  unpricedInvocations: unpriced,
});

describe('Costs page', () => {
  it('shows totals and groups, explains unpriced calls, and refetches when the grouping changes', async () => {
    const calls = stubApi({
      'GET /ai/costs/breakdown?groupBy=agent': {
        totals: totals(3, '0.012000', 1),
        groups: [
          { key: 'architect', label: 'architect', ...totals(2, '0.010000') },
          { key: 'developer', label: 'developer', ...totals(1, '0.002000', 1) },
        ],
      },
      'GET /ai/costs/breakdown?groupBy=model': {
        totals: totals(3, '0.012000', 1),
        groups: [{ key: 'm1', label: 'gpt-4.1', ...totals(3, '0.012000', 1) }],
      },
    });
    renderWithQuery(<CostsPage />);

    expect(await screen.findByText('architect')).toBeTruthy();
    expect(screen.getByText('Model calls')).toBeTruthy();
    expect(screen.getByText('$0.012000')).toBeTruthy();
    expect(screen.getByText(/1 call\(s\) have no price/)).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Group by'), { target: { value: 'model' } });
    expect(await screen.findByText('gpt-4.1')).toBeTruthy();
    expect(screen.getByText('By model')).toBeTruthy();
    expect(calls.map((c) => c.path)).toContain('/ai/costs/breakdown?groupBy=model');
  });

  it('shows the API error instead of an empty page', async () => {
    stubApi({ 'GET /ai/costs/breakdown?groupBy=agent': () => ({ status: 403, body: { code: 'forbidden', detail: 'Role lacks ai.config.read' } }) });
    renderWithQuery(<CostsPage />);
    expect(await screen.findByText(/Role lacks ai.config.read/)).toBeTruthy();
    expect(screen.getByText('(forbidden)')).toBeTruthy();
  });
});

const provider = (maskedHint: string | null) => ({
  id: 'p1',
  providerKey: 'openai-main',
  displayName: 'OpenAI Main',
  adapterType: 'openai_compatible',
  baseUrl: 'https://api.openai.com/v1',
  healthStatus: 'healthy',
  credential: { hasCredential: maskedHint !== null, maskedHint },
});

describe('AI models — provider key replace / revoke', () => {
  it('sends the new key once, shows only the masked hint, and never renders the plaintext', async () => {
    const secret = 'sk-proj-NEVER-SHOWN-998877';
    const calls = stubApi({
      'GET /ai/providers': { items: [provider('sk-****1122')] },
      'PUT /ai/providers/p1/credential': () => ({ body: provider('sk-****8877') }),
    });
    renderWithQuery(<AiPage />);

    const card = (await screen.findByText('Replace or revoke a key')).closest('section')!;
    expect(within(card).getByText('sk-****1122')).toBeTruthy();
    fireEvent.change(within(card).getByLabelText(/New API key/), { target: { value: secret } });
    fireEvent.click(within(card).getByRole('button', { name: 'Save key' }));

    expect(await screen.findByText('Key replaced — key sk-****8877')).toBeTruthy();
    expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({ apiKey: secret });
    expect(document.body.innerHTML).not.toContain(secret);
    expect((within(card).getByLabelText(/New API key/) as HTMLInputElement).value).toBe('');
  });

  it('revokes only after confirmation', async () => {
    const calls = stubApi({
      'GET /ai/providers': { items: [provider('sk-****1122')] },
      'DELETE /ai/providers/p1/credential': () => ({ body: provider(null) }),
    });
    renderWithQuery(<AiPage />);
    const card = (await screen.findByText('Replace or revoke a key')).closest('section')!;

    vi.stubGlobal('confirm', () => false);
    fireEvent.click(within(card).getByRole('button', { name: 'Revoke key' }));
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);

    vi.stubGlobal('confirm', () => true);
    fireEvent.click(within(card).getByRole('button', { name: 'Revoke key' }));
    expect(await screen.findByText('Key revoked — no key stored')).toBeTruthy();
  });
});

const model = (id: string, modelKey: string) => ({
  id,
  providerId: 'p1',
  providerKey: 'openai-main',
  modelKey,
  qualityTier: 'standard',
  availability: 'available',
  capabilities: {},
  activePricing: { inputPerMtok: '2.00', outputPerMtok: '8.00' },
});
const runResult = (runId: string, modelKey: string, output: string) => ({
  run: { id: runId, modelId: 'm1', output, error: null, comparisonId: null, createdAt: '2026-11-10T00:00:00Z' },
  providerKey: 'openai-main',
  modelKey,
  durationMs: 42,
  usage: { inputTokens: 12, outputTokens: 5, cachedTokens: null, reasoningTokens: null },
  estimatedCost: '0.000064',
  currency: 'USD',
  preflightEstimatedCostUsd: '0.060000',
  costWarningTriggered: true,
});

async function openPlayground(routes: Record<string, Handler | unknown>) {
  const calls = stubApi({
    'GET /ai/providers': { items: [] },
    'GET /ai/models': { items: [model('m1', 'gpt-4.1'), model('m2', 'gpt-4.1-mini')] },
    'GET /agents': { items: [] },
    'GET /ai/playground/benchmarks': { items: [] },
    ...routes,
  });
  renderWithQuery(<AiPage />);
  fireEvent.click(await screen.findByRole('button', { name: 'Playground' }));
  await screen.findByLabelText(/gpt-4\.1-mini/);
  fireEvent.change(screen.getByLabelText('User prompt'), { target: { value: 'Say hello.' } });
  return calls;
}

describe('AI models — Playground', () => {
  it('asks before an expensive run and only then sends acknowledgeCostWarning', async () => {
    const calls = await openPlayground({
      'POST /ai/playground/run': (req: Recorded) =>
        (req.body as { acknowledgeCostWarning: boolean }).acknowledgeCostWarning
          ? { body: runResult('r1', 'gpt-4.1', 'Hello from gpt-4.1') }
          : { status: 422, body: { code: 'playground_cost_warning_required', detail: 'needs ack', preflightEstimatedCostUsd: '0.060000' } },
    });
    fireEvent.click(screen.getByLabelText(/^gpt-4\.1 openai-main/));
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));

    expect(await screen.findByText(/estimated to cost up to/)).toBeTruthy();
    expect(screen.getByText('$0.060000')).toBeTruthy();
    expect(screen.queryByText('Hello from gpt-4.1')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Run anyway' }));
    expect(await screen.findByText('Hello from gpt-4.1')).toBeTruthy();
    const runs = calls.filter((c) => c.path === '/ai/playground/run').map((c) => c.body as Record<string, unknown>);
    expect(runs.map((b) => b['acknowledgeCostWarning'])).toEqual([false, true]);
    expect(runs[0]).toMatchObject({ modelId: 'm1', userPrompt: 'Say hello.', params: { maxOutputTokens: 256 } });
    expect(screen.queryByText(/estimated to cost up to/)).toBeNull();
  });

  it('compares several models side by side and saves a benchmark of the runs', async () => {
    const calls = await openPlayground({
      'POST /ai/playground/compare': {
        comparisonId: 'c1',
        totalEstimatedCostUsd: '0.000128',
        results: [runResult('r1', 'gpt-4.1', 'Answer A'), runResult('r2', 'gpt-4.1-mini', 'Answer B')],
      },
      'POST /ai/playground/benchmarks': { id: 'b1', name: 'Greeting', runIds: ['r1', 'r2'], notes: '', createdAt: '2026-11-10T00:00:00Z' },
    });
    fireEvent.click(screen.getByLabelText(/^gpt-4\.1 openai-main/));
    fireEvent.click(screen.getByLabelText(/^gpt-4\.1-mini/));
    fireEvent.click(screen.getByRole('button', { name: 'Compare 2 models' }));

    expect(await screen.findByText('Answer A')).toBeTruthy();
    expect(screen.getByText('Answer B')).toBeTruthy();
    expect(calls.find((c) => c.path === '/ai/playground/compare')?.body).toMatchObject({ modelIds: ['m1', 'm2'] });

    fireEvent.change(screen.getByPlaceholderText('Benchmark name'), { target: { value: 'Greeting' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save benchmark' }));
    await waitFor(() => expect(calls.some((c) => c.path === '/ai/playground/benchmarks' && c.method === 'POST')).toBe(true));
    expect(calls.find((c) => c.method === 'POST' && c.path === '/ai/playground/benchmarks')?.body).toEqual({ name: 'Greeting', runIds: ['r1', 'r2'] });
  });

  it('shows a hard cost-cap rejection as an error, not as a warning', async () => {
    await openPlayground({
      'POST /ai/playground/run': () => ({ status: 422, body: { code: 'playground_cost_cap_exceeded', detail: 'exceeds hard cap' } }),
    });
    fireEvent.click(screen.getByLabelText(/^gpt-4\.1 openai-main/));
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    expect(await screen.findByText(/exceeds hard cap/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Run anyway' })).toBeNull();
  });
});

describe('ui primitives', () => {
  it('Table shows its empty text when there are no rows', () => {
    render(<Table head={['A']} empty="Nothing here">{[]}</Table>);
    expect(screen.getByText('Nothing here')).toBeTruthy();
    cleanup();
    render(<Table head={['A']}>{[<tr key="1"><Td>row</Td></tr>]}</Table>);
    expect(screen.getByText('row')).toBeTruthy();
    expect(screen.queryByText('Nothing yet')).toBeNull();
  });

  it('ErrorNote renders the API problem message and code', () => {
    render(<ErrorNote error={new ApiError(422, { detail: 'Budget exhausted', code: 'budget_blocked' })} />);
    expect(screen.getByText(/Budget exhausted/)).toBeTruthy();
    expect(screen.getByText('(budget_blocked)')).toBeTruthy();
  });
});
