# The host never reads what the agent wrote, except a pack that git checks

Status: supersedes [ADR 0014](0014-a-private-clone-per-run.md).

ADR 0014 gave each run a private clone and mounted it into the sandbox. Five reviews then found ways the host's git, reading files the agent had written under that clone's `.git`, could run a program: a `commondir`, a promisor remote with an `uploadpack` command, alternates, a wrecked `HEAD`, a worktree layout that sent Sandcastle's own git somewhere else. Each fix added a check on the clone (`cloneGit`, `assertCloneUsable`, the worktree layout check), and each check was another thing to get wrong. The premise was the bug again: a repository the agent can write is a repository the host reads.

## The invariant

No host process ever reads a file the agent wrote, except one pack file parsed by `git index-pack --strict`.

## How it holds

- **The sandbox is sealed.** It is a container with no mount of any repository. The host copies code in as a `git bundle` streamed through `docker exec -i`, and the sandbox runs `git init`, `fetch` and `checkout` itself. Only ktchn's own pi-env binary directory is mounted, read-only.
- **The run has a trusted clone.** It lives at `$KTCHN_HOME/runs/<runId>/repo`, is bare, and is written only by ktchn. There is no worktree for anything to be checked out into. Every host git call goes through `src/git.ts`, which drops inherited `GIT_*` variables.
- **A round ends by collecting.** Inside the sandbox ktchn reads the run branch's commit id, `git status --porcelain -z`, and a pack of the commits the clone lacks. The pack leaves on the standard output of `docker exec`, so no file path inside the sandbox reaches the host. Then `git index-pack --stdin --strict` parses it in the clone, `git rev-list --objects --quiet <oid> --not --all` proves the commit is complete, and only then does ktchn move the run branch, compare-and-set, with `update-ref`. The sandbox is destroyed.
- **Review reads objects only.** The protected-path and new-commit checks use `rev-list` and `diff-tree` on the clone. Uncommitted work comes from the status the sandbox reported. Checks run in a fresh sandbox seeded from the reviewed commit, with no volume, no pi-env and no secrets.
- **Handoff is unchanged.** A pack and a compare-and-set into the project as `refs/heads/ktchn/<runId>`.
- **One sandbox per round**, named `ktchn-<runId>-r<round>` and labelled `ktchn.run=<runId>`. pi-durable stays on the host and runs tools through pi-env over `docker exec`, as in ADR 0012. A resume or a sweep removes every container with the run's label, so a killed driver leaves nothing running on the run's volume.

## Recovery

A sandbox's workspace is a docker named volume per run, `ktchn-<runId>`, not the container's own filesystem. The volume lives inside Docker's VM and its mountpoint does not exist on the host, so the invariant holds. It outlives each round's container. A seed marker in the workspace (`.git/ktchn-seeded`) makes seeding restartable and skipped on later rounds.

Compared with losing uncommitted work, or snapshotting the tree after every tool call, the volume loses nothing when a container dies, ktchn is killed, or the machine reboots, and only a Docker disk reset loses it (measured and reasoned, `sealed-timings.md`). It is faster, since later rounds skip the seed and the install, and it needs no hook on tool calls. Commits made after the last collect are not lost either, because the next collect packs everything the clone lacks. On `Crashed` (ADR 0008) the run resumes in the same workspace. The tradeoff is that a running process dies with its container, and a run whose volume is lost starts again from the clone's branch.

An agent that deletes `.git` or the marker gets its workspace reseeded from the clone, which discards its uncommitted work and keeps the run going. An agent that damages `.git` and leaves the marker gets a review finding that the work could not be collected, and the next round can repair it. Neither can reach the host.

## Cost

Measured on a 178-commit project with an 800 MB `node_modules`, three samples each, one side after the other:

|                                             | per round    |
| ------------------------------------------- | ------------ |
| sealed box, pnpm store baked into the image | about 7.5 s  |
| sealed box, cold network install            | about 14.5 s |
| ADR 0014's bind-mounted flow                | about 160 s  |

Install dominates the sealed box. File count over the Docker Desktop share dominates the bind flow, with install 5x slower, close 11 s and a commit that picks up a 670 MB `.pnpm-store`. The overhead the sealed box adds beyond today's flow is negative, so the decision does not depend on tuning. A read-only mounted pnpm store failed (pnpm 11 needs to write its index), so the safe cache is an image layer per project, built once per lockfile. A volume makes install about 2.3 s.

## Sandcastle

Sandcastle is removed. Its isolated provider re-seeds with `rm -rf` and a clone on every open, which would erase a volume's workspace, and its branch mode is the bind mount this decision removes. What ktchn used of it was creating a container and running a command in it, which `src/sandbox.ts` now does directly with `docker`. ADR 0002 and ADR 0012 name Sandcastle as the sandbox provider. That is superseded for the provider only. The skill catalogue stays outside, and everything else in them stands.

## Deleted

The `.git` preflight, the worktree layout check, `cloneGit` and its lockdown, the `WreckedClone` path and the parking it caused, `cloneWorktree`, host `status` on agent folders, the removal that copes with directories the agent made unreadable, the `.sandcastle` protection and `.env` finding, and the branch-strategy wiring.

## Considered options

- **Keep the bind mount and harden the host's reads again.** Rejected. It failed five reviews, and each fix left the premise.
- **Keep Sandcastle and its isolated provider.** Rejected, see above.
- **Snapshot the tree after tool calls.** Rejected for recovery. Slower on every round, loses ignored files, more code.

## Consequences

- Network access is still open (ADR 0012). This does not close it.
- A resumed run needs docker's volume to exist. A volume lost with a Docker disk reset costs the work since the last collect.
- Anything new that reads what an agent wrote must take it as a pack, or not read it.
- Old runs begun under ADR 0014 have no volume and are not migrated.
