import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { get, post } from '../api/client';
import type { Agent, Page, Skill, Workflow } from '../api/types';
import { Badge, Button, Card, ErrorNote, Mono, Muted, Table, Td } from '../components/ui';

export function AgentsPage() {
  const qc = useQueryClient();
  const agents = useQuery({ queryKey: ['agents'], queryFn: () => get<Page<Agent>>('/agents') });
  const workflows = useQuery({ queryKey: ['workflows'], queryFn: () => get<Page<Workflow>>('/workflows') });
  const skills = useQuery({ queryKey: ['skills'], queryFn: () => get<Page<Skill>>('/skills') });
  const seed = useMutation({
    mutationFn: async () => {
      await post('/agents/seed');
      await post('/workflows/seed');
    },
    onSuccess: () => qc.invalidateQueries(),
  });
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <h1 className="text-xl font-semibold">Agents & workflows</h1>
        <Button className="ml-auto" onClick={() => seed.mutate()} disabled={seed.isPending}>Load agent library</Button>
      </div>
      <Muted>Loads <Mono>agent-library/</Mono>: skills, agents and workflows. Unchanged definitions are kept; edited files become new versions.</Muted>
      <ErrorNote error={seed.error ?? agents.error} />
      <Card title="Agents">
        <Table head={['Agent', 'Role', 'Version', 'Tools', 'Skills', 'Status']} empty="No agents yet — load the agent library.">
          {agents.data?.items.map((a) => (
            <tr key={a.id}>
              <Td><b>{a.name}</b> <Mono>{a.agentKey}</Mono></Td>
              <Td>{a.role}</Td>
              <Td>v{a.currentVersion?.versionNo ?? '—'}</Td>
              <Td className="text-xs">{a.currentVersion?.allowedTools.join(', ') || '—'}</Td>
              <Td className="text-xs">{a.currentVersion?.skills.join(', ') || '—'}</Td>
              <Td><Badge>{a.status}</Badge></Td>
            </tr>
          ))}
        </Table>
      </Card>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Workflows">
          <Table head={['Workflow', 'Key']} empty="No workflows yet.">
            {workflows.data?.items.map((w) => (
              <tr key={w.id}>
                <Td><b>{w.name}</b><div className="whitespace-pre-line text-xs text-slate-500">{w.description}</div></Td>
                <Td><Mono>{w.key}</Mono></Td>
              </tr>
            ))}
          </Table>
        </Card>
        <Card title="Skills">
          <Table head={['Skill', 'Version', 'Description']} empty="No skills yet.">
            {skills.data?.items.map((s) => (
              <tr key={s.id}>
                <Td><b>{s.name}</b> <Mono>{s.skillKey}</Mono></Td>
                <Td>v{s.versionNo}</Td>
                <Td className="text-xs">{s.description}</Td>
              </tr>
            ))}
          </Table>
        </Card>
      </div>
    </div>
  );
}
