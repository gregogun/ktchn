# ktchn verification map

This directory is the maintained source for verifying what the owner can do with ktchn. Read this index before driving, then use the matching feature file as the recipe.

## Baseline preconditions

- Docker is running and `$V doctor "$ID"` reports no `FAIL`, where `V=.claude/skills/verify-ktchn/bin/verify-ktchn` from the root of this repository.
- `ID=$($V launch)` and `eval "$($V env "$ID")"` have run in the current shell.
- The instance's project is the seed from `launch`: `README.md` and `package.json` on `main`, with a stand-in GitHub origin.
- An OpenRouter key is available as `OPENROUTER_API_KEY` or in `~/.pi/agent/auth.json`, except for free recipes in `start-refusals`.
- Never drive an instance this session did not launch.

## Driving conventions

- Use a new `<label>` for every drive. The label names the capture directory.
- Treat every command as literal. Identical job text and flags in the same instance reach the same run.
- Assert on the exit code and on `ledger.json` event order, not on the wording of the model's commits.
- A job that needs to stay alive for inspection creates a marker file and then sleeps. Wait with `$V wait-file`, not a fixed delay.

## Proof and skip reporting

- Report the label, the instance ID, and the capture path for every claim.
- A change to the handoff needs `refs-after.txt`, `origin-refs-after.txt`, `handoff-*.patch` and `prs/`.
- A change to run state needs the event order from `ledger.json`.
- A path you could not reach is reported with the attempted command and the unmet precondition. Do not report it as verified through another path.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph describing behavior the owner can see. It then uses exactly four H2 sections in this order.

1. `Sub-features` lists short IDs with one line for each behavior.
2. `How to get to it (user POV)` lists every entry point.
3. `Driving it with verify-ktchn` starts with `Preconditions:` and uses labeled bullets that pair each action with an exact command and observable result.
4. `Gotchas` lists traps that can waste or invalidate a verification run.

## Features

- [Hand over a job](./hand-over-job.md) covers a run from start through review, handoff and PR, plus restarting a finished job.
- [Review findings](./review-findings.md) covers failing checks, protected paths, `--allow-path`, and parking when reviews run out.
- [Crash and restart](./crash-restart.md) covers a killed run carrying on from its sandbox, and the refusal of a second driver.
- [Network policy](./network-policy.md) covers the sandbox network with and without `--network`.
- [Start refusals](./start-refusals.md) covers the ways `start` declines a job before any model call.
