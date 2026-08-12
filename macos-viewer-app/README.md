# Tapestry Viewer.app

A minimal macOS app: drag an exported Tapestry `.zip` onto it, and it opens that tapestry in your
default browser.

## How it works

There's no native (Swift/Obj-C) code. The app's "executable" is a shell script - macOS launches an
app bundle's `CFBundleExecutable` by exec-ing it directly, which respects a `#!/bin/bash` shebang
just fine. When you drop a file on the app (or its Dock icon), Finder invokes that script with the
file's path as `$1`.

The bundled `/viewer` app (the same standalone viewer the WordPress plugin embeds) is a Vite app
using ES module `<script>` tags, so it can't be opened directly via a `file://` URL - browsers block
module loading under `file://` as a CORS restriction. So the script instead:

1. Copies the bundled viewer + the dropped zip into `~/Library/Application Support/Tapestry Viewer/serve/`.
2. Starts a tiny local static server (`python3 -m http.server`) rooted there, replacing any previous
   instance still running on the same port.
3. Opens `http://localhost:47845/index.html?source=dropped.zip` with the `open` command - which hands
   off to whatever your actual default browser is, not an embedded webview.

The local server auto-shuts-down after 30 minutes of the last drop, so instances don't pile up.

## Working offline

The app itself needs no network at all. Whether a *tapestry* renders fully offline depends on what's
in it: media you uploaded directly into Tapestry is embedded in the export as real file bytes, so it
displays fine offline. Anything with a live external source - embedded webpages, YouTube/Vimeo,
SoundCloud/Spotify, Wikipedia articles, IIIF images - keeps that live URL in the export rather than
being downloaded, so those specific items need real internet access to render, regardless of the app
or zip being local. That's inherent to the content model, not something this launcher works around.

## Building

```bash
./build-app.sh
```

Rebuilds the bundled `/viewer` app fresh and re-assembles `dist/Tapestry Viewer.app`. Ad-hoc
code-signs it (`codesign --sign -`) so macOS treats it as a normal local app rather than an unverified
one - this only matters if the app is later copied to another machine, moved, or zipped/downloaded,
since Gatekeeper's "unidentified developer" warning is triggered by the `com.apple.quarantine`
attribute a browser/AirDrop download sets, not by running it locally after building it yourself.

Drag `dist/Tapestry Viewer.app` to `/Applications` (or leave it wherever's convenient) once built.
