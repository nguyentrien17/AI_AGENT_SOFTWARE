import { describe, expect, it } from 'vitest';
import {
  createDefaultToolCatalog,
  destructiveGitOperation,
  evaluateToolPermission,
  gitEnvironment,
  matchesGlob,
  normalizeToolPath,
  type PermissionInput,
} from '../src/index.js';

describe('glob file scopes', () => {
  it('matches ** across segments, * and ? within one', () => {
    expect(matchesGlob('source-code/a/b/c.ts', 'source-code/**')).toBe(true);
    expect(matchesGlob('source-code', 'source-code/**')).toBe(false);
    expect(matchesGlob('src/x.ts', 'src/*.ts')).toBe(true);
    expect(matchesGlob('src/a/x.ts', 'src/*.ts')).toBe(false);
    expect(matchesGlob('src/a/x.ts', 'src/**/*.ts')).toBe(true);
    expect(matchesGlob('src/x.ts', 'src/**/*.ts')).toBe(true);
    expect(matchesGlob('a.md', '?.md')).toBe(true);
    expect(matchesGlob('tests/x.test.ts', 'source-code/**')).toBe(false);
    expect(matchesGlob('src/a.ts', 'src/a+ts')).toBe(false); // regex metacharacters are literal
  });
});

describe('path jail — pure normalization (escape attempts)', () => {
  it.each([
    ['../outside.txt', /traversal/],
    ['source-code/../../etc/passwd', /traversal/],
    ['..\\..\\Windows\\win.ini', /traversal/],
    ['/etc/passwd', /absolute/],
    ['C:\\Windows\\win.ini', /absolute/],
    ['c:relative', /absolute/],
    ['\\\\server\\share\\x', /absolute/],
    ['.git/config', /managed by the platform/],
    ['.GIT/hooks/pre-commit', /managed by the platform/],
    ['.ai-context/01-requirements/x.md', /managed by the platform/],
    ['.git./config', /invalid path segment/],
    ['src/file.ts:hidden', /invalid path segment/],
    ['src/evil \u0000.ts', /NUL/],
  ])('rejects %s', (input, reason) => {
    expect(() => normalizeToolPath(input)).toThrow(reason);
  });

  it('normalizes harmless forms', () => {
    expect(normalizeToolPath('./source-code//app.ts')).toBe('source-code/app.ts');
    expect(normalizeToolPath('source-code\\lib\\x.ts')).toBe('source-code/lib/x.ts');
    expect(normalizeToolPath('.')).toBe('.');
    expect(normalizeToolPath('.gitignore')).toBe('.gitignore');
  });
});

describe('destructive git guard (Blueprint §11.4)', () => {
  it.each([
    [['push', '--force', 'origin', 'main']],
    [['push', '-f']],
    [['push', '--force-with-lease=main']],
    [['push', 'origin', '+main']],
    [['push', 'origin', ':main']],
    [['push', '--delete', 'origin', 'x']],
    [['reset', '--hard', 'HEAD~3']],
    [['branch', '-D', 'main']],
    [['branch', '--delete', 'feature']],
    [['clean', '-fdx']],
    [['rebase', '-i', 'HEAD~2']],
    [['filter-branch', '--all']],
    [['tag', '-d', 'v1']],
    [['stash', 'clear']],
    [['reflog', 'expire', '--all']],
    [['gc', '--prune=now']],
    [['checkout', '-f', 'main']],
    [['update-ref', '-d', 'refs/heads/main']],
  ])('refuses %j', (args) => {
    expect(destructiveGitOperation(args)).not.toBeNull();
  });

  it('allows ordinary commands', () => {
    for (const args of [['status'], ['commit', '-m', 'x'], ['push', 'origin', 'task/1'], ['branch', '--list'], ['diff', 'main']]) {
      expect(destructiveGitOperation(args)).toBeNull();
    }
  });

  it('never passes platform secrets to git', () => {
    process.env['PLATFORM_MASTER_KEY'] = 'super-secret-master-key';
    process.env['OPENAI_API_KEY'] = 'sk-should-not-leak';
    const env = gitEnvironment();
    expect(Object.keys(env)).not.toContain('PLATFORM_MASTER_KEY');
    expect(Object.keys(env)).not.toContain('OPENAI_API_KEY');
    expect(env['GIT_TERMINAL_PROMPT']).toBe('0');
    delete process.env['PLATFORM_MASTER_KEY'];
    delete process.env['OPENAI_API_KEY'];
  });
});

