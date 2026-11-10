#!/bin/sh
# Builds the image for runs on ktchn itself: ktchn-ktchn:latest, from
# ktchn-sandbox:latest plus the pnpm store for the current lockfile.
# The tag comes from the first argument; a run picks the image with KTCHN_IMAGE.
set -eu
here=$(cd "$(dirname "$0")/.." && pwd)
context=$(mktemp -d)
trap 'rm -rf "$context"' EXIT
cp "$here/docker/ktchn/Dockerfile" "$here/package.json" "$here/pnpm-lock.yaml" "$context"
docker build -t "${1:-ktchn-ktchn:latest}" "$context"
