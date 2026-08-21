// Copied into a running server/worker container by manage-tapestry-frame-thumbnails.sh and run once via
// `npx tsx run-generate-frame-thumbnails.ts <tapestryId>`, then deleted. Not meant to be run by hand outside
// that container - it imports the app's own generateThumbnails() rather than reimplementing it, so it needs
// the container's node_modules, Prisma client, DB, and Redis access.
//
// This file's own copy sits alongside manage-tapestry-frame-thumbnails.sh wherever that lives (e.g. a repo's
// own scripts/ directory) - it is never executed from there directly, only the copy the .sh script places
// inside the container is. Rather than hardcode an import path that only resolves at one specific location
// (the old approach: assuming it sits as a sibling of src/), the import below is resolved relative to
// REPO_DIR - the directory containing server/ - so this behaves the same wherever it's actually run from:
// `/app` inside the container (set by manage-tapestry-frame-thumbnails.sh when it execs this via
// `-e REPO_DIR=...`), or a real repo checkout's root if this is ever run directly on a host.
//
// generateThumbnails() schedules a FRAME thumbnail (per-Item preview image) for every applicable item in the
// tapestry - not the tapestry's own single card thumbnail (Tapestry.thumbnail). That said, the shared job
// pipeline it enqueues (generate-tapestry-thumbnails.ts) always refreshes the tapestry's own thumbnail too,
// as an inherent side effect of how the app implements it, not something this script does separately.
// Wrapped in an async IIFE rather than using top-level await: this file gets copied to a location (/tmp)
// with no nearby package.json declaring "type": "module", so tsx/esbuild transforms it as CJS, which doesn't
// support top-level await regardless of what the file's own syntax looks like otherwise.
;(async () => {
  const repoDir = process.env.REPO_DIR ?? '.'
  const { generateThumbnails } = await import(`${repoDir}/server/src/tasks/utils.js`)

  const tapestryId = process.argv[2]
  if (!tapestryId) {
    console.error('Usage: REPO_DIR=<dir containing server/> tsx run-generate-frame-thumbnails.ts <tapestryId>')
    process.exit(1)
  }

  try {
    await generateThumbnails({ tapestryId })
    console.log(`Scheduled frame-thumbnail generation for tapestry ${tapestryId}.`)
    // generateThumbnails() leaves the Prisma client's DB pool and the BullMQ queue's Redis connection open
    // (fine for the long-running server/worker process that normally calls it) - this is a one-shot CLI
    // invocation, so without an explicit exit the process just hangs forever instead of returning.
    process.exit(0)
  } catch (error) {
    console.error('Failed to schedule frame-thumbnail generation:', error)
    process.exit(1)
  }
})()
