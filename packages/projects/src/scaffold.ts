import type { StorageAdapter } from '@platform/storage';
import { canonicalJson } from '@platform/shared';

/** Blueprint §7.2 standard `.ai-context` tree. */
export const AI_CONTEXT_DIRS = [
  '.ai-context/00-index',
  '.ai-context/01-requirements',
  '.ai-context/02-architecture',
  '.ai-context/03-database/schema',
  '.ai-context/03-database/migrations',
  '.ai-context/04-api/api-contracts',
  '.ai-context/04-api/integration-contracts',
  '.ai-context/05-agent-handoffs/ba',
  '.ai-context/05-agent-handoffs/architect',
  '.ai-context/05-agent-handoffs/developer',
  '.ai-context/05-agent-handoffs/qa',
  '.ai-context/06-tasks/pending',
  '.ai-context/06-tasks/in-progress',
  '.ai-context/06-tasks/completed',
  '.ai-context/07-quality/test-results',
  '.ai-context/07-quality/review-reports',
  '.ai-context/08-knowledge',
  '.ai-context/09-decisions',
  '.ai-context/10-checkpoints',
  '.ai-context/11-audit',
  'source-code',
  'tests',
  'documentation',
  'artifacts',
] as const;

export interface ScaffoldInput {
  projectId: string;
  key: string;
  name: string;
  description: string;
  createdAt: Date;
}

export async function scaffoldProjectWorkspace(storage: StorageAdapter, p: ScaffoldInput): Promise<void> {
  for (const dir of AI_CONTEXT_DIRS) {
    await storage.mkdirp(dir);
    await storage.writeAtomic(`${dir}/.gitkeep`, '');
  }
  const manifest = {
    schema_version: '1.0',
    project_id: p.projectId,
    key: p.key,
    name: p.name,
    created_at: p.createdAt.toISOString(),
    context_root: '.ai-context',
  };
  await storage.writeAtomic('.ai-context/00-index/project-manifest.json', JSON.stringify(JSON.parse(canonicalJson(manifest)), null, 2) + '\n');
  await storage.writeAtomic(
    '.ai-context/00-index/context-map.json',
    JSON.stringify({ schema_version: '1.0', items: [] }, null, 2) + '\n',
  );
  await storage.writeAtomic(
    '.ai-context/00-index/current-state.md',
    `# ${p.name} — Current State\n\nStage: intake\n\n${p.description || '_No description yet._'}\n`,
  );
  await storage.writeAtomic('.ai-context/07-quality/known-issues.md', '# Known Issues\n\n_None recorded._\n');
  await storage.writeAtomic('.ai-context/08-knowledge/coding-standards.md', '# Coding Standards\n\n_To be defined by the Architect Agent._\n');
  await storage.writeAtomic('.ai-context/08-knowledge/conventions.md', '# Conventions\n\n_To be defined._\n');
  await storage.writeAtomic('.ai-context/08-knowledge/glossary.md', '# Glossary\n\n_To be defined by the BA Agent._\n');
  await storage.writeAtomic('.ai-context/06-tasks/task-index.json', JSON.stringify({ schema_version: '1.0', tasks: [] }, null, 2) + '\n');
  await storage.writeAtomic('.gitignore', 'node_modules/\n.env\n.env.*\n/artifacts/.blobs/\n');
}
