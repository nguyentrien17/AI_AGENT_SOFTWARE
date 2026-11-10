import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { ApiError, del, errorMessage, get, post, put } from '../api/client';
import type { Agent, Budget, Model, ModelConfig, Page, PlaygroundBenchmark, PlaygroundCompareResult, PlaygroundRunResult, Provider } from '../api/types';
import { Badge, Button, Card, ErrorNote, Input, Label, Mono, Muted, Select, Table, Tabs, Td, Textarea, when } from '../components/ui';

type Tab = 'providers' | 'models' | 'assignments' | 'budgets' | 'playground';

export function AiPage() {
  const [tab, setTab] = useState<Tab>('providers');
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">AI models</h1>
      <Tabs<Tab>
        value={tab}
        onChange={setTab}
        tabs={[
          ['providers', 'Providers'],
          ['models', 'Models'],
          ['assignments', 'Agent assignments'],
          ['budgets', 'Budgets'],
          ['playground', 'Playground'],
        ]}
      />
      {tab === 'providers' && <Providers />}
      {tab === 'models' && <Models />}
      {tab === 'assignments' && <Assignments />}
      {tab === 'budgets' && <Budgets />}
      {tab === 'playground' && <Playground />}
    </div>
  );
}

const PRESETS: Record<string, { adapterType: string; baseUrl: string }> = {
  OpenAI: { adapterType: 'openai_compatible', baseUrl: 'https://api.openai.com/v1' },
  Anthropic: { adapterType: 'anthropic', baseUrl: 'https://api.anthropic.com/v1' },
  Gemini: { adapterType: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com' },
  'Local Ollama': { adapterType: 'openai_compatible', baseUrl: 'http://127.0.0.1:11434/v1' },
};

function Providers() {
  const qc = useQueryClient();
  const providers = useQuery({ queryKey: ['providers'], queryFn: () => get<Page<Provider>>('/ai/providers') });
  const [form, setForm] = useState({ providerKey: '', displayName: '', adapterType: 'openai_compatible', baseUrl: '', apiKey: '' });
  const [results, setResults] = useState<Record<string, string>>({});
  const create = useMutation({
    mutationFn: () => post('/ai/providers', { ...form, ...(form.apiKey ? {} : { apiKey: undefined }) }),
    onSuccess: () => {
      setForm({ providerKey: '', displayName: '', adapterType: 'openai_compatible', baseUrl: '', apiKey: '' });
      void qc.invalidateQueries({ queryKey: ['providers'] });
    },
  });
  const test = useMutation({
    mutationFn: (p: Provider) => post<{ result: string; latencyMs: number }>(`/ai/providers/${p.id}/test`, { timeoutMs: 10000 }),
    onSuccess: (r, p) => {
      setResults((prev) => ({ ...prev, [p.id]: `${r.result} (${r.latencyMs} ms)` }));
      void qc.invalidateQueries({ queryKey: ['providers'] });
    },
    onError: (e, p) => setResults((prev) => ({ ...prev, [p.id]: errorMessage(e) })),
  });
  const sync = useMutation({
    mutationFn: (p: Provider) => post<{ added: unknown[] }>(`/ai/providers/${p.id}/sync-models`),
    onSuccess: (r, p) => {
      setResults((prev) => ({ ...prev, [p.id]: `imported ${r.added.length} model(s)` }));
      void qc.invalidateQueries({ queryKey: ['models'] });
    },
    onError: (e, p) => setResults((prev) => ({ ...prev, [p.id]: errorMessage(e) })),
  });
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate();
  };
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <Card title="Providers" className="lg:col-span-2">
        <ErrorNote error={providers.error} />
        <Table head={['Provider', 'Adapter', 'Health', 'Key', '']} empty="No providers yet.">
          {providers.data?.items.map((p) => (
            <tr key={p.id}>
              <Td><b>{p.displayName}</b> <Mono>{p.providerKey}</Mono><div className="text-xs text-slate-500">{p.baseUrl}</div>
                {results[p.id] && <div className="text-xs text-slate-700">{results[p.id]}</div>}</Td>
              <Td><Mono>{p.adapterType}</Mono></Td>
              <Td><Badge>{p.healthStatus}</Badge></Td>
              <Td className="text-xs">{p.credential.hasCredential ? p.credential.maskedHint ?? 'set' : 'none'}</Td>
              <Td className="whitespace-nowrap">
                <Button variant="secondary" onClick={() => test.mutate(p)} disabled={test.isPending}>Test</Button>{' '}
                <Button variant="secondary" onClick={() => sync.mutate(p)} disabled={sync.isPending}>Import models</Button>
              </Td>
            </tr>
          ))}
        </Table>
      </Card>
      <div className="space-y-4">
      <Card title="Add provider">
        <form onSubmit={onSubmit} className="space-y-3">
          <div className="flex flex-wrap gap-1">
            {Object.entries(PRESETS).map(([name, p]) => (
              <Button key={name} type="button" variant="ghost" className="border border-slate-200 text-xs"
                onClick={() => setForm({ ...form, ...p, displayName: form.displayName || name, providerKey: form.providerKey || name.toLowerCase().replace(/\s+/g, '-') })}>
                {name}
              </Button>
            ))}
          </div>
          <Label text="Key"><Input required value={form.providerKey} onChange={(e) => setForm({ ...form, providerKey: e.target.value })} /></Label>
          <Label text="Name"><Input required value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} /></Label>
          <Label text="Adapter">
            <Select value={form.adapterType} onChange={(e) => setForm({ ...form, adapterType: e.target.value })}>
              <option value="openai_compatible">OpenAI-compatible</option>
              <option value="anthropic">Anthropic</option>
              <option value="gemini">Gemini</option>
            </Select>
          </Label>
          <Label text="Base URL"><Input required value={form.baseUrl} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} /></Label>
          <Label text="API key" hint="Encrypted with the master key; never shown again.">
            <Input type="password" value={form.apiKey} onChange={(e) => setForm({ ...form, apiKey: e.target.value })} autoComplete="off" />
          </Label>
          <ErrorNote error={create.error} />
          <Button type="submit" disabled={create.isPending}>Add provider</Button>
        </form>
      </Card>
      <ProviderKey providers={providers.data?.items ?? []} />
      </div>
    </div>
  );
}

