# The host never reads what the agent wrote, except a pack that git checks

Status: supersedes [ADR 0014](0014-a-private-clone-per-run.md). Amends [ADR 0002](0002-single-package-external-skills-and-sandbox.md) and [ADR 0012](0012-agent-on-the-host-tools-in-the-sandbox.md) for the sandbox provider.

ADR 0014 gave each run a private clone and mounted it into the sandbox. Five reviews then found ways the host's git, reading files the agent had written under that clone's `.git`, could run a program: a `commondir`, a promisor remote with an `uploadpack` command, alternates, a wrecked `HEAD`, a worktree layout that sent Sandcastle's own git somewhere else. Each fix added a check on the clone (`cloneGit`, `assertCloneUsable`, the worktree layout check), and each check was another thing to get wrong. The premise was the bug again: a repository the agent can write is a repository the host reads.

## The invariant

No host process ever reads a file the agent wrote, except one pack file parsed by `git index-pack --strict`.

## How it holds

- **The sandbox has no mount of any repository.** It is a container with no mount of any repository. The host copies code in as a `git bundle` streamed through `docker exec -i`, and the sandbox runs `git init`, `fetch` and `checkout` itself. Only ktchn's own pi-env binary directory is mounted, read-only.
- **The run has a trusted clone.** It lives at `$KTCHN_HOME/runs/<runId>/repo`, is bare, and is written only by ktchn. There is no worktree for anything to be checked out into. Every host git call goes through `src/git.ts`, which drops inherited `GIT_*` variables.
- **A round ends by collecting.** The agent's session and container are closed first, so nothing the agent left running there can change the copy while it is read. A filter driver the copy names can still start a process during collect's `status` (see `SAFE_GIT` below). A fresh collect sandbox is opened over the run's volume, with no pi-env and no network. Inside it ktchn reads the run branch's commit id, `git status --porcelain -z`, and a pack of the commits the clone lacks. The pack leaves on the standard output of `docker exec`, so no file path inside the sandbox reaches the host. Then `git index-pack --stdin --strict` parses it in the clone, `git rev-list --objects --quiet <oid> --not --all` proves the commit is complete, and only then does ktchn move the run branch, compare-and-set, with `update-ref`. The collect sandbox is destroyed and the volume kept.
- **Review reads objects only.** The protected-path and new-commit checks use `rev-list` and `diff-tree` on the clone. Uncommitted work comes from the status the sandbox reported. Checks run in a fresh sandbox seeded from the reviewed commit, with no volume, no pi-env and no secrets.
- **Handoff** is a pack and a compare-and-set into the project as `refs/heads/ktchn/<runId>`. After it the run's containers and volume are removed, since the owner now has the commit. The run's branch is then pushed to the project's `origin` with the owner's hooks off, and `gh` opens its PR or finds the one already open. The trusted clone stays until the PR is open and the run is done. Every step is safe to repeat when a run resumes at `opening_pr`, and the orphan sweep leaves such a run alone because its directory remains.
- **One sandbox per round**, named `ktchn-<runId>-r<round>`. Collect's sandbox is `ktchn-<runId>-collect` and review's is `ktchn-<runId>-review`. Every container is labelled `ktchn.run=<runId>`. pi-durable stays on the host and runs tools through pi-env over `docker exec`, as in ADR 0012. A resume or a sweep removes every container with the run's label, so a killed driver leaves nothing running on the run's volume.

## Recovery

The sandbox's copy of the project is kept in a docker named volume per run, `ktchn-<runId>`, not the container's own filesystem. The volume lives inside Docker's VM and its mountpoint does not exist on the host, so the invariant holds. It outlives each round's container. A seed marker in the sandbox's copy (`.git/ktchn-seeded`) makes seeding restartable and skipped on later rounds.

Compared with losing uncommitted work, or snapshotting the tree after every tool call, the volume loses nothing when a container dies, ktchn is killed, or the machine reboots, and only a Docker disk reset loses it. That was measured by hand while making this decision for a driver killed with SIGKILL and its container removed, and reasoned for a docker restart or a reboot. The notes were not committed. It is faster, since later rounds skip the seed and the install, and it needs no hook on tool calls. Commits made after the last collect are not lost either, because the next collect packs everything the clone lacks. On `Crashed` (ADR 0008) the run resumes in the same copy. The tradeoff is that a running process dies with its container, and a run whose volume is lost starts again from the clone's branch.

