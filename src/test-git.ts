import { execFileSync } from 'node:child_process';

/* Hooks run tests with GIT_DIR and GIT_INDEX_FILE set for the commit being
   made; a test repo must not inherit them.
*/
for (const name of Object.keys(process.env)) {
  if (name.startsWith('GIT_')) delete process.env[name];
}

process.env.GIT_CONFIG_NOSYSTEM = '1';
process.env.GIT_CONFIG_GLOBAL = '/dev/null';

/* Without a configured identity git falls back to the machine's account name,
   which CI runners do not have.
*/
const IDENTITY = {
  GIT_AUTHOR_NAME: 'test',
  GIT_AUTHOR_EMAIL: 'test@localhost',
  GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 'test@localhost',
};

export const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...IDENTITY },
  }).trim();
