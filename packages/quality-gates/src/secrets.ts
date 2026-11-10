/**
 * Secret / credential leak detection (Blueprint §12.2, P8-02). Deterministic, offline, pattern based.
 * Scans only what a task added, so pre-existing findings in the base branch are not blamed on the task.
 */
export type SecretSeverity = 'critical' | 'high' | 'medium';

export interface SecretRule {
  id: string;
  description: string;
  severity: SecretSeverity;
  pattern: RegExp;
  /** Capture group holding the secret value (0 = whole match). */
  group?: number;
}

export const SECRET_RULES: readonly SecretRule[] = [
  { id: 'private_key', description: 'Private key block', severity: 'critical', pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/ },
  { id: 'aws_access_key', description: 'AWS access key id', severity: 'critical', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { id: 'github_token', description: 'GitHub token', severity: 'critical', pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})\b/ },
  { id: 'anthropic_key', description: 'Anthropic API key', severity: 'critical', pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
  { id: 'openai_key', description: 'OpenAI-style API key', severity: 'critical', pattern: /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,}/ },
  { id: 'google_api_key', description: 'Google API key', severity: 'critical', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { id: 'slack_token', description: 'Slack token', severity: 'critical', pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/ },
  { id: 'stripe_live_key', description: 'Stripe live key', severity: 'critical', pattern: /\b(?:sk|rk)_live_[A-Za-z0-9]{20,}/ },
  { id: 'jwt', description: 'JSON Web Token', severity: 'high', pattern: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
  {
    id: 'url_credentials',
    description: 'Credentials embedded in a connection URL',
    severity: 'high',
    pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@'"]+:([^\s@/'"]{6,})@[^\s'"]+/i,
    group: 1,
  },
  {
    id: 'hardcoded_secret',
    description: 'Hard-coded password, secret or API key assignment',
    severity: 'medium',
    pattern: /\b(?:password|passwd|pwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret)\b["']?\s*[:=]\s*["']([^"'\s]{8,})["']/i,
    group: 1,
  },
];

/** Obvious placeholders are not leaks. */
const PLACEHOLDER = /^(?:x+|\*+|\.+|changeme|change[-_]?me|example|placeholder|your[-_a-z]*|dummy|redacted|test|secret|password|<[^>]*>|\$\{[^}]*\}|\{\{[^}]*\}\}|%[A-Z_]+%|process\.env\..*)$/i;

export interface SecretFinding {
  ruleId: string;
  severity: SecretSeverity;
  description: string;
  file: string;
  line: number;
  /** Never the secret itself: first 4 characters and a length. */
  preview: string;
}

function mask(value: string): string {
  return `${value.slice(0, 4)}…(${value.length} chars)`;
}

export function scanText(file: string, text: string, firstLine = 1): SecretFinding[] {
  const findings: SecretFinding[] = [];
  text.split('\n').forEach((lineText, i) => {
    for (const rule of SECRET_RULES) {
      const m = rule.pattern.exec(lineText);
      if (!m) continue;
      const value = m[rule.group ?? 0] ?? m[0];
      if (PLACEHOLDER.test(value) || /^(?:test|fake|dummy|example)/i.test(value)) continue;
      findings.push({ ruleId: rule.id, severity: rule.severity, description: rule.description, file, line: firstLine + i, preview: mask(value) });
      break; // one finding per line is enough to act on
    }
  });
  return findings;
}

/** Scans the added lines of a unified diff, reporting the line numbers in the new file. */
export function scanUnifiedDiff(diff: string): SecretFinding[] {
  const findings: SecretFinding[] = [];
  let file = '';
  let line = 0;
  for (const raw of diff.split('\n')) {
    if (raw.startsWith('+++ ')) {
      file = raw.slice(4).replace(/^b\//, '').trim();
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) {
      line = Number(hunk[1]);
      continue;
    }
    if (raw.startsWith('+') && file && file !== '/dev/null') {
      findings.push(...scanText(file, raw.slice(1), line));
      line++;
    } else if (!raw.startsWith('-') && !raw.startsWith('\\')) {
      line++;
    }
  }
  return findings;
}
