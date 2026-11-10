# Crash and restart

If the process carrying out a run dies, starting the same job again carries on from the same sandbox volume, so work the agent had not yet committed survives. While a run is alive, a second start for it is refused.

## Sub-features

- `crash-lease` refuses a second driver of a live run.
- `crash-carry-on` records `Crashed` after a SIGKILL and carries on with a new agent session on the same volume.
- `crash-work-kept` keeps uncommitted files that were in the sandbox before the kill.

## How to get to it (user POV)

- Start a job, kill the process, and run the identical `node src/start.ts` command again.
- Run the identical command in a second terminal while the first is alive.

## Driving it with verify-ktchn

Preconditions:

- The baseline in [README.md](./README.md), with a model key.

Set the shared job first:

```sh
JOB='Use the bash tool for each step, one tool call per step: 1. touch started.txt  2. sleep 25  3. echo crashed-and-resumed > done.txt  4. rm started.txt  5. git add -A && git commit -qm done. Then stop.'
```

- **Start in the background.** Run `$V start "$ID" crash-first --background -- "$JOB" --check 'test -f done.txt'`, then `N=$($V wait-file "$ID" /home/agent/copy/started.txt 180)`. `$N` is `ktchn-<id>-r1`.
- **Plant work the agent does not know about.** Run `docker exec "$N" sh -c 'echo from-before-the-kill > /home/agent/copy/planted.txt'`. Exit code is `0`.
- **Refuse a second driver.** Run `$V start "$ID" crash-second -- "$JOB" --check 'test -f done.txt'`. Exit code is `1` and stderr is `run <id> is already being carried out by pid <pid>`.
- **Kill it.** Run `$V kill "$ID" crash-first`, then `$V wait "$ID" crash-first 60`. Exit code is `137`, and `crash-first/docker.txt` still lists the volume `ktchn-<id>`.
- **Start again.** Run `$V start "$ID" crash-resume -- "$JOB" --check 'test -f done.txt'`. Exit code is `0` and stdout starts with `run <id> resumed`. The ledger shows `Dequeued > Crashed > Dequeued > AgentFinished > ReviewPassed > PrOpened`.
- **Work carried over.** The net change in `crash-resume/handoff-<id>.patch` adds both `done.txt` and `planted.txt`. Only the kept volume can explain `planted.txt`, because the job never mentions it. `docker.txt` lists nothing left.

## Gotchas

- Kill only after `wait-file` returns. Killing earlier tests the startup path, not a crash mid-round.
- The killed process leaves its sandbox running. That is expected: the next start removes it. `crash-first/docker.txt` shows it still `Up`.
- A second crash in the same run parks it with `second_crash`. This has not been driven, and needs another kill after the first restart.
- Model calls are written to the ledger when the agent finishes, so calls made before the kill are not recorded. The reported cost understates what a crashed run spent.
- `run <id> resumed` is the CLI's wording. In the glossary, resume means carrying on a parked run once the owner has answered, which is not what happens here.
