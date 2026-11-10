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

## The image for runs on ktchn itself

`docker/ktchn/Dockerfile` is that pattern for this repo: `ktchn-sandbox:latest` plus the pnpm store for `pnpm-lock.yaml`. Build it after the base image, and again when the lockfile changes:

```sh
scripts/build-ktchn-image.sh              # builds ktchn-ktchn:latest
KTCHN_IMAGE=ktchn-ktchn:latest ...        # then start runs with it
```

The check to pass as `--check` installs from the store and runs formatting, lint, types, knip and the tests. `src/box-scripts.test.ts` is left out: it asserts `/etc/ktchn-sandbox` is absent, which is never true in a sandbox. The tests of `sandbox.ts`, `shell.ts` and `clone.ts` call no Docker, so they run:

```sh
pnpm install --offline --frozen-lockfile --store-dir /home/agent/.pnpm-store && pnpm check
```

An image older than the lockfile has no store for the new packages, so the offline install fails until the image is rebuilt.
