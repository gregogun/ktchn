import { execFileSync } from 'node:child_process';

const DOCKER_TIMEOUT_MS = 5 * 60_000;

export const docker = (args: readonly string[]) =>
  execFileSync('docker', args, {
    encoding: 'utf8',
    timeout: DOCKER_TIMEOUT_MS,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
