/**
 * Domain error hierarchy. Every error maps to an RFC 7807 Problem Details payload at the HTTP boundary.
 */
export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
  code: string;
  errors?: Array<{ path: string; message: string }>;
  [extension: string]: unknown;
}

export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  readonly title: string;
  readonly extensions: Record<string, unknown>;

  constructor(opts: {
    status: number;
    code: string;
    title: string;
    detail?: string;
    extensions?: Record<string, unknown>;
    cause?: unknown;
  }) {
    super(opts.detail ?? opts.title, { cause: opts.cause });
    this.name = new.target.name;
    this.status = opts.status;
    this.code = opts.code;
    this.title = opts.title;
    this.extensions = opts.extensions ?? {};
  }

  toProblem(instance?: string): ProblemDetails {
    return {
      type: `https://errors.ai-agent-platform.local/${this.code}`,
      title: this.title,
      status: this.status,
      detail: this.message,
      code: this.code,
      ...(instance ? { instance } : {}),
      ...this.extensions,
    };
  }
}

export class ValidationError extends AppError {
  constructor(detail: string, errors?: Array<{ path: string; message: string }>) {
    super({
      status: 400,
      code: 'validation_error',
      title: 'Validation failed',
      detail,
      extensions: errors ? { errors } : {},
    });
  }
}

export class UnauthenticatedError extends AppError {
  constructor(detail = 'Authentication required') {
    super({ status: 401, code: 'unauthenticated', title: 'Unauthenticated', detail });
  }
}

export class ForbiddenError extends AppError {
  constructor(detail = 'You do not have permission to perform this action') {
    super({ status: 403, code: 'forbidden', title: 'Forbidden', detail });
  }
}

export class NotFoundError extends AppError {
  constructor(resource: string, id?: string) {
    super({
      status: 404,
      code: 'not_found',
      title: 'Not found',
      detail: id ? `${resource} '${id}' not found` : `${resource} not found`,
    });
  }
}

export class ConflictError extends AppError {
  constructor(detail: string, code = 'conflict', extensions?: Record<string, unknown>) {
    super({ status: 409, code, title: 'Conflict', detail, ...(extensions ? { extensions } : {}) });
  }
}

/** Optimistic concurrency failure: caller's expected version does not match the stored version. */
export class VersionConflictError extends ConflictError {
  constructor(resource: string, expected: number, actual: number) {
    super(`${resource} version conflict: expected ${expected}, current ${actual}`, 'version_conflict', {
      expected,
      actual,
    });
  }
}

export class InvalidStateTransitionError extends AppError {
  constructor(entity: string, from: string, to: string, reason?: string) {
    super({
      status: 409,
      code: 'invalid_state_transition',
      title: 'Invalid state transition',
      detail: `${entity} cannot transition from '${from}' to '${to}'${reason ? `: ${reason}` : ''}`,
      extensions: { from, to },
    });
  }
}

export class UnprocessableError extends AppError {
  constructor(detail: string, code = 'unprocessable') {
    super({ status: 422, code, title: 'Unprocessable request', detail });
  }
}

export function isAppError(e: unknown): e is AppError {
  return e instanceof AppError;
}