/** Rotate or revoke a provider's API key (Blueprint §3.2). The key is write-only: only a masked hint is ever shown. */
function ProviderKey({ providers }: { providers: Provider[] }) {
  const qc = useQueryClient();
  const [providerId, setProviderId] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [done, setDone] = useState('');
  const target = providers.find((p) => p.id === providerId) ?? providers[0];
  const after = (msg: string) => (p: Provider) => {
    setApiKey('');
    setDone(`${msg} — ${p.credential.hasCredential ? `key ${p.credential.maskedHint ?? 'set'}` : 'no key stored'}`);
    void qc.invalidateQueries({ queryKey: ['providers'] });
  };
  const rotate = useMutation({ mutationFn: () => put<Provider>(`/ai/providers/${target!.id}/credential`, { apiKey }), onSuccess: after('Key replaced') });
  const revoke = useMutation({ mutationFn: () => del<Provider>(`/ai/providers/${target!.id}/credential`), onSuccess: after('Key revoked') });
  if (!providers.length) return null;
  return (
    <Card title="Replace or revoke a key">
      <form onSubmit={(e) => { e.preventDefault(); setDone(''); rotate.mutate(); }} className="space-y-3">
        <Label text="Provider">
          <Select value={target?.id ?? ''} onChange={(e) => { setProviderId(e.target.value); setDone(''); }}>
            {providers.map((p) => <option key={p.id} value={p.id}>{p.displayName}</option>)}
          </Select>
        </Label>
        <Muted>Current key: {target?.credential.hasCredential ? <Mono>{target.credential.maskedHint ?? 'set'}</Mono> : 'none'}</Muted>
        <Label text="New API key" hint="The old key is deactivated; the change is audited (masked hint only).">
          <Input type="password" required value={apiKey} onChange={(e) => setApiKey(e.target.value)} autoComplete="off" />
        </Label>
        <ErrorNote error={rotate.error ?? revoke.error} />
        {done && <p className="text-sm text-emerald-700">{done}</p>}
        <div className="flex gap-2">
          <Button type="submit" disabled={rotate.isPending || !apiKey.trim()}>Save key</Button>
          <Button type="button" variant="danger" disabled={revoke.isPending || !target?.credential.hasCredential}
            onClick={() => { setDone(''); if (window.confirm(`Revoke the key of ${target!.displayName}? Calls to this provider will fail until a new key is saved.`)) revoke.mutate(); }}>
            Revoke key
          </Button>
        </div>
      </form>
    </Card>
  );
}

