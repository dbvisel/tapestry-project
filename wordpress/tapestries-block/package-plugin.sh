#!/usr/bin/env bash
#
# Builds the bundled viewer and packages the plugin into an upload-ready ZIP.
#
# The archive contains a single top-level `tapestries-block/` directory, which is what WordPress expects
# from "Plugins -> Add New -> Upload Plugin". Output: wordpress/dist/tapestries-block.zip
#
# Usage:
#   ./package-plugin.sh                 # build viewer + package
#   ./package-plugin.sh --skip-build    # package only (reuse existing viewer/)
set -euo pipefail

PLUGIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_NAME="$(basename "$PLUGIN_DIR")"
PARENT_DIR="$(cd "$PLUGIN_DIR/.." && pwd)"
OUT_DIR="$PARENT_DIR/dist"
OUT_ZIP="$OUT_DIR/${PLUGIN_NAME}.zip"

SKIP_BUILD=0
[ "${1:-}" = "--skip-build" ] && SKIP_BUILD=1

if [ "$SKIP_BUILD" -eq 0 ]; then
	"$PLUGIN_DIR/build-viewer.sh"
fi

if [ ! -f "$PLUGIN_DIR/viewer/index.html" ]; then
	echo "ERROR: viewer/index.html is missing. Run without --skip-build first." >&2
	exit 1
fi

echo "Packaging $PLUGIN_NAME ..."
mkdir -p "$OUT_DIR"
rm -f "$OUT_ZIP"

# Zip from the parent so the archive root is the plugin folder. Exclude OS junk, the packaging script
# itself, and any stray archives.
( cd "$PARENT_DIR" && zip -r -q -X "$OUT_ZIP" "$PLUGIN_NAME" \
	-x "$PLUGIN_NAME/package-plugin.sh" \
	-x "$PLUGIN_NAME/*.zip" \
	-x "*/.DS_Store" \
	-x "*/__MACOSX/*" )

echo "Packaged: $OUT_ZIP"
ls -lh "$OUT_ZIP" | awk '{print $5, $9}'
