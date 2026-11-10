---
name: verify-ktchn
description: Drive ktchn's real CLI (`node src/start.ts`) against a disposable instance and capture what it did. Use to prove a change to how a run starts, goes through its rounds and review, reaches handoff, parks, or survives a crash, instead of relying on unit tests alone.
---

# verify-ktchn

ktchn's one surface today is a non-interactive CLI, `node src/start.ts <repo> <job text> [flags]`. It runs until the run ends or parks, then exits. There is no server to keep up and no TTY to drive. Each drive is one process, and the outcome is its exit code, its stdout and stderr, and what it changed.

Everything goes through one harness, from the root of this repository:

```sh
V=.claude/skills/verify-ktchn/bin/verify-ktchn
```

Words here follow [GLOSSARY.md](../../../GLOSSARY.md): owner, job, run, round, project, clone, sandbox, review, check, handoff, park, policy, ledger.

**What is real and what is not.** `src/start.ts`, Docker sandboxes, the ledger, git and the model are real. GitHub is the only stand-in: a local bare origin reached through `core.sshCommand` in the throwaway project, and a `gh` script on `PATH`.

**Costs.** Each drive that reaches a round spends real money on the owner's OpenRouter key: about $0.0003 for a simple job and $0.02 for a run that exhausts its reviews. Job text goes to OpenRouter, so keep it synthetic.

Features to drive are listed in [features/README.md](features/README.md).

## Launch

```sh
ID=$($V launch)            # or: $V launch my-name
eval "$($V env "$ID")"     # sets KTCHN_VERIFY_ID, _INSTANCE, _PROJECT, _EVIDENCE
```

`launch` needs only a running Docker daemon. `~/.ktchn-verify` may be absent. It installs dependencies if `node_modules` is missing, builds `ktchn-sandbox:latest` if the image is missing, then creates the instance under `~/.ktchn-verify/instances/$ID/`:

- `home/` is the instance's `KTCHN_HOME`, so the owner's `~/.ktchn` is never touched.
- `project/` is a throwaway git project with a `README.md` and a `package.json`. Its origin URL is `git@github.com:ktchn-verify/target.git`.
- `origin.git/` is the local bare repository that origin really reaches.
- `bin/` holds the `gh` and ssh stand-ins.

It is ready when `launch` runs the doctor, prints every line as `ok` (a Node version `warn` is allowed), and prints the ID on stdout. Instances are isolated from each other: run IDs hash the project path, so two can run side by side. This has been exercised. Use a new label for each drive; a repeated label is refused.