An agent that deletes `.git` or the marker gets its copy reseeded from the clone by the next sandbox opened, collect's included. That discards its uncommitted work and any commit not yet collected, and keeps the run going. A reseed that fails, for example on a directory the agent made undeletable, crashes the run rather than giving a finding ([#23](https://github.com/gregogun/ktchn/issues/23)). An agent that damages `.git` and leaves the marker gets a review finding that the work could not be collected, and the next round can repair it. Collect tells the two kinds of failure apart. A command stopped by its bound, a git failure inside a sandbox that still runs `true`, an answer that is not a commit id, a pack git refuses, or a commit that does not descend from the base is `CollectRefused` and becomes the finding. Anything else, such as docker not answering, the host's disk filling, or host git failing, crashes the run so it resumes, and costs the agent no round. Three host faults still land on the agent's side and cost a round: the host failing to write the pack, docker hanging until a command's bound, and the host's disk filling during `index-pack` ([#23](https://github.com/gregogun/ktchn/issues/23)). Neither can reach the host.

## Cost

Measured by hand on a 178-commit project with an 800 MB `node_modules`, three samples each, one side after the other. The scripts and raw output stayed in the working notes of this decision and are not in the repository.

|                                                   | per round    |
| ------------------------------------------------- | ------------ |
| no-mount sandbox, pnpm store baked into the image | about 7.5 s  |
| no-mount sandbox, cold network install            | about 14.5 s |
| ADR 0014's bind-mounted flow                      | about 160 s  |

Install dominates. File count over the Docker Desktop share dominates the bind flow, with install 5x slower, close 11 s and a commit that picks up a 670 MB `.pnpm-store`. The overhead this sandbox adds beyond today's flow is negative, so the decision does not depend on tuning. A read-only mounted pnpm store failed in an earlier image that had pnpm 11, which needs to write its index in the store. The image now pins pnpm 10.5.2 because the first project tested on it pins that version in `packageManager`. Neither is a general answer. The real one is an image per project, built from its lockfile with its own pnpm and store in a layer. A volume makes install about 2.3 s.

## Sandcastle

Sandcastle is removed. What ktchn used of it was creating a container and running a command in it, which `src/sandbox.ts` now does directly with `docker`. ADR 0002 and ADR 0012 name Sandcastle as the sandbox provider. That is amended for the provider only. The skill catalogue stays outside, and everything else in them stands.

Three versions were checked for whether staying would be safer than leaving: 0.12.0, 0.14.0 and 1.0.0-v1-next.20261105145541. The same reasons hold for all three.

- All three wipe the sandbox's copy on an isolated open, which would erase a volume's contents.
- Their docker provider is bind-mount only, the flow this decision removes.
- Their exec buffers all output in memory with no per-command timeout, so a command that prints without end or never returns cannot be stopped.
- None manage volumes, so the volume's creation, label and removal would stay ktchn's own.
- 0.14 added only `capDrop` over 0.12, which is one flag ktchn passes itself.

## The containers

Each round's sandbox is a container with a collect and a review variant, run by `containerArgs` in `src/sandbox.ts`:

- The agent's container has the volume and the pi-env directory. The collect container has the volume and no pi-env, and exists only to read the round's data out. The review container has neither a volume nor pi-env, and holds one commit.
- Every container drops all capabilities, sets `no-new-privileges`, and has a limit on processes (`--pids-limit 512`) and on memory (`--memory 2g`, with `--memory-swap` the same so no swap is added). The `chown` helper that prepares a new volume has the same limits and adds back only `CHOWN`.
- Every command through `exec` has a timeout and a cap on output. The default is 10 minutes and 1 MiB, and a caller may pass its own. A command that outruns either is killed: the `docker exec` client is sent SIGKILL, and the command's own process group in the container is killed too, because killing the client leaves its command running. Each command runs under `setsid` as the leader of a new group, so the kill reaches its children and nothing else, not the pi-env daemon or another command. Collect treats a stopped command as a failed round with a finding for the agent, not a crash, so a resume cannot loop on it. The status and check text that goes back to the agent is capped.
- The group to kill is read from a pid file in the container's `/tmp`, which the command itself, running as uid 1000, can rewrite. What remains is that a command can make its own kill miss or hit another uid 1000 process in the same container. Every such process is already the agent's to kill, the result still returns when the bound trips, and the container is removed when the round, collect or review ends. The agent's own processes are gone by collect, since its container is closed first, but a filter driver run by collect's `status` can leave one behind.
- Host `git` calls are killed after 10 minutes, room for `index-pack` of a pack at the cap on a slow disk, and `docker` calls after 5 minutes, so a hostile pack or a wedged daemon fails the run instead of hanging ktchn.
- Every branch and ref name passes one check (`checkRefName` in `src/git.ts`) before any git call or sandbox script sees it: no character that needs shell quoting, no leading `-`, nothing `git check-ref-format --allow-onelevel` refuses except `HEAD`. Refs go after `--end-of-options`, or before `--` for `checkout`.
- A pack is capped in two places: the host stops reading the stream at 256 MiB, and `index-pack --max-input-size` refuses one that claims more.
- A collected commit must descend from the commit the run started from (`merge-base --is-ancestor <base> <oid>`), so an agent cannot hand back an unrelated history. A new run's base is the tip of the default branch on `origin`, fetched when the run first starts, never the owner's checkout, so commits the owner has not pushed stay out of the run's branch and its PR. The branch is recorded with the base and the PR opens against it.
- A volume is made after its run's directory and removed again if the sandbox fails to open. Each start also removes volumes by their `ktchn.run` label, of its own home (`ktchn.home`), whose run has no directory, so a crash between the two leaks nothing. A volume with no `ktchn.home` label cannot be told from another home's, so the sweep reports it and never removes it.
- Git run in the sandbox on what the agent wrote is `SAFE_GIT`: no fsmonitor, no hooks, no pager, no external diff, no global attributes file, no lock taking. A filter driver named in the copy's own `.gitattributes` or `.git/info/attributes` and defined in its config still runs when status reads a file. It runs inside the sandbox as the agent's user, bounded like any command, so it can do nothing the agent could not already do there. Closing it would mean clearing every `filter.<name>` the config could name, which `-c` cannot do by pattern.

