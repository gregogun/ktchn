# Each run works in a private clone of the project

Status: superseded by [ADR 0015](0015-sealed-sandbox-and-trusted-clone.md). The clone was mounted into the sandbox, so the host read files the agent wrote. Kept for the record.

ADR 0013 tried to keep the owner's refs safe by detecting what the agent did to them and putting them back. Three reviews in a row found another way to defeat the restore: symrefs followed without `--no-deref` rewound or deleted `main`, a ref turned into a directory lost `main`, garbage in `packed-refs` or `HEAD` made the snapshot throw, and a move the owner made during a turn was reverted along with the agent's. Each fix assumed what all of them assumed, that the agent works inside the owner's own `.git`. That assumption was the bug.

So the agent no longer works there. At the start of a run ktchn makes a private clone of the owner's project at `$KTCHN_HOME/runs/<runId>/repo`, with `git clone --no-hardlinks`, checked out at the base the ledger recorded, and with `origin` removed so it can reach nothing of the owner's. The sandbox, the agent, the host's review and review's own sandbox all work from that clone. The project itself is never mounted or handed to the sandbox. Making the clone is idempotent: a run that finds its clone already there reuses it, so a resumed run carries on with the same files. A clone is built beside its final place and renamed into it, so a crash while cloning leaves no clone that looks complete.

Moving refs in the clone cannot harm the owner, and review judges only the run's branch, so the host ref snapshot, the `HEAD` watch and the `refMoveBlock` guard on tool calls are gone.

The owner gets one thing from a run: after review passes, ktchn brings exactly the reviewed commit from the clone into the project as `refs/heads/ktchn/<runId>`. The commit travels as a pack that git packs in the clone and the project's git unpacks and checks object by object (see "The clone is hostile"), and the clone never pushes. The ref is created only if it is absent, with `git update-ref <ref> <oid> <zero>`. If it already points at that commit, nothing happens; if it points anywhere else, ktchn refuses with an error and leaves it. Nothing else in the project changes. `ReviewPassed` carries the reviewed commit, and the `OpenPr` effect carries it on, so after a crash a resumed run hands off the commit review judged, and doing it twice is the same as doing it once. No other ledger record is needed.

## The clone is hostile

In branch mode Sandcastle mounts the clone's `.git` writable at its host path. Only `config`, `hooks`, `info`, the worktree's `.git` file and its `commondir` are read-only. So once a sandbox has been opened on a clone, everything under that clone's `.git` is the agent's to write, and the clone's isolation from the project does not make it safe for the host to read. An agent can write `.git/commondir` and a config with a promisor remote whose `uploadpack` is a command, then the next host `git` in the clone runs that command. A commit built on `objects/info/alternates` can also pull in files from other places on the host.

Every host git process on a clone therefore goes through one function, `cloneGit` in `src/clone-git.ts`. It refuses a clone that has `commondir`, `shallow`, `config.worktree`, grafts or alternates, a `.git` whose parts are not plain files and directories, a config key beyond what `git clone` and ktchn write, or a repository format other than 0. It points git at the clone's own `.git` by absolute path, drops inherited `GIT_*` variables, ignores system and global configuration, switches off lazy fetch and replace refs, and locks the settings an agent could use to run a program or to lie about objects (fsmonitor, hooks, commit-graph, multi-pack-index, bitmaps, every protocol). A commit leaves the clone as a pack, never by `git fetch` or `git clone` from its path, which would run `upload-pack` inside the clone with the clone's own configuration. The project checks the pack with `git index-pack --strict` and a connectivity check. Review's sandbox is built the same way. Sandcastle runs its own host git when it opens a sandbox on a resumed clone, so `assertCloneUsable` runs first, before every open and every close, and a refusal parks the run (ADR 0008, `AgentEndedEarly`) instead of crashing it again. It also requires `.git/worktrees` to hold nothing but the one admin directory for the run's branch, a real directory whose `gitdir` is a regular file naming exactly `<clone>/.sandcastle/worktrees/<branch with "/" as "-">/.git`. `cloneWorktree` derives the worktree path from that layout and does not read it from the `gitdir` files.

`.sandcastle/**` is protected from the agent's changes, and review refuses any reviewed commit that carries `.sandcastle/.env` or a `.sandcastle` link, because Sandcastle fills empty keys in that file from the host's environment.

A run's directory is deleted when the run can no longer be resumed, which is when it reaches a terminal state in `run-machine.ts`: `done`, `failed` or `cancelled`. It is kept while the run is running, in review, parked, or waiting at `opening_pr`, since a later `start` can resume each of those. Before deleting, ktchn stops the agent's container and closes the sandbox, so nothing is writing into the directory, and removal copes with directories the agent made unreadable and does not follow links. Because a crash could land between reaching a terminal state and deleting, every `start` also removes the directories of runs whose ledger state is terminal. Each is removed under the run's lease, so a run that another process is still driving is skipped, and a run that cannot be removed is reported and does not stop `start`.

If a driver is killed, its agent's container keeps running on the clone. A resumed run finds containers by the clone's `.git` volume and removes them before it reads the clone or opens a new sandbox. A container whose run is never resumed is removed when its run reaches a terminal state and the sweep clears its directory.

## Considered options

- **Harden detect-and-restore again.** Rejected. It had failed review three times, and every failure came from the owner's `.git` being shared. A fix to one trick leaves the sharing.
- **Mount the owner's `.git` read-only.** Not possible: the agent commits to its branch in the same `refs` directory (ADR 0013).

## Consequences

- Supersedes ADR 0013. ADR 0012's statement that the sandbox shares the host's refs no longer holds.
- The owner can commit to the project while a run is going and nothing is reverted or touched.
- Each run costs a copy of the project's history on disk until it ends.
- The owner's project is read at the start, to clone and record the base, and written once, by the handoff.
- Network access is still open (ADR 0012). The agent could still push elsewhere by an address it knows. This decision does not close it.
- The writable `.git` is closed on the host side, not in the sandbox: it stays writable, and the host never trusts what is in it. Anything new that reads a clone must go through `cloneGit`.
- A clone the agent has wrecked parks its run, and the owner can fail it or repair it and resume.
- Old runs begun under ADR 0013 have no clone and are not migrated.
