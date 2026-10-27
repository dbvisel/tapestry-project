// Copied into a running server/worker container by manage-tapestry-thumbnail.sh and run once via
// `npx tsx run-generate-tapestry-thumbnail.ts <tapestryId>`, then deleted. Not meant to be run by hand
// outside that container - it imports the app's own scheduleTapestryThumbnailGeneration() rather than
// reimplementing it, so it needs the container's node_modules, Prisma client, DB, and Redis access.
//
// This file's own copy sits alongside manage-tapestry-thumbnail.sh wherever that lives (e.g. a repo's own
// scripts/ directory) - it is never executed from there directly, only the copy the .sh script places
// inside the container is. The import below is resolved relative to REPO_DIR - the directory containing
// server/ - so this behaves the same wherever it's actually run from: `/app` inside the container (set by
// manage-tapestry-thumbnail.sh when it execs this via `-e REPO_DIR=...`), or a real repo checkout's root if
// this is ever run directly on a host. (Same approach as the sibling tapestry-frame-thumbnails skill; see
// its run-generate-frame-thumbnails.ts for the fuller rationale.)
//
// scheduleTapestryThumbnailGeneration() re-screenshots the TAPESTRY's own single card thumbnail
// (Tapestry.thumbnail) - not any individual frame's thumbnail. Called with no items marked
// scheduledThumbnailProcessing (unlike the frame-thumbnails skill's generateThumbnails()), the
// generate-tapestry-thumbnails job this schedules finds no items to also screenshot, so this only ever
// touches the tapestry's own thumbnail.
//
// Wrapped in an async IIFE rather than using top-level await: this file gets copied to a location (/tmp)
// with no nearby package.json declaring "type": "module", so tsx/esbuild transforms it as CJS, which doesn't
// support top-level await regardless of what the file's own syntax looks like otherwise.
;(async () => {
  const repoDir = process.env.REPO_DIR ?? '.'
  const { scheduleTapestryThumbnailGeneration } = await import(`${repoDir}/server/src/tasks/utils.js`)

  const tapestryId = process.argv[2]
  if (!tapestryId) {
    console.error('Usage: REPO_DIR=<dir containing server/> tsx run-generate-tapestry-thumbnail.ts <tapestryId>')
    process.exit(1)
  }

  try {
    // skipDelay: true - unlike the app's own normal debounced trigger (coalescing rapid edits before
    // screenshotting), this is a single deliberate admin action, so there's no reason to wait.
    await scheduleTapestryThumbnailGeneration(tapestryId, { skipDelay: true })
    console.log(`Scheduled tapestry-thumbnail regeneration for tapestry ${tapestryId}.`)
    // scheduleTapestryThumbnailGeneration() leaves the BullMQ queue's Redis connection open (fine for the
    // long-running server/worker process that normally calls it) - this is a one-shot CLI invocation, so
    // without an explicit exit the process just hangs forever instead of returning.
    process.exit(0)
  } catch (error) {
    console.error('Failed to schedule tapestry-thumbnail regeneration:', error)
    process.exit(1)
  }
})()
