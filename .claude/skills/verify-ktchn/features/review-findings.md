# Review findings

Review tells the agent what is wrong and gives it another round. Once the checks pass, a reviewer with none of the agent's context judges the diff against the job text, and its findings go back to the agent the same way. A commit touching protected paths is refused unless the job allows them. A run that cannot pass review parks rather than reaching handoff.

## Sub-features

- `review-fix` sends failing check output to the agent, which fixes it and passes.
- `review-protected` refuses a commit that changes a protected path such as `package.json`.
- `review-allow-path` lets `--allow-path` permit one.
- `reviewer-pass` passes work that does what the job asked, with the verdict in the ledger.
- `reviewer-fail` sends the reviewer's findings to the agent as another round.
- `review-exhausted` parks a run after its third failed review, keeping its clone and volume and handing off nothing.

## How to get to it (user POV)

- Run `node src/start.ts <repo> <job text> --check "<command>"`, with a check the work can fail.
- Run `node src/start.ts <repo> <job text> --allow-path "<glob>"`, for a job meant to change a protected path.

## Driving it with verify-ktchn

Preconditions:

- The baseline in [README.md](./README.md), with a model key.

- **Fixable failure.** Run `$V start "$ID" review-fix -- 'Create a file named a.txt containing the word one, then commit it.' --check 'test -f never-created.txt'`. Exit code is `0`. The ledger shows `ReviewFailed` then `ReviewPassed`, because the agent reads the finding and creates the file.
- **Protected path.** Run `$V start "$ID" review-protected -- 'Add the field "version": "1.0.0" to package.json, then commit it. Do not change anything else.'`. `ledger.json` has a `ReviewFailed` whose findings say `The commit changes protected paths the job does not allow: package.json`.
- **Protected path allowed.** Run `$V start "$ID" review-allowed -- 'Add the field "version": "1.0.0" to package.json, then commit it. Do not change anything else.' --allow-path package.json`. Exit code is `0`, the ledger has no `ReviewFailed`, and the net change in `handoff-<id>.patch` includes `package.json`.
- **Reviewer passes.** Run `$V start "$ID" reviewer-pass -- 'Create a file named a.txt containing the word one, then commit it.' --check 'test -f a.txt'`. Exit code is `0`. `ledger.json` has a `reviewer_judged` record with verdict `pass` before `ReviewPassed`, and its model calls sit under a `reviewer:<n>` session.
- **Reviewer fails.** Run `$V start "$ID" reviewer-fail -- 'Change only the title line of README.md to "Kitchen", and commit it. Do not touch any other file.' --check 'true'`. The check cannot fail, so any `ReviewFailed` here comes from the reviewer: look for a `reviewer_judged` record with verdict `fail`, then a second `AgentFinished` and a `ReviewPassed`.
- **Reviews run out.** Run `$V start "$ID" review-exhausted -- 'Create a file named c.txt containing the word one, then commit it.' --check 'false'`. Exit code is `0`. stdout reports `"status":"parked"` with `"kind":"review_exhausted"`. The ledger holds three `ReviewFailed` events and no `PrOpened`.
- **Parked state kept.** In `review-exhausted/`, `docker.txt` shows no sandboxes and the volume `ktchn-<id>`, and `home-runs.txt` has `runs/<id>/repo`. `refs-after.txt` has no `ktchn/<id>` branch for this run.

## Gotchas

- A reviewer fail is hard to force with a capable agent and may take several tries, each a paid drive. Report an unforced fail as not reached rather than as verified.
- The reviewer costs one model call per review that passes its checks, at a stronger and pricier model than the agent's.
- A check the agent can satisfy is not a way to reach `review_exhausted`. Use `--check 'false'`.
- `review-exhausted` costs far more than other recipes: about $0.02 and 42 model calls when observed, as the agent keeps trying.
- After `review-protected`, the agent usually restores the file in a second commit and the run still reaches `done`. The net change against `main` is empty, while the branch's history still touches `package.json`. Read the net change in the patch.
- Starting a parked run again prints `run <id> resumed` and reports the same park without any new model call. `start.ts` has no way yet for the owner to answer a parked run, so resuming one cannot be driven from the CLI.
