import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, Outlet } from '@tanstack/react-router';
import { type FormEvent, useState } from 'react';
import { get, post } from '../api/client';
import type { Me } from '../api/types';
import { Button, Card, ErrorNote, Input, Label, Muted } from '../components/ui';

interface Status {
  bootstrapped: boolean;
  authenticated: boolean;
}

/** Application frame: decides between first-run setup, login and the signed-in layout. */
export function Shell() {
  const status = useQuery({ queryKey: ['auth-status'], queryFn: () => get<Status>('/auth/status') });
  if (status.isLoading) return <Centered><Muted>Loading…</Muted></Centered>;
  if (status.error) return <Centered><ErrorNote error={status.error} /></Centered>;
  if (!status.data!.bootstrapped) return <Centered><AuthForm mode="bootstrap" /></Centered>;
  if (!status.data!.authenticated) return <Centered><AuthForm mode="login" /></Centered>;
  return <SignedIn />;
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="flex min-h-screen items-center justify-center p-6">{children}</div>;
}

function AuthForm({ mode }: { mode: 'bootstrap' | 'login' }) {
  const qc = useQueryClient();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const submit = useMutation({
    mutationFn: async () => {
      if (mode === 'bootstrap') await post('/auth/bootstrap', { email, password, displayName: displayName || email });
      await post('/auth/login', { email, password });
    },
    onSuccess: () => qc.invalidateQueries(),
  });
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    submit.mutate();
  };
  return (
    <Card title={mode === 'bootstrap' ? 'Create the owner account' : 'Sign in'} className="w-full max-w-sm">
      <form onSubmit={onSubmit} className="space-y-3">
        {mode === 'bootstrap' && (
          <>
            <Muted>First run: this account becomes the workspace owner.</Muted>
            <Label text="Display name">
              <Input value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
            </Label>
          </>
        )}
        <Label text="Email">
          <Input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" />
        </Label>
        <Label text="Password" hint={mode === 'bootstrap' ? 'At least 12 characters.' : undefined}>
          <Input type="password" required value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={mode === 'bootstrap' ? 'new-password' : 'current-password'} />
        </Label>
        <ErrorNote error={submit.error} />
        <Button type="submit" disabled={submit.isPending} className="w-full">
          {mode === 'bootstrap' ? 'Create account' : 'Sign in'}
        </Button>
      </form>
    </Card>
  );
}

const NAV: Array<[string, string]> = [
  ['/', 'Projects'],
  ['/ai', 'AI models'],
  ['/agents', 'Agents & workflows'],
  ['/costs', 'Costs'],
];

function SignedIn() {
  const qc = useQueryClient();
  const me = useQuery({ queryKey: ['me'], queryFn: () => get<Me>('/auth/me') });
  const logout = useMutation({ mutationFn: () => post('/auth/logout'), onSuccess: () => qc.invalidateQueries() });
  return (
    <div className="min-h-screen">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-7xl items-center gap-6 px-4 py-2.5">
          <span className="font-semibold">AI Agent Platform</span>
          <nav className="flex gap-1">
            {NAV.map(([to, label]) => (
              <Link
                key={to}
                to={to}
                activeOptions={{ exact: to === '/' }}
                className="rounded-md px-2.5 py-1 text-sm text-slate-600 hover:bg-slate-100"
                activeProps={{ className: 'bg-slate-100 font-medium text-slate-900' }}
              >
                {label}
              </Link>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-3 text-sm text-slate-500">
            {me.data && (
              <span>
                {me.data.user.displayName} · <span className="text-slate-400">{me.data.role}</span>
              </span>
            )}
            <Button variant="ghost" onClick={() => logout.mutate()}>
              Sign out
            </Button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-7xl space-y-4 px-4 py-5">
        <Outlet />
      </main>
    </div>
  );
}
