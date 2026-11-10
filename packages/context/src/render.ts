import type { LoadedContextPackage } from './builder.js';

const OPEN = '[UNTRUSTED_CONTEXT';
const CLOSE = '[/UNTRUSTED_CONTEXT]';

/** Neutralizes marker look-alikes inside untrusted content so it cannot break out of its block. */
function neutralize(content: string): string {
  return content.replace(
    /\[(\/?)UNTRUSTED_CONTEXT/gi,
    (_m, slash: string) => `[${slash}UNTRUSTED_CONTEXT\u200b`,
  );
}

/**
 * Renders a loaded package into prompt blocks (docs/phase-0/03-architecture.md §6). Every artifact is wrapped as
 * untrusted data with id/version/hash markers; it is never concatenated into system instructions.
 */
export function renderUntrustedContext(pkg: LoadedContextPackage): string {
  const parts: string[] = [];
  if (pkg.manifest.constraints.length) {
    parts.push(
      `${OPEN} kind="project-constraints" package="${pkg.packageId}"]\n` +
        pkg.manifest.constraints.map((c) => `- ${neutralize(c.content)}`).join('\n') +
        `\n${CLOSE}`,
    );
  }
  for (const item of pkg.items) {
    parts.push(
      `${OPEN} id="${item.ref}" path="${item.path}" version="${item.version}" sha256="${item.hash}" relevance="${item.relevance}"]\n` +
        `${neutralize(item.content)}\n${CLOSE}`,
    );
  }
  return parts.join('\n\n');
}
