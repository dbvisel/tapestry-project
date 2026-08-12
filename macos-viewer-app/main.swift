// Tapestry Viewer.app's entire native footprint. Its only job is to receive the `application(_:open:)`
// Apple Event macOS sends when a file is dropped on the app (or its Dock icon) or opened via "Open With",
// and hand that file's path off to open-tapestry.sh (bundled in Resources), which does the actual work.
//
// A bare shell-script executable can't do this: launching one via exec() works fine for a plain
// double-click, but it never registers with the Window Server, so it has no way to receive the Apple Event
// that carries a dropped/opened file - that's a different delivery mechanism from argv, which only really
// applies to genuine command-line invocation (e.g. `open -a`).
import Cocoa

final class AppDelegate: NSObject, NSApplicationDelegate {
    private var handledAFile = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        // If macOS is about to deliver an `open` event, it does so around launch time but not at a
        // guaranteed point relative to this callback - so wait a moment before assuming there isn't one,
        // rather than showing the "no file" message for what's actually a drop in progress.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
            if !self.handledAFile {
                Self.runHelper(withPath: nil)
                NSApp.terminate(nil)
            }
        }
    }

    func application(_ application: NSApplication, open urls: [URL]) {
        handledAFile = true
        for url in urls {
            Self.runHelper(withPath: url.path)
        }
        // Give open-tapestry.sh a moment to launch its local server and open the browser before we exit.
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) {
            NSApp.terminate(nil)
        }
    }

    func applicationSupportsSecureRestorableState(_ app: NSApplication) -> Bool { true }

    private static func runHelper(withPath path: String?) {
        guard let resourcePath = Bundle.main.resourcePath else { return }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/bash")
        process.arguments = [resourcePath + "/open-tapestry.sh"] + (path.map { [$0] } ?? [])
        try? process.run()
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
