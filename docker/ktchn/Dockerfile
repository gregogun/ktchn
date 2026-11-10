# The image a run on ktchn itself uses: the sandbox image plus ktchn's pnpm
# store, so the checks install and run with the network off. Build it with
# scripts/build-ktchn-image.sh. It holds package.json and pnpm-lock.yaml only,
# no credentials and no other project files (ADR 0015).
FROM ktchn-sandbox:latest
COPY --chown=1000:1000 pnpm-lock.yaml package.json /tmp/deps/
RUN cd /tmp/deps && pnpm fetch --store-dir /home/agent/.pnpm-store \
 && rm -rf /tmp/deps
