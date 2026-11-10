import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { ApiError, get, post } from '../api/client';
import type { Task } from '../api/types';
import { Badge, Button, Card, ErrorNote, Mono, Muted, shortId, Table, Td, when } from '../components/ui';

interface Lineage {
  task: { id: string; projectId: string; title: string; status: string; retryCount: number };
  why: { objective: string; acceptanceCriteria: string[]; stage: { key: string } | null; upstream: Array<{ id: string; title: string; status: string }> };
  scheduledBy: {
    createdBy: string;
    runStartedBy: { type: string; id: string } | null;
    transitions: Array<{ from: string; to: string; reason: string | null; actorType: string; actorId: string; at: string }>;
  };
  executions: Array<{ id: string; attemptNo: number; workerId: string; status: string; startedAt: string; endedAt: string | null; agentKey: string | null; agentVersion: number | null; failure: Record<string, unknown> | null }>;
  modelInvocations: Array<{ id: string; status: string; providerKey: string; modelKey: string; durationMs: number; inputTokens: number | null; outputTokens: number | null; estimatedCost: string | null; routingExplanation: Record<string, unknown> }>;
  contextPackages: Array<{ id: string; items: Array<{ path: string; version: number; sha256: string; source: string }> }>;
  toolCalls: Array<{ id: string; toolKey: string; status: string; errorCode: string | null; durationMs: number; approvalId: string | null }>;
  changes: { workspace: { branch: string; files: string[]; diff: string; truncated: boolean } | null };
  qualityGates: Array<{ gateKey: string; outcome: string; evidence: Record<string, unknown>; evaluatedAt: string }>;
  approvals: Array<{ id: string; kind: string; status: string; title: string; comment: string | null; decidedByEmail: string | null; decidedAt: string | null }>;
}

