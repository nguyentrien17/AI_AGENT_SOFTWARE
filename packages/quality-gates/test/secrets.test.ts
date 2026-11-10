import { describe, expect, it } from 'vitest';
import { scanText, scanUnifiedDiff, validateGateKeys } from '../src/index.js';

// Built at runtime so this file itself never contains a scannable credential.
const AWS = ['AKIA', 'Q3EGRAVEZ7WN4PLK'].join('');
const GH = ['ghp_', 'a'.repeat(20), 'B'.repeat(16)].join('');
const OPENAI = ['sk-', 'proj-', 'Zq8'.repeat(12)].join('');
const KEY = ['-----BEGIN ', 'RSA PRIVATE KEY-----'].join('');

describe('secret scanner (P8-02)', () => {
  it.each([
    ['aws_access_key', `const id = "${AWS}";`],
    ['github_token', `token: ${GH}`],
    ['openai_key', `OPENAI_API_KEY=${OPENAI}`],
    ['private_key', KEY],
    ['url_credentials', 'DATABASE_URL=postgres://app:S3cr3tPassw0rd@db.internal:5432/app'],
    ['hardcoded_secret', 'const password = "hunter2hunter2";'],
  ])('detects %s', (ruleId, line) => {
    const [finding] = scanText('src/config.ts', line);
    expect(finding).toMatchObject({ ruleId, file: 'src/config.ts', line: 1 });
    // The finding never repeats the secret.
    expect(finding!.preview).toMatch(/^.{1,4}…\(\d+ chars\)$/);
  });

  it('ignores placeholders and environment lookups', () => {
    for (const line of [
      'const password = "changeme";',
      'apiKey: "${API_KEY}"',
      'const secret = "<your-secret-here>";',
      'const token = process.env.TOKEN;',
      'password: "xxxxxxxx"',
      'DATABASE_URL=postgres://user:${DB_PASSWORD}@db:5432/app',
    ]) {
      expect(scanText('a.ts', line), line).toEqual([]);
    }
  });

  it('scans only added lines of a diff and reports new-file line numbers', () => {
    const diff = [
      'diff --git a/src/a.ts b/src/a.ts',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1,3 +10,4 @@',
      ' unchanged',
      `-const old = "${AWS}";`,
      '+const fine = 1;',
      `+const leaked = "${AWS}";`,
      ' tail',
    ].join('\n');
    expect(scanUnifiedDiff(diff)).toEqual([
      expect.objectContaining({ ruleId: 'aws_access_key', file: 'src/a.ts', line: 12 }),
    ]);
  });

  it('validates gate keys', () => {
    expect(validateGateKeys(['secret_scan', 'unit_tests', 'secret_scan'])).toEqual(['secret_scan', 'unit_tests']);
    expect(() => validateGateKeys(['rm_rf'])).toThrow(/gates must be/);
  });
});
