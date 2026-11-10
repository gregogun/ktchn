# Start refusals

`start` declines a job it could not carry through, and says why before spending anything on a model. None of these recipes make a model call or need a key, and the drive leaves no run behind.

## Sub-features

- `refuse-usage` prints usage for missing arguments.
- `refuse-path` fails for a project path that does not exist.
- `refuse-no-origin` refuses a project without an origin.
- `refuse-not-github` refuses an origin that is not on GitHub.
- `refuse-gh` refuses when `gh` cannot reach the repository.
- `refuse-no-key` fails when no OpenRouter key is available.

## How to get to it (user POV)

- Run `node src/start.ts` with the arguments or environment below.

## Driving it with verify-ktchn

Preconditions:

- The baseline in [README.md](./README.md). The ledger summary should not gain a new run from any recipe here.

- **Usage.** Run `$V raw "$ID" refuse-usage --`. Exit code is `2` and stderr starts with `usage: node src/start.ts`.
- **Missing path.** Run `$V raw "$ID" refuse-path -- /nonexistent/project 'a job'`. Exit code is `1` and stderr has `ENOENT`.
- **No origin.** Run `git -C "$KTCHN_VERIFY_PROJECT" remote remove origin`, then `$V start "$ID" refuse-no-origin -- 'a job with no origin'`. Exit code is `1` and stderr has `has no origin, so a run could not open its PR`. Restore with `git -C "$KTCHN_VERIFY_PROJECT" remote add origin git@github.com:ktchn-verify/target.git`.
- **Not GitHub.** Run `git -C "$KTCHN_VERIFY_PROJECT" remote set-url origin https://example.com/a/b.git`, then `$V start "$ID" refuse-not-github -- 'a job for elsewhere'`. Exit code is `1` and stderr has `is not a GitHub URL`. Restore with `git -C "$KTCHN_VERIFY_PROJECT" remote set-url origin git@github.com:ktchn-verify/target.git`.
- **gh unavailable.** Run `touch "$KTCHN_VERIFY_INSTANCE/gh.fail"`, then `$V start "$ID" refuse-gh -- 'a job gh cannot open'`. Exit code is `1` and stderr has `gh cannot reach` and `not logged in`. Restore with `rm "$KTCHN_VERIFY_INSTANCE/gh.fail"`.
- **No key.** Run `$V start "$ID" refuse-no-key --no-key -- 'a job with no key'`. Exit code is `1`, and stderr has `ENOENT` for `.pi/agent/auth.json`.

## Gotchas

- Two refusals predate this map and end in an uncaught Node stack trace rather than a sentence: the missing path (`realpathSync` in `src/start.ts`) and a missing `~/.pi/agent/auth.json` (`readOpenRouterKey` in `src/agent.ts`). The friendly `No OpenRouter key` message appears only when the file exists without a key. Any other new stack trace blocks done.
- `refuse-no-key` is checked after `gh` and the lease, so it needs a working stand-in. Run it with origin restored.
- The usage and missing-path refusals exit before anything else. The rest also need Docker, because `start` sweeps volumes first, but none of them use the sandbox image.
- Restore origin after each recipe. A later recipe that fails for the wrong reason is misleading evidence.
