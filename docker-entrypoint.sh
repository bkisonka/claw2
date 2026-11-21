#!/bin/sh
# Start as root only to fix bind-mount ownership, then drop to `node`.
#
# Docker auto-creates missing bind-mount sources on the host (e.g. ./data on
# the first `docker compose up`) as root-owned directories; a non-root
# process inside the container then cannot write there, and the gateway dies
# with "SqliteError: unable to open database file" on the first message.
# The compose file starts the gateway as root precisely so this script can
# chown the writable mounts to uid 1000 and exec the gateway as `node` —
# application code never runs as root. Sibling skill containers run the same
# image under the image's USER (node), so their entrypoint run skips the
# root branch and simply execs the command.

set -e

if [ "$(id -u)" = "0" ]; then
  for d in /app/data /app/.claw2 /app/agents; do
    if [ -d "$d" ]; then
      chown -R node:node "$d" 2>/dev/null || true
    fi
  done
  # gosu changes uid/gid but not the environment: give the node process its
  # home directory (the embedding model cache lives in ~/.claw2).
  export HOME=/home/node
  exec gosu node "$@"
fi

exec "$@"
