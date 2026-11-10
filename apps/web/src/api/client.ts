/** Thin client for the platform API (same origin; the session cookie is sent automatically). */
export const API_BASE = '/api/v1';

/** An RFC 7807 problem returned by the API. `code` is machine readable (e.g. routing_halted). */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly problem: Record<string, unknown>;
  constructor(status: number, problem: Record<string, unknown>) {
    super(String(problem['detail'] ?? problem['title'] ?? `HTTP ${status}`));
    this.status = status;
    this.code = String(problem['code'] ?? 'http_error');
    this.problem = problem;
  }
}

export async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method, credentials: 'same-origin', headers: { accept: 'application/json' } };
  if (method !== 'GET') {
    init.headers = { ...init.headers, 'content-type': 'application/json' };
    init.body = JSON.stringify(body ?? {});
  }
  const res = await fetch(`${API_BASE}${path}`, init);
  const text = await res.text();
  const data = text ? (JSON.parse(text) as unknown) : null;
  if (!res.ok) throw new ApiError(res.status, (data as Record<string, unknown> | null) ?? {});
  return data as T;
}

/** Reads an artifact version as text (the content endpoint returns text/plain). */
export async function apiText(path: string): Promise<string> {
  const res = await fetch(`${API_BASE}${path}`, { credentials: 'same-origin' });
  if (!res.ok) throw new ApiError(res.status, (await res.json().catch(() => ({}))) as Record<string, unknown>);
  return res.text();
}

export const get = <T>(path: string) => api<T>('GET', path);
export const post = <T>(path: string, body?: unknown) => api<T>('POST', path, body);
export const put = <T>(path: string, body?: unknown) => api<T>('PUT', path, body);
export const patch = <T>(path: string, body?: unknown) => api<T>('PATCH', path, body);
export const del = <T>(path: string) => api<T>('DELETE', path);

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return `${err.message} (${err.code})`;
  return err instanceof Error ? err.message : String(err);
}
