# The image every ktchn sandbox runs (ADR 0015). Build it with
# scripts/build-sandbox-image.sh. It holds git, node and pnpm and nothing of
# the owner's: no credentials, no project files.
FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g pnpm@10.5.2

# The sandbox's user is 1000:1000, whatever the base image calls it.
RUN usermod -l agent -d /home/agent -m node \
 && groupmod -n agent node \
 && mkdir -p /home/agent/copy \
 && chown 1000:1000 /home/agent /home/agent/copy

# ktchn's own scripts refuse to delete anything unless this file exists, so a
# script that reaches a machine that is not a sandbox does nothing.
RUN echo "ktchn sandbox image" > /etc/ktchn-sandbox

# To run checks with the network off, put the project's pnpm store in a layer
# of an image built FROM this one (docs/sandbox-image.md).
USER 1000:1000
WORKDIR /home/agent
