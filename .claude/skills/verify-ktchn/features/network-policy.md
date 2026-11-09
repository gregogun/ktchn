# Network policy

A job's policy decides whether the agent's sandbox has a network. It has none unless the job is started with `--network`, and review's sandbox never has one.

## Sub-features

- `net-default-off` gives the agent's sandbox no network by default.
- `net-on` gives it a network under `--network`.
- `net-review-off` keeps review's sandbox offline either way.

## How to get to it (user POV)

- Run `node src/start.ts <repo> <job text>` for no network.
- Run `node src/start.ts <repo> <job text> --network` to allow it.

## Driving it with verify-ktchn

Preconditions:

- The baseline in [README.md](./README.md), with a model key.

Set these first:

```sh
FETCH="node -e \"fetch('https://example.com',{signal:AbortSignal.timeout(8000)}).then(()=>process.exit(0),()=>process.exit(1))\""
JOB='Use the bash tool for each step, one tool call per step: 1. touch started.txt  2. sleep 12  3. rm started.txt  4. echo x > net.txt && git add net.txt && git commit -qm net. Then stop.'
```

- **Default is off.** Run `$V start "$ID" net-off --background -- "$JOB" --check "! $FETCH"`, then `N=$($V wait-file "$ID" /home/agent/copy/started.txt 180)`. `docker inspect --format '{{.HostConfig.NetworkMode}}' "$N"` prints `none`. `docker exec "$N" sh -c "$FETCH"` exits non-zero.
- **Review offline.** Run `$V wait "$ID" net-off 180`. Exit code is `0` and the ledger reaches `ReviewPassed`, so the `! $FETCH` check held in review's sandbox.
- **On when asked.** Run `$V start "$ID" net-on --background -- "$JOB" --network --check "! $FETCH"`, then `N=$($V wait-file "$ID" /home/agent/copy/started.txt 180)`. `docker inspect` prints `bridge`, and the same `docker exec` exits `0`.
- **Review still offline.** Run `$V wait "$ID" net-on 180`. Exit code is `0` and the ledger reaches `ReviewPassed` even though this job had the network.

## Gotchas

- `net-on` sends a request to `example.com` from the sandbox, and needs internet access on the host.
- Inspect while the marker file exists. The sandbox is gone once the round ends.
- `--network` is part of the run ID, so `net-off` and `net-on` are different runs with the same job text.
