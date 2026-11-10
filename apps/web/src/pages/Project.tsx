import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { API_BASE, apiText, get, post } from '../api/client';
import type { Approval, Artifact, Page, Project, ProjectEvent, RunDetail, Task, Workflow, WorkflowRun } from '../api/types';
import { Badge, Button, Card, ErrorNote, Input, Label, Mono, Muted, Select, shortId, Table, Tabs, Td, Textarea, when } from '../components/ui';

const REQUEST_PATH = '.ai-context/01-requirements/request.md';
type Tab = 'runs' | 'tasks' | 'artifacts' | 'approvals' | 'events';

export function ProjectPage() {
  const { projectId } = useParams({ from: '/projects/$projectId' });
  const [tab, setTab] = useState<Tab>('runs');
  const project = useQuery({ queryKey: ['project', projectId], queryFn: () => get<Project>(`/projects/${projectId}`) });
  const approvals = useQuery({
    queryKey: ['approvals', projectId],
    queryFn: () => get<Page<Approval>>(`/projects/${projectId}/approvals?status=pending`),
  });
  const events = useLiveEvents(projectId);
  const pending = approvals.data?.items.length ?? 0;
  return (
    <div className="space-y-4">
      <div className="flex items-baseline gap-3">
        <Link to="/" className="text-sm text-slate-500 hover:underline">Projects</Link>
        <h1 className="text-xl font-semibold">{project.data?.name ?? '…'}</h1>
        {project.data && <Mono>{project.data.key}</Mono>}
      </div>
      <ErrorNote error={project.error} />
      <Tabs<Tab>
        value={tab}
        onChange={setTab}
        tabs={[
          ['runs', 'Workflow runs'],
          ['tasks', 'Tasks'],
          ['artifacts', 'Artifacts'],
          ['approvals', pending ? `Approvals (${pending})` : 'Approvals'],
          ['events', 'Live events'],
        ]}
      />
      {tab === 'runs' && <RunsTab projectId={projectId} />}
      {tab === 'tasks' && <TasksTab projectId={projectId} />}
      {tab === 'artifacts' && <ArtifactsTab projectId={projectId} />}
      {tab === 'approvals' && <ApprovalsTab projectId={projectId} />}
      {tab === 'events' && <EventsTab events={events} />}
    </div>
  );
}

/** Server-Sent Events: keeps a rolling log and refreshes the project's queries as things happen. */
function useLiveEvents(projectId: string): ProjectEvent[] {
  const qc = useQueryClient();
  const [events, setEvents] = useState<ProjectEvent[]>([]);
  useEffect(() => {
    const source = new EventSource(`${API_BASE}/projects/${projectId}/events/stream`, { withCredentials: true });
    const onMessage = (msg: MessageEvent<string>) => {
      const event = JSON.parse(msg.data) as ProjectEvent;
      setEvents((prev) => [event, ...prev].slice(0, 200));
      void qc.invalidateQueries({ predicate: (q) => q.queryKey.includes(projectId) || q.queryKey[0] === 'run' || q.queryKey[0] === 'task' });
    };
    // Every event type is a named SSE event; listen to all of them through the generic handler.
    const forward = (e: Event) => onMessage(e as MessageEvent<string>);
    const types = ['task.status_changed', 'task.completed', 'workflow.run_started', 'workflow.run_completed', 'workflow.run_paused',
      'workflow.run_running', 'workflow.run_failed', 'workflow.run_cancelled', 'approval.requested', 'approval.approved',
      'approval.rejected', 'handoff.created', 'artifact.created', 'artifact.versioned', 'artifact.approved', 'task.needs_input',
      'task.needs_intervention', 'task.retries_exhausted', 'integration.completed', 'integration.conflict', 'budget.halted',
      'budget.threshold_crossed', 'checkpoint.created', 'checkpoint.restored', 'task.lease_expired'];
    for (const t of types) source.addEventListener(t, forward);
    source.onmessage = onMessage;
    return () => source.close();
  }, [projectId, qc]);
  return events;
}

// ---------------------------------------------------------------- runs

