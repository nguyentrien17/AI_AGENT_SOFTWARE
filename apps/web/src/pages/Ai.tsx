import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { errorMessage, get, post, put } from '../api/client';
import type { Agent, Budget, Model, ModelConfig, Page, Provider } from '../api/types';
import { Badge, Button, Card, ErrorNote, Input, Label, Mono, Muted, Select, Table, Tabs, Td } from '../components/ui';

type Tab = 'providers' | 'models' | 'assignments' | 'budgets';

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
        ]}
      />
      {tab === 'providers' && <Providers />}
      {tab === 'models' && <Models />}
      {tab === 'assignments' && <Assignments />}
      {tab === 'budgets' && <Budgets />}
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
    </div>
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