## The agent's own commands

The agent's bash tool runs through pi-env, not `exec`, so it gets its own bounds in `src/agent-env.ts`. A command has a 10 minute timeout unless the agent asks for another, up to a ceiling of 30 minutes. A request above the ceiling runs at the ceiling, and the agent is told so after the command. Output is capped at 1 MiB across the whole command, and a command that passes it is cancelled. pi-durable's options to keep only a window of the output and spill the rest to a file are removed, so every byte is counted and nothing is written to a spill file. The cost is that on long output the model sees only the tail pi-durable keeps (about 50 KB), not the head. A spill file was the alternative, and a measured run filled one to 554 MB before the cap. The limits are named constants, `AGENT_LIMITS`.

## The network is a Policy

The network is a setting of the job's Policy. The agent's sandbox has no network (`--network none`) unless the job is started with `--network`, which is recorded in the job and so in the run's id, and a resumed run keeps it. Review's sandbox never has a network, whatever the job says. A job that needs dependencies gets them from the image: build an image `FROM ktchn-sandbox` with the project's pnpm store in a layer, and `pnpm install --offline` works with no network (docs/sandbox-image.md). This closes the open network that ADR 0012 left. A job that asks for the network has it.

## The in-box script guard

ktchn sends scripts into the sandbox that delete files, to clear the sandbox's copy before a seed. An earlier version of this work ran such a script on the host by mistake and deleted a project. Now every path in these scripts is absolute, and the delete runs only after the script proves that its directory is `/home/agent/copy` (`pwd -P`) and that `/etc/ktchn-sandbox` exists. Only the image built from `docker/sandbox/Dockerfile` has that file. Anywhere else the script exits 97 and deletes nothing. The vitest run has a tripwire (`vitest.global-setup.ts`) that fails if a test moves HEAD, adds or removes a tracked file, changes a tracked file's contents, or changes `git status`.

## Host git environment

Every host git call drops inherited `GIT_*` variables. Calls on the trusted clone and on scratch directories also set `GIT_CONFIG_NOSYSTEM=1` and `GIT_CONFIG_GLOBAL=/dev/null`, so only the clone's own config decides what git does. Calls on the owner's project keep the owner's system and user configuration, since the identity for the agent's commits comes from it, and the project is the owner's own code on the owner's own machine.

## Deleted

The `.git` preflight, the worktree layout check, `cloneGit` and its lockdown, the `WreckedClone` path and the parking it caused, `cloneWorktree`, host `status` on agent folders, the removal that copes with directories the agent made unreadable, the `.sandcastle` protection and `.env` finding, and the branch-strategy wiring.

## Considered options

- **Keep the bind mount and harden the host's reads again.** Rejected. It failed five reviews, and each fix left the premise.
- **Keep Sandcastle and its isolated provider.** Rejected, see above.
- **Snapshot the tree after tool calls.** Rejected for recovery. Slower on every round, loses ignored files, more code.

## Consequences

- A job that asks for the network has it, in the agent's sandbox only. Whatever is in the image or fetched there is the agent's to use.
- A resumed run needs docker's volume to exist. A volume lost with a Docker disk reset costs the work since the last collect.
- Anything new that reads what an agent wrote must take it as a pack, or not read it.
- Old runs begun under ADR 0014 have no volume and are not migrated.
- Nothing limits disk inside the sandbox. An agent can fill the volume with one large file.
- Some host faults are still classed as the agent's and cost it a round (see Recovery and [#23](https://github.com/gregogun/ktchn/issues/23)). Git's exit from `index-pack` does not tell a full disk from a bad pack.
- The run id is a hash of the job, so starting an identical job again resumes the old run rather than starting a new one. Now that a run ends at done, starting the same job again reports it as done with its PR. A fresh run needs a different job.