export function TaskPage() {
  const { taskId } = useParams({ from: '/tasks/$taskId' });
  const qc = useQueryClient();
  const task = useQuery({ queryKey: ['task', taskId], queryFn: () => get<Task>(`/tasks/${taskId}`), refetchInterval: 5000 });
  const lineage = useQuery({ queryKey: ['task', taskId, 'lineage'], queryFn: () => get<Lineage>(`/tasks/${taskId}/lineage`), refetchInterval: 5000 });
  const ready = useMutation({
    mutationFn: () => post(`/tasks/${taskId}/transitions`, { to: 'ready', reason: 'resumed from the UI' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['task', taskId] }),
  });
  const t = task.data;
  const l = lineage.data;
  const forbidden = lineage.error instanceof ApiError && lineage.error.status === 403;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-baseline gap-3">
        {t && <Link to="/projects/$projectId" params={{ projectId: t.projectId }} className="text-sm text-slate-500 hover:underline">← project</Link>}
        <h1 className="text-xl font-semibold">{t?.title ?? '…'}</h1>
        {t && <Badge>{t.status}</Badge>}
        {t && ['waiting_for_input', 'blocked', 'failed'].includes(t.status) && (
          <Button variant="secondary" onClick={() => ready.mutate()}>Move to ready</Button>
        )}
      </div>
      <ErrorNote error={task.error ?? ready.error} />
      {t?.statusReason && <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900">{t.statusReason}</p>}
      {forbidden && <Muted>The full lineage needs the audit permission (owner, administrator or project manager).</Muted>}
      {!forbidden && <ErrorNote error={lineage.error} />}
      {l && (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card title="Why this task exists">
            <p className="text-sm">{l.why.objective}</p>
            {l.why.stage && <p className="mt-1 text-xs text-slate-500">Workflow stage <Mono>{l.why.stage.key}</Mono></p>}
            {l.why.upstream.length > 0 && (
              <p className="mt-2 text-xs text-slate-500">After: {l.why.upstream.map((u) => (
                <Link key={u.id} to="/tasks/$taskId" params={{ taskId: u.id }} className="mr-2 text-sky-700 hover:underline">{u.title}</Link>
              ))}</p>
            )}
          </Card>
          <Card title="Who scheduled it">
            <p className="mb-2 text-xs text-slate-500">
              Created by <Mono>{l.scheduledBy.createdBy}</Mono>
              {l.scheduledBy.runStartedBy && <> · run started by <Mono>{l.scheduledBy.runStartedBy.type} {shortId(l.scheduledBy.runStartedBy.id)}</Mono></>}
            </p>
            <Table head={['When', 'Transition', 'By', 'Reason']}>
              {l.scheduledBy.transitions.map((h, i) => (
                <tr key={i}>
                  <Td className="whitespace-nowrap text-xs text-slate-500">{when(h.at)}</Td>
                  <Td className="whitespace-nowrap text-xs">{h.from} → <b>{h.to}</b></Td>
                  <Td className="text-xs">{h.actorType} <Mono>{h.actorId.length > 20 ? shortId(h.actorId) : h.actorId}</Mono></Td>
                  <Td className="text-xs text-slate-600">{h.reason}</Td>
                </tr>
              ))}
            </Table>
          </Card>
          <Card title="Attempts" className="lg:col-span-2">
            <Table head={['#', 'Agent', 'Worker', 'Status', 'Started', 'Failure']}>
              {l.executions.map((e) => (
                <tr key={e.id}>
                  <Td>{e.attemptNo}</Td>
                  <Td>{e.agentKey ? `${e.agentKey}@${e.agentVersion}` : 'platform'}</Td>
                  <Td><Mono>{e.workerId}</Mono></Td>
                  <Td><Badge>{e.status}</Badge></Td>
                  <Td className="text-xs text-slate-500">{when(e.startedAt)}</Td>
                  <Td className="max-w-md text-xs text-red-700">{e.failure ? String(e.failure['message'] ?? '') : ''}</Td>
                </tr>
              ))}
            </Table>
          </Card>
          <Card title="Model calls (and why that model)" className="lg:col-span-2">
            <Table head={['Model', 'Status', 'Reason', 'Tokens in/out', 'Est. cost', 'ms']}>
              {l.modelInvocations.map((m) => (
                <tr key={m.id}>
                  <Td>{m.providerKey} / <b>{m.modelKey}</b></Td>
                  <Td><Badge>{m.status}</Badge></Td>
                  <Td className="text-xs">{String(m.routingExplanation['selectionReason'] ?? '')} <span className="text-slate-400">{String(m.routingExplanation['resolvedScope'] ?? '')}</span></Td>
                  <Td className="text-xs">{m.inputTokens ?? '?'} / {m.outputTokens ?? '?'}</Td>
                  <Td className="text-xs">{m.estimatedCost ? `$${m.estimatedCost}` : 'unpriced'}</Td>
                  <Td className="text-xs">{m.durationMs}</Td>
                </tr>
              ))}
            </Table>
          </Card>
          <Card title="Context given to the agent">
            {l.contextPackages.length === 0 && <Muted>No context package.</Muted>}
            {l.contextPackages.map((p) => (
              <ul key={p.id} className="space-y-1 text-xs">
                {p.items.map((i) => (
                  <li key={`${i.path}@${i.version}`}><Mono>{i.path}</Mono> v{i.version} <span className="text-slate-400">({i.source}, {i.sha256.slice(0, 10)}…)</span></li>
                ))}
              </ul>
            ))}
          </Card>
          <Card title="Tool calls">
            <Table head={['Tool', 'Status', 'Detail', 'ms']} empty="No tools used.">
              {l.toolCalls.map((c) => (
                <tr key={c.id}>
                  <Td><Mono>{c.toolKey}</Mono></Td>
                  <Td><Badge>{c.status}</Badge></Td>
                  <Td className="text-xs">{c.errorCode ?? (c.approvalId ? `approval ${shortId(c.approvalId)}` : '')}</Td>
                  <Td className="text-xs">{c.durationMs}</Td>
                </tr>
              ))}
            </Table>
          </Card>
          <Card title="Quality gates">
            <Table head={['Gate', 'Outcome', 'Evidence']} empty="No gates evaluated yet.">
              {l.qualityGates.map((g, i) => (
                <tr key={i}>
                  <Td><Mono>{g.gateKey}</Mono></Td>
                  <Td><Badge>{g.outcome}</Badge></Td>
                  <Td className="text-xs text-slate-600">{String(g.evidence['summary'] ?? g.evidence['tool'] ?? '')}</Td>
                </tr>
              ))}
            </Table>
          </Card>
          <Card title="Human approvals">
            <Table head={['Kind', 'Status', 'By', 'Comment']} empty="No approvals.">
              {l.approvals.map((a) => (
                <tr key={a.id}>
                  <Td><Badge tone="blue">{a.kind}</Badge></Td>
                  <Td><Badge>{a.status}</Badge></Td>
                  <Td className="text-xs">{a.decidedByEmail ?? '—'}</Td>
                  <Td className="text-xs">{a.comment}</Td>
                </tr>
              ))}
            </Table>
          </Card>
          <Card title={l.changes.workspace ? <>Code changes on <Mono>{l.changes.workspace.branch}</Mono></> : 'Code changes'} className="lg:col-span-2">
            {!l.changes.workspace && <Muted>This task did not change code.</Muted>}
            {l.changes.workspace && <DiffView diff={l.changes.workspace.diff} />}
          </Card>
        </div>
      )}
    </div>
  );
}

function DiffView({ diff }: { diff: string }) {
  if (!diff.trim()) return <Muted>No differences.</Muted>;
  return (
    <pre className="max-h-[36rem] overflow-auto rounded bg-slate-950 p-3 text-xs leading-relaxed text-slate-200">
      {diff.split('\n').map((line, i) => (
        <div key={i} className={line.startsWith('+') && !line.startsWith('+++') ? 'text-emerald-300' : line.startsWith('-') && !line.startsWith('---') ? 'text-red-300' : line.startsWith('@@') ? 'text-sky-300' : ''}>
          {line || ' '}
        </div>
      ))}
    </pre>
  );
}
