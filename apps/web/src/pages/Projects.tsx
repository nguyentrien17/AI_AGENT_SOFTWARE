import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { type FormEvent, useState } from 'react';
import { get, post } from '../api/client';
import type { Page, Project } from '../api/types';
import { Badge, Button, Card, ErrorNote, Input, Label, Table, Td, when } from '../components/ui';

export function ProjectsPage() {
  const qc = useQueryClient();
  const projects = useQuery({ queryKey: ['projects'], queryFn: () => get<Page<Project>>('/projects') });
  const [key, setKey] = useState('');
  const [name, setName] = useState('');
  const create = useMutation({
    mutationFn: () => post<Project>('/projects', { key, name }),
    onSuccess: () => {
      setKey('');
      setName('');
      void qc.invalidateQueries({ queryKey: ['projects'] });
    },
  });
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate();
  };
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <Card title="Projects" className="lg:col-span-2">
        <ErrorNote error={projects.error} />
        <Table head={['Project', 'Key', 'Status', 'Created']} empty="No projects yet — create one on the right.">
          {projects.data?.items.map((p) => (
            <tr key={p.id}>
              <Td>
                <Link to="/projects/$projectId" params={{ projectId: p.id }} className="font-medium text-sky-700 hover:underline">
                  {p.name}
                </Link>
              </Td>
              <Td><code className="text-xs">{p.key}</code></Td>
              <Td><Badge>{p.status}</Badge></Td>
              <Td className="text-slate-500">{when(p.createdAt)}</Td>
            </tr>
          ))}
        </Table>
      </Card>
      <Card title="New project">
        <form onSubmit={onSubmit} className="space-y-3">
          <Label text="Key" hint="2–40 lowercase letters, digits or hyphens; used for the folder and git repository.">
            <Input required value={key} onChange={(e) => setKey(e.target.value)} placeholder="todo-app" />
          </Label>
          <Label text="Name">
            <Input required value={name} onChange={(e) => setName(e.target.value)} placeholder="Todo App" />
          </Label>
          <ErrorNote error={create.error} />
          <Button type="submit" disabled={create.isPending}>Create project</Button>
        </form>
      </Card>
    </div>
  );
}
