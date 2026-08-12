#!/usr/bin/env bash
#
# Builds a minimal, self-contained macOS app: "Tapestry Viewer.app". Drag an exported Tapestry .zip onto
# it, and it opens that tapestry in your browser using the bundled /viewer app (the same standalone viewer
# the WordPress plugin embeds).
#
# The CFBundleExecutable is a tiny compiled Swift/AppKit shim (main.swift), not a bare shell script. A bare
# script executable never registers with the Window Server, so while it launches fine, it has no way to
# receive the `application(_:open:)` Apple Event macOS sends for a file dropped on the app or its Dock icon
# - that's a fundamentally different delivery mechanism from passing argv, which only really applies to
# genuine command-line invocation (e.g. `open -a`). The Swift shim's only job is to receive that event and
# hand the file path to open-tapestry.sh, a plain shell script (in Resources, not the bundle executable)
# that does the actual work. Since the viewer is a Vite app using ES module <script> tags, it can't be
# opened directly via a file:// URL - browsers block module loading under file:// as a CORS restriction -
# so that script serves the bundled viewer (plus the dropped zip) over a tiny local HTTP server and opens
# that URL instead.
#
# Run from anywhere; paths are resolved relative to this script.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
VIEWER_DIR="$REPO_ROOT/viewer"
OUT_DIR="$SCRIPT_DIR/dist"
APP="$OUT_DIR/Tapestry Viewer.app"

echo "Building viewer (relative base) ..."
# --base=./ makes index.html reference assets relatively (./assets/...), required for serving from
# wherever the app bundle happens to be. Skips the tsc -b type-check, matching the WordPress plugin's
# build-viewer.sh - this is a packaging step, independent of type errors elsewhere in the monorepo.
(cd "$VIEWER_DIR" && npx vite build --base=./)

echo "Building app icon ..."
# icon-source.svg is a 1024x1024 composition of the real Tapestry logo mark (core-client's logo.svg) on
# its actual brand background color (secondary.400, #f9703e - the same color the logo sits on in the web
# app's own title bar), rounded to approximate macOS's icon corner convention.
ICONSET_DIR="$SCRIPT_DIR/AppIcon.iconset"
rm -rf "$ICONSET_DIR"
mkdir -p "$ICONSET_DIR"
MASTER_PNG="$ICONSET_DIR/master-1024.png"
rsvg-convert -w 1024 -h 1024 "$SCRIPT_DIR/icon-source.svg" -o "$MASTER_PNG"
for spec in "16:icon_16x16.png" "32:icon_16x16@2x.png" "32:icon_32x32.png" "64:icon_32x32@2x.png" \
	"128:icon_128x128.png" "256:icon_128x128@2x.png" "256:icon_256x256.png" "512:icon_256x256@2x.png" \
	"512:icon_512x512.png" "1024:icon_512x512@2x.png"; do
	size="${spec%%:*}"
	name="${spec##*:}"
	sips -z "$size" "$size" "$MASTER_PNG" --out "$ICONSET_DIR/$name" >/dev/null
done
rm "$MASTER_PNG"

echo "Assembling app bundle ..."
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/viewer"
cp -R "$VIEWER_DIR/dist/." "$APP/Contents/Resources/viewer/"
iconutil -c icns "$ICONSET_DIR" -o "$APP/Contents/Resources/AppIcon.icns"
rm -rf "$ICONSET_DIR"

cat >"$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleName</key>
	<string>Tapestry Viewer</string>
	<key>CFBundleDisplayName</key>
	<string>Tapestry Viewer</string>
	<key>CFBundleIdentifier</key>
	<string>org.archive.tapestry.viewer</string>
	<key>CFBundleIconFile</key>
	<string>AppIcon</string>
	<key>CFBundleVersion</key>
	<string>1.0</string>
	<key>CFBundleShortVersionString</key>
	<string>1.0</string>
	<key>CFBundlePackageType</key>
	<string>APPL</string>
	<key>CFBundleExecutable</key>
	<string>TapestryViewer</string>
	<key>CFBundleInfoDictionaryVersion</key>
	<string>6.0</string>
	<key>LSMinimumSystemVersion</key>
	<string>11.0</string>
	<key>NSHighResolutionCapable</key>
	<true/>
	<key>CFBundleDocumentTypes</key>
	<array>
		<dict>
			<key>CFBundleTypeName</key>
			<string>Tapestry Export</string>
			<key>CFBundleTypeRole</key>
			<string>Viewer</string>
			<key>LSHandlerRank</key>
			<string>Alternate</string>
			<key>LSItemContentTypes</key>
			<array>
				<string>public.zip-archive</string>
			</array>
		</dict>
	</array>
