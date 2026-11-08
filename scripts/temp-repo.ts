import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

export const makeTempRepo = () => {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'ktchn-proof-')));
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 'proof@example.com');
  git(repo, 'config', 'user.name', 'proof');
  writeFileSync(join(repo, 'README.md'), '# proof target\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'init');
  return repo;
};

export const ktchnLeftovers = () => {
  const docker = (args: string[]) =>
    execFileSync('docker', args, { encoding: 'utf8' })
      .split('\n')
      .filter(Boolean);
  return {
    containers: docker([
      'ps',
      '-a',
      '--filter',
      'label=ktchn.run',
      '--format',
      '{{.Names}}',
    ]),
    volumes: docker([
      'volume',
      'ls',
      '--filter',
      'label=ktchn.run',
      '--format',
      '{{.Name}}',
    ]),
  };
};
