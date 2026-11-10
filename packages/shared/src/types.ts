export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

/** Who is performing an action. Agents are system actors and never hold human approval rights. */
export type Actor =
  | { type: 'user'; userId: string; workspaceId: string }
  | { type: 'agent'; agentKey: string; agentVersion: number; workspaceId: string; taskId?: string }
  | { type: 'system'; workspaceId: string | null; component: string };

export function actorId(actor: Actor): string {
  switch (actor.type) {
    case 'user':
      return actor.userId;
    case 'agent':
      return `${actor.agentKey}@${actor.agentVersion}`;
    case 'system':
      return actor.component;
  }
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export function clampLimit(limit: number | undefined, def = 50, max = 100): number {
  if (!limit || Number.isNaN(limit) || limit < 1) return def;
  return Math.min(Math.floor(limit), max);
}
