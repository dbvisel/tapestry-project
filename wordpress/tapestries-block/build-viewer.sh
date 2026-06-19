#!/usr/bin/env bash
#
# Rebuilds the Tapestry viewer with a relative asset base and copies the output into this plugin's
# ./viewer directory, so the plugin ships a self-contained copy of the viewer.
#
# Run from anywhere; paths are resolved relative to this script.
set -euo pipefail

PLUGIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$PLUGIN_DIR/../.." && pwd)"
VIEWER_DIR="$REPO_ROOT/viewer"
DEST="$PLUGIN_DIR/viewer"

echo "Building viewer (relative base) ..."
# --base=./ makes index.html reference assets relatively (./assets/...), required for serving from a
# plugin sub-directory. We run vite directly (skipping the tsc -b type-check in `npm run build`) to keep
# this packaging step independent of type errors elsewhere in the monorepo.
( cd "$VIEWER_DIR" && npx vite build --base=./ )

echo "Copying build output into plugin ..."
rm -rf "$DEST"
mkdir -p "$DEST"
cp -R "$VIEWER_DIR/dist/." "$DEST/"

echo "Done. Bundled viewer is at: $DEST"