</dict>
</plist>
PLIST

cat >"$APP/Contents/Resources/open-tapestry.sh" <<'LAUNCHER'
#!/bin/bash
# Does the actual work for Tapestry Viewer.app. Invoked by the compiled Swift shim (see main.swift) with
# either no arguments (plain launch, no file involved) or the path of a dropped/opened file as $1.
set -euo pipefail

APP_RESOURCES="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VIEWER_SRC="$APP_RESOURCES/viewer"

SUPPORT_DIR="$HOME/Library/Application Support/Tapestry Viewer"
SERVE_DIR="$SUPPORT_DIR/serve"
LOGFILE="$SUPPORT_DIR/server.log"
PORT=47845

mkdir -p "$SERVE_DIR"

DROPPED="${1:-}"
if [ -z "$DROPPED" ]; then
	osascript -e 'display alert "Tapestry Viewer" message "Drag an exported Tapestry .zip file onto this app (or its Dock icon) to open it." as informational' >/dev/null
	exit 0
fi

# Keep the served copy of the viewer in sync with whatever shipped in this app bundle.
rsync -a --delete "$VIEWER_SRC/" "$SERVE_DIR/" 2>/dev/null || { rm -rf "${SERVE_DIR:?}"/*; cp -R "$VIEWER_SRC/." "$SERVE_DIR/"; }

cp "$DROPPED" "$SERVE_DIR/dropped.zip"

# Stop whatever's currently listening on our port (a previous instance of this same server), identified by
# asking the OS directly rather than trusting a PID captured via `$!` - which is unreliable across a
# backgrounded compound command (`cd ... && nohup ... &`), since `$!` there can end up naming the wrapping
# subshell rather than the actual server process.
OLD_PID="$(lsof -ti :"$PORT" -sTCP:LISTEN 2>/dev/null || true)"
if [ -n "$OLD_PID" ]; then
	kill "$OLD_PID" 2>/dev/null || true
	sleep 0.2
fi

cd "$SERVE_DIR"
nohup python3 -m http.server "$PORT" >"$LOGFILE" 2>&1 &
disown
cd - >/dev/null

# Wait briefly for the server to actually come up before opening the browser.
for _ in $(seq 1 30); do
	curl -s -o /dev/null "http://localhost:$PORT/index.html" && break
	sleep 0.15
done

open "http://localhost:$PORT/index.html?source=dropped.zip"

# Auto-shut-down after 30 minutes, but only if no newer drop has since replaced this server (checked by
# re-asking the OS who's on the port right before killing, rather than trusting a PID captured earlier).
NEW_PID="$(lsof -ti :"$PORT" -sTCP:LISTEN 2>/dev/null || true)"
if [ -n "$NEW_PID" ]; then
	(sleep 1800
	CURRENT_PID="$(lsof -ti :"$PORT" -sTCP:LISTEN 2>/dev/null || true)"
	[ "$CURRENT_PID" = "$NEW_PID" ] && kill "$NEW_PID" 2>/dev/null
	true) &
	disown
fi
LAUNCHER
chmod +x "$APP/Contents/Resources/open-tapestry.sh"

echo "Compiling app shim (Swift/AppKit) ..."
# This is the only compiled piece: a small AppKit delegate whose sole job is to receive the
# `application(_:open:)` callback macOS uses to deliver a dropped/opened file, and hand its path to
# open-tapestry.sh. Everything else about "what to do with the file" lives in that plain shell script.
swiftc -O "$SCRIPT_DIR/main.swift" -o "$APP/Contents/MacOS/TapestryViewer"

echo "Ad-hoc code-signing (so macOS treats it as a normal local app) ..."
codesign --force --deep --sign - "$APP"

echo "Done. App is at: $APP"
