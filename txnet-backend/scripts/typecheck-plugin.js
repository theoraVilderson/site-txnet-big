// Gives every project a cached `typecheck` target, one `tsc --noEmit` per
// tsconfig.{app,lib,spec}.json in its root (`scripts/typecheck.sh --project`).
//
// Why a target and not a loop in the script: the loop re-ran every config from
// scratch, 22 tsc processes each re-parsing the 192k-line Prisma client —
// 265s on 2026-09-23 for a change to one .prisma file. As a target it gets the
// Nx cache that `test` already has: a project whose inputs did not change since
// its last green check is not checked again.
//
// The configs are globbed per project, not listed, so a project added next
// month is checked the day it gets a tsconfig.
//
// The inputs are the cache key, so they must name everything tsc can see:
// files outside every project (the Prisma schema that generates the client
// type, `test-support/`) are not in `default` and are added here by hand.
const { existsSync } = require('node:fs');
const { dirname, join } = require('node:path');

const CONFIGS = ['tsconfig.app.json', 'tsconfig.lib.json', 'tsconfig.spec.json'];

const typecheck = {
  command: 'bash scripts/typecheck.sh --project {projectRoot}',
  cache: true,
  inputs: [
    'default',
    '^default',
    '{workspaceRoot}/tsconfig.base.json',
    '{workspaceRoot}/prisma/**/*.prisma',
    '{workspaceRoot}/test-support/**/*',
    '{workspaceRoot}/scripts/typecheck.sh',
    { externalDependencies: ['typescript'] },
  ],
  outputs: [],
};

const createNodes = [
  '*/project.json',
  async (files, _options, context) =>
    files.flatMap((file) => {
      const root = dirname(file);
      const has = CONFIGS.some((c) => existsSync(join(context.workspaceRoot, root, c)));
      return has ? [[file, { projects: { [root]: { targets: { typecheck } } } }]] : [];
    }),
];

module.exports = { createNodes, createNodesV2: createNodes };