const CAPS = ['structured_output', 'tool_calling', 'reasoning', 'vision', 'streaming'] as const;

function Models() {
  const qc = useQueryClient();
  const providers = useQuery({ queryKey: ['providers'], queryFn: () => get<Page<Provider>>('/ai/providers') });
  const models = useQuery({ queryKey: ['models'], queryFn: () => get<Page<Model>>('/ai/models') });
  const [form, setForm] = useState({ providerId: '', modelKey: '', qualityTier: 'standard', contextWindow: '', inputPerMtok: '', outputPerMtok: '' });
  const [caps, setCaps] = useState<Record<string, boolean>>({ structured_output: true, tool_calling: true });
  const create = useMutation({
    mutationFn: () =>
      post('/ai/models', {
        providerId: form.providerId || providers.data?.items[0]?.id,
        modelKey: form.modelKey,
        availability: 'available',
        qualityTier: form.qualityTier,
        ...(form.contextWindow ? { contextWindow: Number(form.contextWindow) } : {}),
        capabilities: Object.fromEntries(CAPS.map((c) => [c, caps[c] ? 'yes' : 'unknown'])),
        ...(form.inputPerMtok && form.outputPerMtok ? { pricing: { inputPerMtok: form.inputPerMtok, outputPerMtok: form.outputPerMtok, verified: true } } : {}),
      }),
    onSuccess: () => {
      setForm({ ...form, modelKey: '' });
      void qc.invalidateQueries({ queryKey: ['models'] });
    },
  });
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <Card title="Models" className="lg:col-span-2">
        <ErrorNote error={models.error} />
        <Table head={['Model', 'Tier', 'Capabilities', 'Price / 1M in·out', 'Status']} empty="No models yet.">
          {models.data?.items.map((m) => (
            <tr key={m.id}>
              <Td><b>{m.modelKey}</b> <span className="text-xs text-slate-500">{m.providerKey}</span></Td>
              <Td><Badge tone={m.qualityTier === 'unknown' ? 'amber' : 'slate'}>{m.qualityTier}</Badge></Td>
              <Td className="text-xs">{Object.entries(m.capabilities).filter(([, v]) => v === 'yes').map(([k]) => k).join(', ') || <span className="text-amber-700">unverified</span>}</Td>
              <Td className="text-xs">{m.activePricing ? `$${m.activePricing.inputPerMtok} · $${m.activePricing.outputPerMtok}` : 'unknown'}</Td>
              <Td><Badge>{m.availability}</Badge></Td>
            </tr>
          ))}
        </Table>
      </Card>
      <Card title="Register a model">
        <form onSubmit={(e) => { e.preventDefault(); create.mutate(); }} className="space-y-3">
          <Label text="Provider">
            <Select value={form.providerId} onChange={(e) => setForm({ ...form, providerId: e.target.value })}>
              {providers.data?.items.map((p) => <option key={p.id} value={p.id}>{p.displayName}</option>)}
            </Select>
          </Label>
          <Label text="Model key" hint="Exactly as the provider names it, e.g. gpt-4.1 or claude-sonnet-4">
            <Input required value={form.modelKey} onChange={(e) => setForm({ ...form, modelKey: e.target.value })} />
          </Label>
          <Label text="Quality tier">
            <Select value={form.qualityTier} onChange={(e) => setForm({ ...form, qualityTier: e.target.value })}>
              {['economy', 'standard', 'high', 'frontier'].map((t) => <option key={t}>{t}</option>)}
            </Select>
          </Label>
          <Label text="Context window (tokens)"><Input type="number" value={form.contextWindow} onChange={(e) => setForm({ ...form, contextWindow: e.target.value })} /></Label>
          <div className="text-sm">
            <span className="font-medium text-slate-700">Capabilities</span>
            <div className="mt-1 grid grid-cols-2 gap-1">
              {CAPS.map((c) => (
                <label key={c} className="flex items-center gap-1.5 text-xs">
                  <input type="checkbox" checked={!!caps[c]} onChange={(e) => setCaps({ ...caps, [c]: e.target.checked })} /> {c}
                </label>
              ))}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Label text="$ / 1M input"><Input value={form.inputPerMtok} onChange={(e) => setForm({ ...form, inputPerMtok: e.target.value })} placeholder="2.00" /></Label>
            <Label text="$ / 1M output"><Input value={form.outputPerMtok} onChange={(e) => setForm({ ...form, outputPerMtok: e.target.value })} placeholder="8.00" /></Label>
          </div>
          <ErrorNote error={create.error} />
          <Button type="submit" disabled={create.isPending || !providers.data?.items.length}>Register</Button>
        </form>
      </Card>
    </div>
  );
}

