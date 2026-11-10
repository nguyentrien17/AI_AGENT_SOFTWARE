import { redact, redactString } from '@platform/shared';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(msg: string, ctx?: Record<string, unknown>): void;
  info(msg: string, ctx?: Record<string, unknown>): void;
  warn(msg: string, ctx?: Record<string, unknown>): void;
  error(msg: string, ctx?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}

/** Structured JSON logger with mandatory secret redaction. */
export function createLogger(
  opts: { level?: LogLevel; bindings?: Record<string, unknown>; sink?: (line: string) => void } = {},
): Logger {
  const level = opts.level ?? 'info';
  const bindings = opts.bindings ?? {};
  const sink = opts.sink ?? ((line: string) => process.stdout.write(line + '\n'));
  const log = (lvl: LogLevel, msg: string, ctx?: Record<string, unknown>) => {
    if (ORDER[lvl] < ORDER[level]) return;
    const record = redact({
      ts: new Date().toISOString(),
      level: lvl,
      msg: redactString(msg),
      ...bindings,
      ...ctx,
    });
    sink(JSON.stringify(record, errorReplacer));
  };
  return {
    debug: (m, c) => log('debug', m, c),
    info: (m, c) => log('info', m, c),
    warn: (m, c) => log('warn', m, c),
    error: (m, c) => log('error', m, c),
    child: (b) => createLogger({ level, bindings: { ...bindings, ...b }, sink }),
  };
}

function errorReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactString(value.message),
      stack: value.stack ? redactString(value.stack) : undefined,
    };
  }
  return value;
}
