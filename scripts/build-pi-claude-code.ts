import { execFileSync } from 'node:child_process';
import { copyFileSync, readdirSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

/* pi-claude-code ships TypeScript source only, and Node will not strip types
   under node_modules, so ktchn compiles it to JavaScript on install. tsc emits
   nothing it reaches by import under node_modules, so every file is named.
   index.ts is left out: it is the pi CLI extension entry, which ktchn never
   loads.
*/
const require = createRequire(import.meta.url);
const pkg = realpathSync(
  join(import.meta.dirname, '../node_modules/@earendil-works/pi-claude-code')
);
const src = join(pkg, 'src');
const dist = join(pkg, 'dist');
const sources = readdirSync(src)
  .filter((name) => name.endsWith('.ts') && name !== 'index.ts')
  .map((name) => join(src, name));

execFileSync(
  process.execPath,
  [
    require.resolve('typescript/bin/tsc'),
    ...sources,
    '--outDir',
    dist,
    '--rootDir',
    src,
    '--module',
    'nodenext',
    '--target',
    'es2023',
    '--declaration',
    '--noCheck',
    '--rewriteRelativeImportExtensions',
    '--skipLibCheck',
    '--ignoreConfig',
  ],
  { stdio: 'inherit' }
);
copyFileSync(join(src, 'inert-mcp.mjs'), join(dist, 'inert-mcp.mjs'));