function Assignments() {
  const qc = useQueryClient();
  const configs = useQuery({ queryKey: ['configs'], queryFn: () => get<Page<ModelConfig>>('/ai/configurations') });
  const models = useQuery({ queryKey: ['models'], queryFn: () => get<Page<Model>>('/ai/models') });
  const agents = useQuery({ queryKey: ['agents'], queryFn: () => get<Page<Agent>>('/agents') });
  const [form, setForm] = useState({ scope: 'global', agentKey: '', mode: 'fixed', primaryModelId: '', fallbackModelId: '' });
  const [preview, setPreview] = useState<string>('');
  const modelName = (id: string | null) => models.data?.items.find((m) => m.id === id)?.modelKey ?? '—';
  const save = useMutation({
    mutationFn: () =>
      put('/ai/configurations', {
        scope: form.scope,
        ...(form.scope === 'agent' ? { agentKey: form.agentKey } : {}),
        mode: form.mode,
        primaryModelId: form.primaryModelId || models.data?.items[0]?.id,
        ...(form.fallbackModelId ? { fallbackModelIds: [form.fallbackModelId] } : {}),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['configs'] }),
  });
  const resolve = useMutation({
    mutationFn: (agentKey: string) => post<{ providerKey: string; modelKey: string; explanation: Record<string, unknown> }>('/ai/router/resolve', { agentKey }),
    onSuccess: (r, agentKey) => setPreview(`${agentKey} → ${r.providerKey} / ${r.modelKey} (${String(r.explanation['selectionReason'])}, scope ${String(r.explanation['resolvedScope'])})`),
    onError: (e, agentKey) => setPreview(`${agentKey}: ${errorMessage(e)}`),
  });
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <Card title="Assignments" className="lg:col-span-2">
        <Muted>Precedence: task › workflow › project › agent › global. Agents never name a model themselves.</Muted>
        <ErrorNote error={configs.error} />
        <Table head={['Scope', 'Mode', 'Primary model', 'Version']} empty="No assignment yet — agents cannot run until there is at least a global one.">
          {configs.data?.items.map((c) => (
            <tr key={c.id}>
              <Td>{c.scope}{c.agentKey ? ` · ${c.agentKey}` : ''}</Td>
              <Td><Badge tone="blue">{c.mode}</Badge></Td>
              <Td>{modelName(c.primaryModelId)}</Td>
              <Td>v{c.configVersion}</Td>
            </tr>
          ))}
        </Table>
        <div className="mt-4 space-y-2">
          <div className="flex flex-wrap gap-1">
            {agents.data?.items.map((a) => (
              <Button key={a.id} variant="secondary" className="text-xs" onClick={() => resolve.mutate(a.agentKey)}>Which model for {a.agentKey}?</Button>
            ))}
          </div>
          {preview && <p className="rounded bg-slate-50 px-3 py-2 text-sm">{preview}</p>}
        </div>
      </Card>
      <Card title="Assign a model">
        <form onSubmit={(e) => { e.preventDefault(); save.mutate(); }} className="space-y-3">
          <Label text="Scope">
            <Select value={form.scope} onChange={(e) => setForm({ ...form, scope: e.target.value })}>
              <option value="global">global (all agents)</option>
              <option value="agent">one agent</option>
            </Select>
          </Label>
          {form.scope === 'agent' && (
            <Label text="Agent">
              <Select value={form.agentKey} onChange={(e) => setForm({ ...form, agentKey: e.target.value })}>
                <option value="">choose…</option>
                {agents.data?.items.map((a) => <option key={a.id} value={a.agentKey}>{a.name}</option>)}
              </Select>
            </Label>
          )}
          <Label text="Mode" hint="fixed: always this model · hybrid: upgrades for complex work · adaptive: best of an allowlist">
            <Select value={form.mode} onChange={(e) => setForm({ ...form, mode: e.target.value })}>
              <option>fixed</option>
              <option>hybrid</option>
              <option>adaptive</option>
            </Select>
          </Label>
          <Label text="Primary model">
            <Select value={form.primaryModelId} onChange={(e) => setForm({ ...form, primaryModelId: e.target.value })}>
              {models.data?.items.map((m) => <option key={m.id} value={m.id}>{m.modelKey} ({m.providerKey})</option>)}
            </Select>
          </Label>
          <Label text="Fallback model" hint="Used on timeouts, rate limits or provider errors.">
            <Select value={form.fallbackModelId} onChange={(e) => setForm({ ...form, fallbackModelId: e.target.value })}>
              <option value="">none</option>
              {models.data?.items.map((m) => <option key={m.id} value={m.id}>{m.modelKey} ({m.providerKey})</option>)}
            </Select>
          </Label>
          <ErrorNote error={save.error} />
          <Button type="submit" disabled={save.isPending || !models.data?.items.length}>Save</Button>
        </form>
      </Card>
    </div>
  );
}

