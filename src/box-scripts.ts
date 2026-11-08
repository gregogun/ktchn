export const COPY_PATH = '/home/agent/copy';
export const SENTINEL = '/etc/ktchn-sandbox';
export const SEEDED = `${COPY_PATH}/.git/ktchn-seeded`;
export const GUARD_EXIT = 97;

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
