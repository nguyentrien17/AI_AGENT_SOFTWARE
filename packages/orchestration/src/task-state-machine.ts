import type { TaskStatus } from '@platform/db';
import { InvalidStateTransitionError } from '@platform/shared';

export type { TaskStatus };

/** Blueprint §9.1 + docs/phase-0/03-architecture.md §5. */
export const TASK_TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  draft: ['pending', 'cancelled'],
  pending: ['ready', 'blocked', 'cancelled'],
  ready: ['assigned', 'pending', 'blocked', 'cancelled'],
  assigned: ['running', 'ready', 'cancelled'],
  running: [
    'waiting_for_input',
    'waiting_for_approval',
    'blocked',
    'failed',
    'completed',
    'ready',
    'cancelled',
  ],
  waiting_for_input: ['ready', 'running', 'cancelled'],
  waiting_for_approval: ['running', 'ready', 'failed', 'completed', 'cancelled'],
  blocked: ['pending', 'ready', 'cancelled'],
  failed: ['ready', 'waiting_for_input', 'cancelled'],
  completed: [],
  cancelled: [],
};

export const TERMINAL_STATUSES: ReadonlySet<TaskStatus> = new Set(['completed', 'cancelled']);

/**
 * Transitions a human (with `task.transition`) may request directly. Everything else is driven by the
 * scheduler/runtime/approval manager (system actors) so that e.g. `completed` cannot be self-declared.
 */
export const HUMAN_TRANSITIONS: ReadonlyArray<readonly [TaskStatus | '*', TaskStatus]> = [
  ['draft', 'pending'],
  ['pending', 'ready'],
  ['blocked', 'pending'],
  ['blocked', 'ready'],
  ['waiting_for_input', 'ready'],
  ['failed', 'ready'],
  ['*', 'cancelled'],
];

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return TASK_TRANSITIONS[from].includes(to);
}

export function assertTransition(from: TaskStatus, to: TaskStatus): void {
  if (!canTransition(from, to)) throw new InvalidStateTransitionError('Task', from, to);
}

export function isHumanTransition(from: TaskStatus, to: TaskStatus): boolean {
  return HUMAN_TRANSITIONS.some(([f, t]) => (f === '*' || f === from) && t === to);
}

/** Detects whether adding edge task → dependsOn creates a cycle, given existing edges (task → deps). */
export function wouldCreateCycle(
  edges: ReadonlyMap<string, readonly string[]>,
  taskId: string,
  dependsOn: string,
): boolean {
  if (taskId === dependsOn) return true;
  // A cycle exists iff taskId is reachable from dependsOn.
  const stack = [dependsOn];
  const seen = new Set<string>();
  while (stack.length) {
    const cur = stack.pop()!;
    if (cur === taskId) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const next of edges.get(cur) ?? []) stack.push(next);
  }
  return false;
}

/** Kahn topological sort; returns null when the graph has a cycle. */
export function topologicalOrder(
  nodes: readonly string[],
  edges: ReadonlyMap<string, readonly string[]>,
): string[] | null {
  const indegree = new Map(nodes.map((n) => [n, 0]));
  const dependents = new Map<string, string[]>();
  for (const [task, deps] of edges) {
    for (const d of deps) {
      if (!indegree.has(task) || !indegree.has(d)) continue;
      indegree.set(task, (indegree.get(task) ?? 0) + 1);
      dependents.set(d, [...(dependents.get(d) ?? []), task]);
    }
  }
  const queue = nodes.filter((n) => indegree.get(n) === 0).sort();
  const order: string[] = [];
  while (queue.length) {
    const n = queue.shift()!;
    order.push(n);
    for (const m of dependents.get(n) ?? []) {
      indegree.set(m, indegree.get(m)! - 1);
      if (indegree.get(m) === 0) queue.push(m);
    }
  }
  return order.length === nodes.length ? order : null;
}
