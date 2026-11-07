# The host's refs are guarded by detect-and-restore, not read-only mounts

Status: superseded by [ADR 0014](0014-a-private-clone-per-run.md). Detect-and-restore kept failing review, so the agent now works in a private clone and never touches the owner's refs. Kept for the record.

ADR 0012 left the host's refs open to the sandbox. Sandcastle mounts only a repo's config, hooks and info read-only, so `.git/refs` and `packed-refs` stay writable from inside, and the agent can move `main` by writing a file. The bash-regex guard on tool calls is a second line, not a fence: a script, an editor tool or `echo > .git/refs/heads/main` goes round it.

Making `refs` read-only would close this, but the agent has to commit to its own branch, and a commit moves `refs/heads/ktchn/<runId>` in that same directory. The shared refs directory can't be both writable for one branch and read-only for the rest.

So ktchn closes it on the host. Before each agent turn it snapshots `git for-each-ref` in the host repo, plus the host `HEAD` (its symref target or detached oid). After the turn, any ref other than `refs/heads/ktchn/<runId>` that changed, appeared or vanished is put back, and a finding goes to review for the agent. Using git rather than files covers loose and packed refs alike. `refMoveBlock` stays as an early refusal that tells the agent why.

Each ref is restored on its own. The restore is a compare-and-set, `git update-ref <name> <old> <current>`, and a created ref is deleted with its current value as the expected one, so a ref someone else moved after the turn was inspected is left alone. A ref that cannot be put back, or that git cannot read at all (the agent wrote garbage into it), is a finding and never an error that ends the turn. A ref git cannot read is cleared first, since no owner wrote it. A moved `HEAD` is put back the same way, with `git symbolic-ref` or `git update-ref --no-deref`.

Review never asks git where the run started. The commit the run started from is recorded in the ledger with `run_started`, a resume keeps the first one, and review diffs from it. The branch is resolved to one oid after the agent's container is stopped, and the host checks and the review clone both use that oid, so neither a moved `HEAD` nor a branch moving mid-review changes what is judged.

## Consequences

- A ref is wrong on the host only for the length of one turn, and an owner who commits to the host repo while a turn runs has that change reverted. Compare-and-set protects only a move made after the turn was inspected; a move during the turn looks the same as the agent's. Runs against a repo the owner is working in are not safe until runs get their own clone.
- Findings from a turn are held in memory until review. A crash between the turn and review restores the refs but loses the finding.
- Network access is still open (ADR 0012).