function Budgets() {
  const qc = useQueryClient();
  const budgets = useQuery({ queryKey: ['budgets'], queryFn: () => get<Page<Budget>>('/budgets') });
  const [form, setForm] = useState({ level: 'system', scopeRefId: '', tokenLimit: '', costLimitUsd: '' });
  const save = useMutation({
    mutationFn: () =>
      put('/budgets', {
        level: form.level,
        ...(form.scopeRefId ? { scopeRefId: form.scopeRefId } : {}),
        ...(form.tokenLimit ? { tokenLimit: Number(form.tokenLimit) } : {}),
        ...(form.costLimitUsd ? { costLimitUsd: form.costLimitUsd } : {}),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['budgets'] }),
  });
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <Card title="Budgets" className="lg:col-span-2">
        <Muted>Warning at 70 %, non-essential work restricted at 85 %, halt with a checkpoint at 95 %. Raising a limit resumes work.</Muted>
        <ErrorNote error={budgets.error} />
        <Table head={['Level', 'Scope', 'Used', 'Limit', 'Band']} empty="No budgets (unlimited).">
          {budgets.data?.items.map((b) => (
            <tr key={b.id}>
              <Td>{b.level}</Td>
              <Td><Mono>{b.scopeRefId ?? '—'}</Mono></Td>
              <Td>
                <div className="h-2 w-32 rounded bg-slate-100"><div className="h-2 rounded bg-slate-700" style={{ width: `${Math.min(100, b.utilizationPct)}%` }} /></div>
                <span className="text-xs text-slate-500">{b.utilizationPct}% · {b.consumedTokens} tok · ${b.consumedCostUsd}</span>
              </Td>
              <Td className="text-xs">{b.tokenLimit ? `${b.tokenLimit} tok` : ''} {b.costLimitUsd ? `$${b.costLimitUsd}` : ''}</Td>
              <Td><Badge tone={b.halted ? 'red' : b.currentBand === 'normal' ? 'green' : 'amber'}>{b.currentBand}</Badge></Td>
            </tr>
          ))}
        </Table>
      </Card>
      <Card title="Set a budget">
        <form onSubmit={(e) => { e.preventDefault(); save.mutate(); }} className="space-y-3">
          <Label text="Level">
            <Select value={form.level} onChange={(e) => setForm({ ...form, level: e.target.value })}>
              {['system', 'project', 'workflow', 'task', 'invocation'].map((l) => <option key={l}>{l}</option>)}
            </Select>
          </Label>
          {['project', 'workflow', 'task'].includes(form.level) && (
            <Label text={`${form.level} id`}><Input value={form.scopeRefId} onChange={(e) => setForm({ ...form, scopeRefId: e.target.value })} /></Label>
          )}
          <Label text="Token limit"><Input type="number" value={form.tokenLimit} onChange={(e) => setForm({ ...form, tokenLimit: e.target.value })} /></Label>
          <Label text="Cost limit (USD)"><Input value={form.costLimitUsd} onChange={(e) => setForm({ ...form, costLimitUsd: e.target.value })} placeholder="25.00" /></Label>
          <ErrorNote error={save.error} />
          <Button type="submit" disabled={save.isPending}>Save budget</Button>
        </form>
      </Card>
    </div>
  );
}