function RunsTab({ projectId }: { projectId: string }) {
  const runs = useQuery({ queryKey: ['runs', projectId], queryFn: () => get<Page<WorkflowRun>>(`/projects/${projectId}/workflow-runs`) });
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <div className="space-y-4 lg:col-span-2">
        <Card title="Runs">
          <ErrorNote error={runs.error} />
          <Table head={['Run', 'Status', 'Variables', 'Started', '']} empty="No runs yet. Write the request, then start a workflow.">
            {runs.data?.items.map((r) => (
              <tr key={r.id}>
                <Td><Mono>{shortId(r.id)}</Mono></Td>
                <Td>
                  <Badge>{r.status}</Badge> {r.pausedReason && <span className="text-xs text-slate-500">{r.pausedReason}</span>}
                </Td>
                <Td><Mono>{JSON.stringify(r.variables)}</Mono></Td>
                <Td className="text-slate-500">{when(r.startedAt)}</Td>
                <Td><Button variant="secondary" onClick={() => setOpen(open === r.id ? null : r.id)}>{open === r.id ? 'Hide' : 'Steps'}</Button></Td>
              </tr>
            ))}
          </Table>
        </Card>
        {open && <RunSteps runId={open} />}
      </div>
      <div className="space-y-4">
        <RequestEditor projectId={projectId} />
        <StartRun projectId={projectId} />
      </div>
    </div>
  );
}

function RunSteps({ runId }: { runId: string }) {
  const qc = useQueryClient();
  const detail = useQuery({ queryKey: ['run', runId], queryFn: () => get<RunDetail>(`/workflow-runs/${runId}`), refetchInterval: 5000 });
  const act = useMutation({
    mutationFn: (action: 'pause' | 'resume' | 'cancel') =>
      post(`/workflow-runs/${runId}/${action}`, action === 'resume' ? {} : { reason: `${action}d from the UI` }),
    onSuccess: () => qc.invalidateQueries(),
  });
  const status = detail.data?.run.status;
  return (
    <Card
      title={<>Run <Mono>{shortId(runId)}</Mono> {status && <Badge>{status}</Badge>}</>}
      actions={
        <>
          {status === 'running' && <Button variant="secondary" onClick={() => act.mutate('pause')}>Pause</Button>}
          {(status === 'paused' || status === 'failed') && <Button variant="secondary" onClick={() => act.mutate('resume')}>Resume</Button>}
          {(status === 'running' || status === 'paused' || status === 'failed') && <Button variant="danger" onClick={() => act.mutate('cancel')}>Cancel</Button>}
        </>
      }
    >
      <ErrorNote error={detail.error ?? act.error} />
      <Table head={['#', 'Stage', 'Status', 'Task']}>
        {detail.data?.steps.map((s) => (
          <tr key={s.id}>
            <Td className="text-slate-400">{s.position + 1}</Td>
            <Td>{s.stageKey}</Td>
            <Td><Badge>{s.status}</Badge> {s.skipReason && <span className="text-xs text-slate-400">{s.skipReason}</span>}</Td>
            <Td>
              {s.taskId ? (
                <Link to="/tasks/$taskId" params={{ taskId: s.taskId }} className="text-sky-700 hover:underline">open task</Link>
              ) : '—'}
            </Td>
          </tr>
        ))}
      </Table>
    </Card>
  );
}

/** The default workflow reads the user's request from an approved artifact (see README step 6). */
function RequestEditor({ projectId }: { projectId: string }) {
  const qc = useQueryClient();
  const artifacts = useQuery({ queryKey: ['artifacts', projectId], queryFn: () => get<Page<Artifact>>(`/projects/${projectId}/artifacts?limit=200`) });
  const item = artifacts.data?.items.find((a) => a.path === REQUEST_PATH);
  const current = useQuery({
    queryKey: ['artifact-content', item?.id, item?.currentVersionNo],
    queryFn: () => apiText(`/artifacts/${item!.id}/versions/latest/content`),
    enabled: !!item,
  });
  const [text, setText] = useState<string | null>(null);
  const value = text ?? current.data ?? '';
  const save = useMutation({
    mutationFn: async () => {
      type Written = { item?: { id: string }; version: { versionNo: number } };
      const written = item
        ? await post<Written>(`/artifacts/${item.id}/versions`, { content: value, expectedVersionNo: item.currentVersionNo })
        : await post<Written>(`/projects/${projectId}/artifacts`, { path: REQUEST_PATH, type: 'request', content: value });
      const id = item?.id ?? written.item!.id;
      await post(`/artifacts/${id}/versions/${written.version.versionNo}/approve`);
    },
    onSuccess: () => {
      setText(null);
      void qc.invalidateQueries({ queryKey: ['artifacts', projectId] });
    },
  });
  const approved = item && item.approvedVersionNo === item.currentVersionNo;
  return (
    <Card title="Request" actions={item && <Badge tone={approved ? 'green' : 'amber'}>{approved ? `v${item.approvedVersionNo} approved` : 'not approved'}</Badge>}>
      <div className="space-y-2">
        <Muted>What should the agents build or fix? Saved as an approved version of <Mono>{REQUEST_PATH}</Mono>.</Muted>
        <Textarea rows={8} value={value} onChange={(e) => setText(e.target.value)} placeholder="# Todo app&#10;Users can add, complete and delete todo items." />
        <ErrorNote error={save.error} />
        <Button disabled={save.isPending || !value.trim()} onClick={() => save.mutate()}>Save & approve</Button>
      </div>
    </Card>
  );
}

