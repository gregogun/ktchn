# Hand over a job

The owner hands over a job from the terminal. An agent works on it in a sandbox, review runs the job's checks, and the one reviewed commit is handed off as a branch in the project and opened as a PR.

## Sub-features

- `job-start` records the run and reports `run <id> started`.
- `job-review-pass` runs each `--check` against the agent's commit.
- `job-handoff` adds `refs/heads/ktchn/<id>` to the project and leaves `main` alone.
- `job-pr` pushes that branch and opens a PR whose body lists the job and its checks.
- `job-teardown` removes the run's clone, sandboxes and volume once it is done.
- `job-restart-done` reports a finished job instead of running it again.

## How to get to it (user POV)

- Run `node src/start.ts <repo> <job text> [--check "<command>"]...` from the root of this repository.

## Driving it with verify-ktchn

Preconditions:

- The baseline in [README.md](./README.md), with a model key.
- No earlier run used this job text in this instance.

- **Hand over the job.** Run `$V start "$ID" job-happy -- 'Create a file named hello.txt containing exactly the line: hello from ktchn. Then commit it.' --check 'test "$(cat hello.txt)" = "hello from ktchn"'`. Exit code is `0`. stdout has `run <id> started`, then `run <id> is {"status":"done","pr":"https://github.com/ktchn-verify/target/pull/1"}; model cost $...`.
- **Run events.** Read `job-happy/ledger-summary.txt`. It shows `Dequeued > AgentFinished > ReviewPassed > PrOpened` with at least one model call.
- **Checks passed.** In `job-happy/ledger.json`, the `checks_ran` record lists the `--check` command with `exitCode` `0`.
- **Handoff.** Compare `refs-before.txt` and `refs-after.txt`. The only new branch is `refs/heads/ktchn/<id>`, plus its tracking ref, and `refs/heads/main` has not moved. `handoff-<id>.patch` adds `hello.txt` with `hello from ktchn`.
- **Reached origin.** `origin-refs-after.txt` contains `refs/heads/ktchn/<id>` at the same commit as the project.
- **PR contents.** `prs/ktchn_<id>.body` contains the job text, a `## Checks` list marking the command as passed, and ``ktchn run `<id>` ``. `prs/ktchn_<id>.create` has `--base main --head ktchn/<id>`.
- **Nothing left.** `docker.txt` lists no sandboxes or volumes, and `home-runs.txt` contains only `runs`.
- **Restart a finished job.** Run the first command again under the label `job-again`. Exit code is `0`, stdout is `run <id> is already done: <the same PR URL>`, and the ledger gains no new events.

## Gotchas

- `--check` runs in review's sandbox, which has no network, so a check that needs dependencies must find them in the image. See `docs/sandbox-image.md`.
- The agent's commit message varies. Assert on `hello.txt`, not on the message.
- A run's PR comes from the `gh` stand-in. This proves ktchn's arguments and body, not GitHub's response.