/**
 * AI Playground (Blueprint §4.7): try one model or compare several on the same prompt. Runs are isolated
 * from live agent configurations; the API enforces the budget cap and asks for confirmation above the
 * cost-warning threshold before anything is sent to a provider.
 */
function Playground() {
  const qc = useQueryClient();
  const models = useQuery({ queryKey: ['models'], queryFn: () => get<Page<Model>>('/ai/models') });
  const agents = useQuery({ queryKey: ['agents'], queryFn: () => get<Page<Agent>>('/agents') });
  const benchmarks = useQuery({ queryKey: ['benchmarks'], queryFn: () => get<Page<PlaygroundBenchmark>>('/ai/playground/benchmarks') });
  const [selected, setSelected] = useState<string[]>([]);
  const [form, setForm] = useState({ simulatedRole: '', systemPrompt: '', userPrompt: '', maxOutputTokens: '256', temperature: '' });
  const [results, setResults] = useState<PlaygroundRunResult[]>([]);
  const [warning, setWarning] = useState<string | null>(null);
  const [benchName, setBenchName] = useState('');

  const run = useMutation({
    mutationFn: async (acknowledgeCostWarning: boolean): Promise<PlaygroundRunResult[]> => {
      const params = {
        maxOutputTokens: Number(form.maxOutputTokens) || 256,
        ...(form.temperature ? { temperature: Number(form.temperature) } : {}),
      };
      const body = {
        ...(form.simulatedRole ? { simulatedRole: form.simulatedRole } : {}),
        ...(form.systemPrompt.trim() ? { systemPrompt: form.systemPrompt } : {}),
        userPrompt: form.userPrompt,
        params,
        acknowledgeCostWarning,
      };
      if (selected.length === 1) return [await post<PlaygroundRunResult>('/ai/playground/run', { ...body, modelId: selected[0] })];
      return (await post<PlaygroundCompareResult>('/ai/playground/compare', { ...body, modelIds: selected })).results;
    },
    onMutate: () => setWarning(null),
    onSuccess: (r) => {
      setResults(r);
      void qc.invalidateQueries({ queryKey: ['costs'] });
    },
    onError: (e) => {
      if (e instanceof ApiError && e.code === 'playground_cost_warning_required') {
        setWarning(String(e.problem['preflightEstimatedCostUsd'] ?? '?'));
      }
    },
  });
  const save = useMutation({
    mutationFn: () => post('/ai/playground/benchmarks', { name: benchName, runIds: results.map((r) => r.run.id) }),
    onSuccess: () => {
      setBenchName('');
      void qc.invalidateQueries({ queryKey: ['benchmarks'] });
    },
  });
  const toggle = (id: string) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : s.length >= 5 ? s : [...s, id]));
  const runError = run.error instanceof ApiError && run.error.code === 'playground_cost_warning_required' ? null : run.error;

  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Prompt" className="lg:col-span-2">
          <form onSubmit={(e) => { e.preventDefault(); run.mutate(false); }} className="space-y-3">
            <Muted>Isolated from production: nothing here changes an agent's model assignment. Pick one model to try it, or 2–5 to compare them side by side.</Muted>
            <Label text="Simulate agent role" hint="Optional — recorded with the run for comparison.">
              <Select value={form.simulatedRole} onChange={(e) => setForm({ ...form, simulatedRole: e.target.value })}>
                <option value="">none</option>
                {agents.data?.items.map((a) => <option key={a.id} value={a.agentKey}>{a.name}</option>)}
              </Select>
            </Label>
            <Label text="System instructions"><Textarea rows={3} value={form.systemPrompt} onChange={(e) => setForm({ ...form, systemPrompt: e.target.value })} /></Label>
            <Label text="User prompt"><Textarea rows={5} required value={form.userPrompt} onChange={(e) => setForm({ ...form, userPrompt: e.target.value })} /></Label>
            <div className="grid grid-cols-2 gap-2">
              <Label text="Max output tokens" hint="1–8192"><Input type="number" min={1} max={8192} value={form.maxOutputTokens} onChange={(e) => setForm({ ...form, maxOutputTokens: e.target.value })} /></Label>
              <Label text="Temperature" hint="Empty = model default"><Input type="number" step="0.1" min={0} max={2} value={form.temperature} onChange={(e) => setForm({ ...form, temperature: e.target.value })} /></Label>
            </div>
            {warning && (
              <div className="space-y-2 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800">
                <p>This run is estimated to cost up to <b>${warning}</b>, above the playground warning threshold.</p>
                <Button type="button" variant="secondary" onClick={() => run.mutate(true)} disabled={run.isPending}>Run anyway</Button>
              </div>
            )}
            <ErrorNote error={runError} />
            <Button type="submit" disabled={run.isPending || !selected.length || !form.userPrompt.trim()}>
              {run.isPending ? 'Running…' : selected.length > 1 ? `Compare ${selected.length} models` : 'Run'}
            </Button>
          </form>
        </Card>
        <Card title={`Models (${selected.length} selected)`}>
          {!models.data?.items.length && <Muted>Register a model first (Models tab).</Muted>}
          <div className="space-y-1">
            {models.data?.items.map((m) => (
              <label key={m.id} className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={selected.includes(m.id)} onChange={() => toggle(m.id)} />
                <span><b>{m.modelKey}</b> <span className="text-xs text-slate-500">{m.providerKey}</span></span>
                <span className="ml-auto text-xs text-slate-500">{m.activePricing ? `$${m.activePricing.inputPerMtok}·$${m.activePricing.outputPerMtok}` : 'no price'}</span>
              </label>
            ))}
          </div>
        </Card>
      </div>

      {results.length > 0 && (
        <Card
          title="Results"
          actions={
            <form onSubmit={(e) => { e.preventDefault(); save.mutate(); }} className="flex gap-2">
              <Input placeholder="Benchmark name" value={benchName} onChange={(e) => setBenchName(e.target.value)} />
              <Button type="submit" variant="secondary" disabled={save.isPending || !benchName.trim()}>Save benchmark</Button>
            </form>
          }
        >
          <ErrorNote error={save.error} />
          <div className={`grid gap-4 ${results.length > 1 ? 'md:grid-cols-2 xl:grid-cols-3' : ''}`}>
            {results.map((r) => (
              <div key={r.run.id} className="space-y-2 rounded-md border border-slate-200 p-3">
                <div className="flex items-baseline gap-2">
                  <b>{r.modelKey}</b> <span className="text-xs text-slate-500">{r.providerKey}</span>
                  <span className="ml-auto text-xs text-slate-500">{r.durationMs} ms</span>
                </div>
                <div className="text-xs text-slate-600">
                  in {r.usage.inputTokens ?? '?'} · out {r.usage.outputTokens ?? '?'}
                  {r.usage.reasoningTokens ? ` · reasoning ${r.usage.reasoningTokens}` : ''} · est. cost {r.estimatedCost ? `$${r.estimatedCost}` : 'unknown (no pricing)'}
                </div>
                {r.run.error ? <ErrorNote error={r.run.error} /> : <pre className="max-h-96 overflow-auto whitespace-pre-wrap rounded bg-slate-50 p-2 text-xs">{r.run.output}</pre>}
              </div>
            ))}
          </div>
        </Card>
      )}

      <Card title="Saved benchmarks">
        <ErrorNote error={benchmarks.error} />
        <Table head={['Name', 'Runs', 'Saved']} empty="No benchmarks saved yet.">
          {benchmarks.data?.items.map((b) => (
            <tr key={b.id}>
              <Td>{b.name}</Td>
              <Td>{b.runIds.length}</Td>
              <Td className="text-xs">{when(b.createdAt)}</Td>
            </tr>
          ))}
        </Table>
      </Card>
    </div>
  );
}
