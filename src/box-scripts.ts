// Text ktchn sends into a sandbox to run there. Every path in it is absolute,
// and what deletes anything first proves it is inside a sandbox's copy of the
// project, so a script that reaches the wrong machine or directory does
// nothing. These are pure strings, tested without a sandbox.

// Where the project's copy lives in a sandbox, and the file only a ktchn
// sandbox image has (docker/sandbox/Dockerfile).
export const COPY_PATH = '/home/agent/copy';
export const SENTINEL = '/etc/ktchn-sandbox';
export const SEEDED = `${COPY_PATH}/.git/ktchn-seeded`;
export const GUARD_EXIT = 97;

// Git run on what the agent wrote must not run programs its configuration
// names or wait on them, whatever the agent put in .git/config. One way stays
// open: a filter driver named in the copy's .gitattributes or
// .git/info/attributes and defined in its config runs when status reads
// a file. It runs inside the sandbox as the agent's user,
// under exec's timeout and output cap, so it can do nothing the agent could
// not already do there (ADR 0015).
export const SAFE_GIT = [
  'git',
  '--no-optional-locks',
  '-c core.fsmonitor=false',
  '-c core.hooksPath=/dev/null',
  '-c core.pager=cat',
  '-c core.attributesFile=/dev/null',
  '-c core.untrackedCache=false',
  '-c protocol.ext.allow=never',
  '-c diff.external=',
  '-c gc.auto=0',
].join(' ');

export const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

// Exits GUARD_EXIT without touching anything unless the shell is in the
// sandbox's copy and the sentinel exists.
const guard =
  `if [ "$(pwd -P)" = ${COPY_PATH} ] && [ -f ${SENTINEL} ]; then :; ` +
  `else echo 'ktchn: not in a ktchn sandbox copy, refusing to clear it' >&2; ` +
  `exit ${GUARD_EXIT}; fi`;

export const seedScript = (opts: {
  ref: string;
  branch?: string;
  identity: readonly (readonly [key: string, value: string])[];
}) =>
  [
    guard,
    // An interrupted seed left files that are not a repository.
    `find ${COPY_PATH} -mindepth 1 -maxdepth 1 -exec rm -rf {} +`,
    'cat > /tmp/seed.bundle',
    `${SAFE_GIT} init -q ${COPY_PATH}`,
    `${SAFE_GIT} fetch -q /tmp/seed.bundle --end-of-options ${opts.ref}`,
    opts.branch === undefined
      ? `${SAFE_GIT} checkout -q --detach FETCH_HEAD --`
      : `${SAFE_GIT} checkout -q -B ${opts.branch} FETCH_HEAD --`,
    ...opts.identity.map(
      ([key, value]) => `${SAFE_GIT} config ${key} ${quote(value)}`
    ),
    'rm -f /tmp/seed.bundle',
    `touch ${SEEDED}`,
  ].join(' && ');
