/** Architectural boundary rules — see docs/phase-0/03-architecture.md §3 */
module.exports = {
  forbidden: [
    { name: 'no-circular', severity: 'error', from: {}, to: { circular: true } },
    {
      name: 'packages-must-not-import-apps',
      severity: 'error',
      from: { path: '^packages/' },
      to: { path: '^apps/' },
    },
    {
      name: 'only-tool-executor-uses-sandbox',
      severity: 'error',
      from: { path: '^packages/', pathNot: '^packages/(tool-executor|sandbox)/' },
      to: { path: '^packages/sandbox/' },
    },
    {
      name: 'no-child-process-outside-tool-executor',
      severity: 'error',
      from: { path: '^packages/', pathNot: '^packages/(tool-executor|sandbox|projects/src/git)' },
      to: { path: '^(node:)?child_process$' },
    },
    {
      name: 'no-test-code-in-src',
      severity: 'error',
      from: { path: '/src/' },
      to: { path: '/test/' },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsPreCompilationDeps: true,
    exclude: { path: '(dist|node_modules)/' },
  },
};
