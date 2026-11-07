# The sandbox image

Every ktchn sandbox runs from one image, `ktchn-sandbox:latest` by default. It is defined in `docker/sandbox/Dockerfile` and holds git, node, pnpm and `/etc/ktchn-sandbox`, the file ktchn's in-box scripts require before they delete anything (ADR 0015). It holds no credentials and nothing of the owner's project.

Build it once, and again when the Dockerfile changes:

```sh
scripts/build-sandbox-image.sh            # builds ktchn-sandbox:latest
scripts/build-sandbox-image.sh my-tag     # or another tag, then set KTCHN_IMAGE=my-tag
```

`KTCHN_IMAGE` names the image `src/start.ts` uses. An image of your own must keep `/etc/ktchn-sandbox`, a user with id 1000, `git` and `sh`.

## Installing with the network off

A job's Policy gives the agent's sandbox no network unless it is started with `--network`, and review's sandbox never has one. A project whose checks need dependencies gets them from the image. Build an image per lockfile `FROM ktchn-sandbox`, with the store in a layer:

```dockerfile
FROM ktchn-sandbox:latest
COPY --chown=1000:1000 pnpm-lock.yaml package.json /tmp/deps/
RUN cd /tmp/deps && pnpm fetch --store-dir /home/agent/.pnpm-store
```

Then `pnpm install --offline --store-dir /home/agent/.pnpm-store` works inside the sandbox with no network, and run with `KTCHN_IMAGE` set to that image. The store is a layer, not a mount: a read-only mounted store failed because pnpm writes to its index.
