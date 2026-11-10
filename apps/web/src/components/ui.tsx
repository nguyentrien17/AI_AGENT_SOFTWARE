import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react';

/** Small shadcn/ui-style primitives (ADR-010), written in-repo. */
const cx = (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(' ');

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost';
const VARIANTS: Record<Variant, string> = {
  primary: 'bg-slate-900 text-white hover:bg-slate-700',
  secondary: 'bg-white text-slate-900 border border-slate-300 hover:bg-slate-100',
  danger: 'bg-red-600 text-white hover:bg-red-500',
  ghost: 'text-slate-700 hover:bg-slate-100',
};

export function Button({ variant = 'primary', className, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return (
    <button
      {...props}
      className={cx(
        'inline-flex items-center justify-center gap-1 rounded-md px-3 py-1.5 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50',
        VARIANTS[variant],
        className,
      )}
    />
  );
}

const field = 'w-full rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-sm focus:border-slate-500 focus:outline-none';
export const Input = (props: InputHTMLAttributes<HTMLInputElement>) => <input {...props} className={cx(field, props.className)} />;
export const Textarea = (props: TextareaHTMLAttributes<HTMLTextAreaElement>) => (
  <textarea {...props} className={cx(field, 'font-mono', props.className)} />
);
export const Select = (props: SelectHTMLAttributes<HTMLSelectElement>) => <select {...props} className={cx(field, props.className)} />;

export function Label({ text, children, hint }: { text: string; children: ReactNode; hint?: string }) {
  return (
    <label className="block space-y-1 text-sm">
      <span className="font-medium text-slate-700">{text}</span>
      {children}
      {hint && <span className="block text-xs text-slate-500">{hint}</span>}
    </label>
  );
}

export function Card({ title, actions, children, className }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cx('rounded-lg border border-slate-200 bg-white shadow-sm', className)}>
      {(title || actions) && (
        <header className="flex items-center justify-between gap-2 border-b border-slate-100 px-4 py-2.5">
          <h2 className="text-sm font-semibold text-slate-800">{title}</h2>
          <div className="flex gap-2">{actions}</div>
        </header>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}

const TONES: Record<string, string> = {
  green: 'bg-emerald-100 text-emerald-800',
  amber: 'bg-amber-100 text-amber-800',
  red: 'bg-red-100 text-red-800',
  blue: 'bg-sky-100 text-sky-800',
  slate: 'bg-slate-100 text-slate-700',
};
const STATUS_TONE: Record<string, string> = {
  completed: 'green', succeeded: 'green', approved: 'green', passed: 'green', healthy: 'green', active: 'green', dispatched: 'green',
  running: 'blue', ready: 'blue', assigned: 'blue', pending: 'slate', draft: 'slate', skipped: 'slate', unknown: 'slate',
  waiting_for_approval: 'amber', waiting_for_input: 'amber', paused: 'amber', blocked: 'amber', degraded: 'amber', warning: 'amber', requires_approval: 'amber',
  failed: 'red', rejected: 'red', cancelled: 'red', failing: 'red', denied: 'red', approval_required: 'amber',
};

export function Badge({ children, tone }: { children: ReactNode; tone?: keyof typeof TONES }) {
  const t = tone ?? STATUS_TONE[String(children)] ?? 'slate';
  return <span className={cx('inline-block rounded px-1.5 py-0.5 text-xs font-medium whitespace-nowrap', TONES[t])}>{children}</span>;
}

export function Table({ head, children, empty }: { head: string[]; children: ReactNode; empty?: string }) {
  const rows = Array.isArray(children) ? children.filter(Boolean) : children ? [children] : [];
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead className="text-xs uppercase tracking-wide text-slate-500">
          <tr>{head.map((h) => <th key={h} className="px-2 py-1.5 font-medium">{h}</th>)}</tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {rows.length ? children : (
            <tr>
              <td colSpan={head.length} className="px-2 py-4 text-center text-slate-400">{empty ?? 'Nothing yet'}</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
export const Td = ({ children, className }: { children?: ReactNode; className?: string }) => (
  <td className={cx('px-2 py-1.5 align-top', className)}>{children}</td>
);

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: Array<[T, string]>; value: T; onChange: (t: T) => void }) {
  return (
    <div className="flex gap-1 border-b border-slate-200">
      {tabs.map(([key, label]) => (
        <button
          key={key}
          onClick={() => onChange(key)}
          className={cx('-mb-px border-b-2 px-3 py-2 text-sm', value === key ? 'border-slate-900 font-semibold' : 'border-transparent text-slate-500 hover:text-slate-800')}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

export function ErrorNote({ error }: { error: unknown }) {
  if (!error) return null;
  const msg = error instanceof Error ? error.message : String(error);
  const code = (error as { code?: string }).code;
  return (
    <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
      {msg} {code && <code className="text-xs text-red-500">({code})</code>}
    </p>
  );
}

export const Muted = ({ children }: { children: ReactNode }) => <p className="text-sm text-slate-500">{children}</p>;
export const Mono = ({ children }: { children: ReactNode }) => <code className="text-xs text-slate-600">{children}</code>;

export function shortId(id: string | null | undefined): string {
  return id ? id.slice(-8) : '—';
}
export function when(iso: string | null | undefined): string {
  return iso ? new Date(iso).toLocaleString() : '—';
}