Teardown is [Cleanup](#cleanup).

## Doctor

Run this first whenever anything looks off. It only reads, apart from one throwaway `docker run --rm --network none` to check the image.

```sh
$V doctor "$ID"
```

It reports the build (`git rev-parse` plus whether `src` has uncommitted changes), the Node version against `.nvmrc`, `node_modules`, the Docker daemon, the image's `/etc/ktchn-sandbox` sentinel, whether an OpenRouter key is present (never its value), that `KTCHN_HOME` is disposable, that `gh` resolves to the stand-in, that origin looks like GitHub and reads the local stand-in, any drive still running, the instance's sandboxes, and a one-line ledger summary per run. It exits non-zero on any `FAIL`.

## Drive

```sh
$V start "$ID" <label> [--background] [--no-key] -- '<job text>' [--check '<cmd>']... [--allow-path '<glob>']... [--model <id>] [--network]
$V raw   "$ID" <label> [--background] [--no-key] -- <literal start.ts arguments>
```

- `start` passes the instance's project as `<repo>`. `raw` passes exactly what follows `--`, for argument errors.
- A foreground drive prints the exit code, stdout, stderr without Node's experimental warnings, a ledger summary, and the capture directory.
- `--no-key` gives the process an empty `HOME` and no `OPENROUTER_API_KEY`.
- The same job text and flags in the same instance mean the same run ID. Change the text to start another run.
- `run <id> resumed` on stdout is the CLI's wording for any restart. It is not the glossary's resume, which needs a parked run and an answer from the owner.

For a drive you need to touch while it runs:

```sh
$V start "$ID" lbl --background -- 'job text' --check 'test -f x'
$V wait-file "$ID" /home/agent/copy/started.txt 180   # prints the sandbox name once that file exists
$V kill "$ID" lbl                                     # SIGKILL of the pid this harness started
$V wait "$ID" lbl 300                                 # waits, captures, prints as a foreground drive does
```

To stop the agent at a known point, have the job text create a file and then sleep, one tool call per step. The sandbox's working directory is `/home/agent/copy`. Sandboxes are named `ktchn-<runId>-r<round>`, with `-collect` and `-review` for those steps. Use `docker inspect` and `docker exec` on them directly.

Two `gh` conditions are set by hand on the instance: `touch "$KTCHN_VERIFY_INSTANCE/gh.fail"` makes `gh repo view` fail as if logged out, and `git -C "$KTCHN_VERIFY_PROJECT" remote ...` changes origin. Restore both before the next drive.

`scripts/prove-clone.ts` and `scripts/prove-agent.ts` drive internals with a scripted agent, so they are not the owner's path. They are useful beside this skill for sandbox invariants, but do not count as a drive here.

## Evidence

Every drive writes to `~/.ktchn-verify/evidence/$ID/<label>/`, which survives cleanup:

| File                                        | What it shows                                            |
| ------------------------------------------- | -------------------------------------------------------- |
| `command.txt`                               | The exact `start.ts` invocation                          |
| `stdout.txt`, `stderr.txt`, `exit-code.txt` | The process's own output and exit                        |
| `ledger.json`, `ledger-summary.txt`         | Every ledger record, and events plus model cost per run  |
| `refs-before.txt`, `refs-after.txt`         | The project's refs around the drive                      |
| `origin-refs-after.txt`                     | What reached origin                                      |
| `handoff-<runId>.patch`                     | Each handoff's commits and its net change against `main` |
| `prs/ktchn_<runId>.{body,create,list}`      | What `gh pr create` was given                            |
| `gh.log`, `ssh.log`                         | Every `gh` and git-over-ssh call the instance made       |
| `home-runs.txt`, `docker.txt`               | Clones, sandboxes and volumes left after the drive       |

In the glossary, a run's evidence is its check results and the reviewer's judgement. That is `checks_ran` in `ledger.json`. The rest of this directory is what a verifier captures around the run.

Standards for a capture to count:

- Exercise the real path: `src/start.ts` as the owner runs it, never `ledger.appendEvent` or other internals.
- Capture the action and the resulting state, not only the last line. A `done` report without the handoff branch, the origin ref and the PR body is not enough.
- Check the side effects: refs in the project and at origin, clones and volumes that remain or are gone, and the ledger's event order.
- Observe that the stand-ins held. `gh.log` and `ssh.log` should hold every GitHub-bound call, and none may reach github.com.
- Mock only GitHub, which is already a boundary in production. Do not stub the model, Docker or git.

Blocking rules for this surface:

- Any new uncaught exception or stack trace on stderr during a drive blocks done. Two predate this skill and are named in [start-refusals.md](features/start-refusals.md).
- There is no browser UI, so console errors, accessibility violations and visual baselines do not apply.

**Not proved here:** a real `git push` to GitHub, a real `gh pr create`, and real `gh` authentication. The stand-in replaces these, along with the local origin setup, `ssh.variant=simple`, and the project's `user.name` and `user.email` that `launch` sets. They stay unverified until a run against a real GitHub project covers them. `launch` installing dependencies and building the image from nothing has also not been exercised, because both already existed when this skill was proved.

## Cleanup

```sh
$V cleanup "$ID"
```

This kills only the drives this instance started, checked by recorded pid and command line. It removes the instance's sandboxes and volumes by run ID and `ktchn.home` label, deletes `~/.ktchn-verify/instances/$ID`, and writes `cleanup.txt` beside the evidence. Evidence is never removed. `$V list` shows instances still present.

Run cleanup after every drive session, including failed ones.
