#!/bin/sh
# Builds the sandbox image ktchn runs by default: ktchn-sandbox:latest.
# Set KTCHN_IMAGE to the tag you build when you use another name.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
exec docker build -t "${1:-ktchn-sandbox:latest}" "$here/../docker/sandbox"