function StartRun({ projectId }: { projectId: string }) {
  const qc = useQueryClient();
  const workflows = useQuery({ queryKey: ['workflows'], queryFn: () => get<Page<Workflow>>('/workflows') });
  const [workflowId, setWorkflowId] = useState('');
  const [changeType, setChangeType] = useState('feature');
  const [touchesDb, setTouchesDb] = useState(false);
  const start = useMutation({
    mutationFn: () =>
      post<RunDetail>(`/projects/${projectId}/workflow-runs`, {
        workflowId: workflowId || workflows.data?.items[0]?.id,
        variables: { change_type: changeType, touches_database: touchesDb },
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['runs', projectId] }),
  });
  return (
    <Card title="Start a workflow">
      <div className="space-y-3">
        {workflows.data?.items.length === 0 && <Muted>No workflows yet — seed them on “Agents & workflows”.</Muted>}
        <Label text="Workflow">
          <Select value={workflowId} onChange={(e) => setWorkflowId(e.target.value)}>
            {workflows.data?.items.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
          </Select>
        </Label>
        <Label text="Change type" hint="bugfix skips analysis and design">
          <Select value={changeType} onChange={(e) => setChangeType(e.target.value)}>
            <option value="new_project">new project</option>
            <option value="feature">feature</option>
            <option value="bugfix">bugfix</option>
          </Select>
        </Label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={touchesDb} onChange={(e) => setTouchesDb(e.target.checked)} /> Touches the database
        </label>
        <ErrorNote error={start.error} />
        <Button disabled={start.isPending || !workflows.data?.items.length} onClick={() => start.mutate()}>Start</Button>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------- tasks

const RESUMABLE = new Set(['waiting_for_input', 'blocked', 'failed']);

function TasksTab({ projectId }: { projectId: string }) {
  const qc = useQueryClient();
  const tasks = useQuery({ queryKey: ['tasks', projectId], queryFn: () => get<Page<Task>>(`/projects/${projectId}/tasks?limit=200`) });
  const ready = useMutation({
    mutationFn: (t: Task) => post(`/tasks/${t.id}/transitions`, { to: 'ready', reason: 'resumed from the UI' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['tasks', projectId] }),
  });
  return (
    <Card title="Tasks">
      <ErrorNote error={tasks.error ?? ready.error} />
      <Table head={['Task', 'Agent', 'Status', 'Why', 'Retries', '']}>
        {tasks.data?.items.map((t) => (
          <tr key={t.id}>
            <Td><Link to="/tasks/$taskId" params={{ taskId: t.id }} className="font-medium text-sky-700 hover:underline">{t.title}</Link></Td>
            <Td>{t.agentRole ?? '—'}</Td>
            <Td><Badge>{t.status}</Badge></Td>
            <Td className="max-w-md text-xs text-slate-600">{t.statusReason}</Td>
            <Td>{t.retryCount}/{t.maxRetries}</Td>
            <Td>{RESUMABLE.has(t.status) && <Button variant="secondary" onClick={() => ready.mutate(t)}>Move to ready</Button>}</Td>
          </tr>
        ))}
      </Table>
    </Card>
  );
}

// ---------------------------------------------------------------- artifacts

function ArtifactsTab({ projectId }: { projectId: string }) {
  const qc = useQueryClient();
  const artifacts = useQuery({ queryKey: ['artifacts', projectId], queryFn: () => get<Page<Artifact>>(`/projects/${projectId}/artifacts?limit=200`) });
  const [open, setOpen] = useState<Artifact | null>(null);
  const content = useQuery({
    queryKey: ['artifact-content', open?.id, open?.currentVersionNo],
    queryFn: () => apiText(`/artifacts/${open!.id}/versions/latest/content`),
    enabled: !!open,
  });
  const approve = useMutation({
    mutationFn: (a: Artifact) => post(`/artifacts/${a.id}/versions/${a.currentVersionNo}/approve`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['artifacts', projectId] }),
  });
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card title="Artifacts">
        <ErrorNote error={artifacts.error ?? approve.error} />
        <Table head={['Path', 'Version', 'Approved', '']}>
          {artifacts.data?.items.map((a) => (
            <tr key={a.id} className={open?.id === a.id ? 'bg-slate-50' : ''}>
              <Td><button className="text-left text-sky-700 hover:underline" onClick={() => setOpen(a)}><Mono>{a.path}</Mono></button></Td>
              <Td>v{a.currentVersionNo}</Td>
              <Td>{a.approvedVersionNo ? <Badge tone="green">v{a.approvedVersionNo}</Badge> : <Badge tone="slate">no</Badge>}</Td>
              <Td>{a.approvedVersionNo !== a.currentVersionNo && <Button variant="secondary" onClick={() => approve.mutate(a)}>Approve v{a.currentVersionNo}</Button>}</Td>
            </tr>
          ))}
        </Table>
      </Card>
      <Card title={open ? <Mono>{open.path}</Mono> : 'Content'}>
        {!open && <Muted>Select an artifact to read it.</Muted>}
        <ErrorNote error={content.error} />
        {content.data !== undefined && <pre className="max-h-[32rem] overflow-auto whitespace-pre-wrap text-xs">{content.data}</pre>}
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------- approvals

function ApprovalsTab({ projectId }: { projectId: string }) {
  const qc = useQueryClient();
  const all = useQuery({ queryKey: ['approvals-all', projectId], queryFn: () => get<Page<Approval>>(`/projects/${projectId}/approvals`) });
  const [comments, setComments] = useState<Record<string, string>>({});
  const decide = useMutation({
    mutationFn: ({ id, decision }: { id: string; decision: 'approved' | 'rejected' }) =>
      post(`/approvals/${id}/decision`, { decision, ...(comments[id] ? { comment: comments[id] } : {}) }),
    onSuccess: () => qc.invalidateQueries(),
  });
  return (
    <Card title="Approvals">
      <ErrorNote error={all.error ?? decide.error} />
      <div className="space-y-3">
        {all.data?.items.length === 0 && <Muted>No approval requests.</Muted>}
        {all.data?.items.map((a) => (
          <div key={a.id} className="rounded-md border border-slate-200 p-3">
            <div className="flex flex-wrap items-center gap-2">
              <Badge>{a.status}</Badge>
              <Badge tone="blue">{a.kind}</Badge>
              <span className="font-medium">{a.title}</span>
              {a.taskId && <Link to="/tasks/$taskId" params={{ taskId: a.taskId }} className="text-xs text-sky-700 hover:underline">task</Link>}
              <span className="ml-auto text-xs text-slate-400">{when(a.createdAt)}</span>
            </div>
            <pre className="mt-2 max-h-40 overflow-auto rounded bg-slate-50 p-2 text-xs">{JSON.stringify(a.subject, null, 2)}</pre>
            {a.comment && <p className="mt-1 text-sm text-slate-600">“{a.comment}”</p>}
            {a.status === 'pending' && (
              <div className="mt-2 flex gap-2">
                <Input placeholder="Comment (required to reject)" value={comments[a.id] ?? ''} onChange={(e) => setComments({ ...comments, [a.id]: e.target.value })} />
                <Button onClick={() => decide.mutate({ id: a.id, decision: 'approved' })}>Approve</Button>
                <Button variant="danger" disabled={!comments[a.id]?.trim()} onClick={() => decide.mutate({ id: a.id, decision: 'rejected' })}>Reject</Button>
              </div>
            )}
          </div>
        ))}
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------- events

function EventsTab({ events }: { events: ProjectEvent[] }) {
  return (
    <Card title="Live events" actions={<Badge tone="green">streaming</Badge>}>
      <Table head={['Time', 'Event', 'Subject', 'Details']} empty="Waiting for events…">
        {events.map((e) => (
          <tr key={e.id}>
            <Td className="whitespace-nowrap text-slate-500">{when(e.createdAt)}</Td>
            <Td><Mono>{e.type}</Mono></Td>
            <Td><Mono>{e.aggregateType} {shortId(e.aggregateId)}</Mono></Td>
            <Td><Mono>{JSON.stringify(e.payload).slice(0, 160)}</Mono></Td>
          </tr>
        ))}
      </Table>
    </Card>
  );
}