describe('7-dimension permission guard (Blueprint §16.2)', () => {
  const base: PermissionInput = {
    project: { ok: true, detail: 'project active' },
    agent: {
      status: 'active',
      allowedTools: ['fs_write_file', 'fs_read_file', 'danger'],
      allowedActions: ['read_file', 'write_file', 'execute'],
      allowedFileScopes: ['source-code/**', 'tests/**'],
    },
    task: { status: 'running', leaseHeld: true, allowedTools: [] },
    tool: { toolKey: 'fs_write_file', action: 'write_file', risk: 'medium', registered: true },
    paths: [{ path: 'source-code/app.ts', access: 'write' }],
    override: null,
  };
  const verdict = (over: Partial<PermissionInput>) => evaluateToolPermission({ ...base, ...over });

  it('allows when every dimension passes and reports all seven', () => {
    const d = verdict({});
    expect(d.verdict).toBe('allow');
    expect(d.dimensions.map((x) => x.dimension)).toEqual(['project', 'agent', 'task', 'tool', 'file_scope', 'action', 'risk']);
  });

  it('denies on each dimension separately', () => {
    const cases: Array<[string, Partial<PermissionInput>]> = [
      ['project', { project: { ok: false, detail: 'other workspace' } }],
      ['agent', { agent: { ...base.agent, status: 'disabled' } }],
      ['task', { task: { ...base.task, status: 'completed' } }],
      ['task', { task: { ...base.task, leaseHeld: false } }],
      ['tool', { tool: { ...base.tool, toolKey: 'fs_delete_file' } }],
      ['tool', { task: { ...base.task, allowedTools: ['fs_read_file'] } }],
      ['file_scope', { paths: [{ path: 'documentation/x.md', access: 'write' }] }],
      ['file_scope', { agent: { ...base.agent, allowedFileScopes: [] } }],
      ['action', { agent: { ...base.agent, allowedActions: ['read_file'] } }],
      ['risk', { tool: { ...base.tool, risk: 'high' }, override: null }],
    ];
    for (const [dim, over] of cases) {
      const d = verdict(over);
      expect(d.verdict, dim).toBe('deny');
      expect(d.reason, dim).toMatch(new RegExp(`^${dim}:`));
    }
  });

  it('per-tool overrides only narrow scopes, and high risk always needs a human', () => {
    const narrowed = verdict({ override: { fileScopes: ['tests/**'], maxRisk: 'medium' } });
    expect(narrowed.verdict).toBe('deny');
    // An override cannot widen scopes beyond the agent definition.
    const widened = verdict({
      paths: [{ path: 'documentation/x.md', access: 'write' }],
      override: { fileScopes: ['documentation/**'], maxRisk: 'medium' },
    });
    expect(widened.verdict).toBe('deny');
    const risky = verdict({
      tool: { toolKey: 'danger', action: 'execute', risk: 'high', registered: true },
      override: { fileScopes: [], maxRisk: 'critical' },
    });
    expect(risky.verdict).toBe('require_approval');
  });
});

describe('tool catalog (P6-01)', () => {
  it('declares every Blueprint §11.1 field and needs no sandbox for the built-ins', () => {
    const tools = createDefaultToolCatalog().list();
    expect(tools.map((t) => t.toolKey)).toEqual([
      'fs_delete_file',
      'fs_list_dir',
      'fs_read_file',
      'fs_write_file',
      'git_check_merge',
      'git_commit',
      'git_diff',
      'git_log',
      'git_status',
    ]);
    for (const t of tools) {
      expect(t.description.length).toBeGreaterThan(10);
      expect(t.inputSchema['type']).toBe('object');
      expect(t.timeoutSeconds).toBeGreaterThan(0);
      expect(['low', 'medium']).toContain(t.risk);
      expect(t.requiresSandbox).toBe(false);
      expect(t.runtimes).toEqual(['any']);
    }
  });
});
