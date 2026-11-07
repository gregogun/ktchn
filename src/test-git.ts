import { execFileSync } from 'node:child_process';

// Hooks run tests with GIT_DIR and GIT_INDEX_FILE set for the commit being
// made; a test repo must not inherit them.
for (const name of Object.keys(process.env)) {
  if (name.startsWith('GIT_')) delete process.env[name];
}

export const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
