import AppKit
import WebKit

// Ballast: a native window around the Ballast web app.
// The app needs its small local server (server.js), which fetches market data and keeps the Alpaca keys
// on this Mac, so the window starts `node server.js` and shows it. A copy built from source runs the
// project folder named in Info.plist (BallastSourceFolder); the packaged copy (the DMG) carries the code
// and Node.js in Resources and keeps keys and autopilot data in ~/Library/Application Support/Ballast. The server also runs the paper-trading autopilot while the app is open;
// closing the window only hides it, and Quit stops the server.
// The packaged app updates itself from the newest successful CI build of main, using a read-only GitHub
// token saved in the keys form (the repository is private). Built from source, it instead pulls main
// with git when opened and every 15 minutes: page changes reload the
// window, server changes restart the server, and changes to the Mac app itself rebuild and reopen it.

let port = Int(ProcessInfo.processInfo.environment["BALLAST_PORT"] ?? "") ?? 5179
let home = URL(string: "http://127.0.0.1:\(port)/")!
/// Keys the keys form manages; the server reads them only from the keys file.
let keyNames: Set<String> = ["ALPACA_API_KEY_ID", "ALPACA_API_SECRET_KEY", "ANTHROPIC_API_KEY", "BALLAST_UPDATE_TOKEN"]
let logURL = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Logs/Ballast.log")

/// GUI apps don't get the shell's PATH, so add the usual places Node.js is installed.
let searchPath = (["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"]
    + (ProcessInfo.processInfo.environment["PATH"] ?? "").split(separator: ":").map(String.init))
    .reduce(into: [String]()) { if !$0.contains($1) { $0.append($1) } }
    .joined(separator: ":")

func escapeHTML(_ s: String) -> String {
    s.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;").replacingOccurrences(of: ">", with: "&gt;")
}

final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate {
    var window: NSWindow!
    var webView: WKWebView!
    var server: Process?
    var stoppingServer = false
    var pageSignature = ""
    var lastPull = Date.distantPast
    var sigterm: DispatchSourceSignal?

    lazy var sourceFolder: URL? = {
        guard let path = Bundle.main.object(forInfoDictionaryKey: "BallastSourceFolder") as? String, !path.isEmpty else { return nil }
        return URL(fileURLWithPath: (path as NSString).expandingTildeInPath, isDirectory: true)
    }()

    /// The packaged app's own copy of Ballast, in Resources/app.
    lazy var bundledCode: URL? = {
        guard let app = Bundle.main.resourceURL?.appendingPathComponent("app"),
              FileManager.default.fileExists(atPath: app.appendingPathComponent("server.js").path) else { return nil }
        return app
    }()

    /// Where the server's code lives: the project folder when built from source, else the packaged copy.
    var codeFolder: URL? {
        if let folder = sourceFolder, FileManager.default.fileExists(atPath: folder.appendingPathComponent("server.js").path) { return folder }
        return bundledCode
    }

    var isPackaged: Bool { codeFolder != nil && codeFolder == bundledCode }

    /// The keys file. Every copy of Ballast on this Mac (the DMG or one built from source) shares it, so keys
    /// are entered once and survive updates, reinstalls, new clones and switching between the two.
    var keysFile: URL {
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("Ballast")
        try? FileManager.default.createDirectory(at: support, withIntermediateDirectories: true)
        let file = support.appendingPathComponent(".env")
        // Source builds used to keep keys in the project folder: move them here once.
        if !FileManager.default.fileExists(atPath: file.path), let old = sourceFolder?.appendingPathComponent(".env"),
           FileManager.default.fileExists(atPath: old.path) {
            try? FileManager.default.moveItem(at: old, to: file)
        }
        return file
    }

    /// Autopilot data: the project folder when built from source, else Application Support.
    var dataFolder: URL? {
        if !isPackaged { return codeFolder }
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("Ballast")
        try? FileManager.default.createDirectory(at: support, withIntermediateDirectories: true)
        return support
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        buildMenu()

        // The installer's rebuild quits the app with SIGTERM; quit cleanly so the server stops with it.
        signal(SIGTERM, SIG_IGN)
        sigterm = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
        sigterm?.setEventHandler { NSApp.terminate(nil) }
        sigterm?.resume()

        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default() // keeps saved strategies, portfolio and settings
        webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = self
        webView.uiDelegate = self

        let screen = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
        let size = NSSize(width: min(1400, screen.width * 0.85), height: screen.height * 0.88)
        window = NSWindow(
            contentRect: NSRect(origin: .zero, size: size),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered, defer: false)
        window.title = "Ballast"
        window.minSize = NSSize(width: 720, height: 520)
        window.collectionBehavior.insert(.fullScreenPrimary)
        window.contentView = webView
        window.delegate = self
        window.setFrameAutosaveName("BallastMainWindow")
        if !window.setFrameUsingName("BallastMainWindow") { window.center() }
        window.makeKeyAndOrderFront(nil)

        startServer()
        pageSignature = signature()
        Timer.scheduledTimer(withTimeInterval: 1.5, repeats: true) { [weak self] _ in self?.checkPageChanges() }
        Timer.scheduledTimer(withTimeInterval: 15 * 60, repeats: true) { [weak self] _ in
            self?.pullUpdates()
            self?.checkForAppUpdate()
        }
        pullUpdates()
        checkForAppUpdate()
        NSApp.activate(ignoringOtherApps: true)
    }

    func applicationWillTerminate(_ notification: Notification) { stopServer() }

    // MARK: Messages shown in the window

    func showMessage(_ title: String, _ detail: String, log: Bool = false) {
        var tail = ""
        if log, let text = try? String(contentsOf: logURL, encoding: .utf8) {
            tail = "<pre>\(escapeHTML(text.split(separator: "\n").suffix(12).joined(separator: "\n")))</pre>"
        }
        let html = """
        <!doctype html><meta charset="utf-8"><style>
        body { font: 15px -apple-system, system-ui, sans-serif; color: #1f2933; background: #f6f7f9; margin: 0;
               display: flex; align-items: center; justify-content: center; min-height: 100vh; }
        main { max-width: 560px; padding: 32px; } h1 { font-size: 20px; } code, pre { font: 12px ui-monospace, monospace; }
        pre { background: #e9ecef; padding: 12px; border-radius: 8px; white-space: pre-wrap; }
        @media (prefers-color-scheme: dark) { body { color: #e5e7eb; background: #111418; } pre { background: #1d232a; } }
        </style><main><h1>\(escapeHTML(title))</h1><p>\(detail)</p>\(tail)</main>
        """
        webView.loadHTMLString(html, baseURL: nil)
    }

    // MARK: Server

    /// Finds Node.js: the usual install locations, then a login shell (which knows nvm, fnm and similar).
    func findNode() -> String? {
        if let bundled = Bundle.main.resourceURL?.appendingPathComponent("node").path,
           FileManager.default.isExecutableFile(atPath: bundled) { return bundled }
        for path in ["/opt/homebrew/bin/node", "/usr/local/bin/node"] where FileManager.default.isExecutableFile(atPath: path) {
            return path
        }
        let out = run("/bin/zsh", ["-lc", "command -v node"], in: nil)
        if let path = out?.split(separator: "\n").last.map(String.init), FileManager.default.isExecutableFile(atPath: path) { return path }
        return nil
    }

    /// Runs a command and returns its trimmed output, or nil if it failed.
    @discardableResult
    func run(_ exe: String, _ args: [String], in folder: URL?, env: [String: String] = [:]) -> String? {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: exe)
        p.arguments = args
        if let folder = folder { p.currentDirectoryURL = folder }
        p.environment = ProcessInfo.processInfo.environment.merging(["PATH": searchPath, "GIT_TERMINAL_PROMPT": "0"].merging(env) { $1 }) { $1 }
        let out = Pipe()
        p.standardOutput = out
        p.standardError = FileHandle.nullDevice
        guard (try? p.run()) != nil else { return nil }
        let data = out.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        return p.terminationStatus == 0 ? String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) : nil
    }

    func startServer() {
        guard let folder = codeFolder else {
            showMessage("Ballast's files are missing", "Download Ballast again and drag it into Applications.")
            return
        }
        guard let node = findNode() else {
            showMessage("Ballast needs Node.js",
                        "Install the LTS version from <b>nodejs.org</b>, then quit and reopen Ballast.")
            return
        }
        showMessage("Starting Ballast…", "")
        let serverJS = folder.appendingPathComponent("server.js").path
        DispatchQueue.global(qos: .userInitiated).async { [self] in
            // A server left over from a crash would run old code on our port: stop it first.
            run("/usr/bin/pkill", ["-f", serverJS], in: nil)
            if !isPackaged, !FileManager.default.fileExists(atPath: folder.appendingPathComponent("node_modules").path) {
                let npm = (node as NSString).deletingLastPathComponent + "/npm"
                run(npm, ["install", "--no-audit", "--no-fund"], in: folder)
            }
            FileManager.default.createFile(atPath: logURL.path, contents: nil)
            let log = try? FileHandle(forWritingTo: logURL)

            let p = Process()
            p.executableURL = URL(fileURLWithPath: node)
            p.arguments = [serverJS]
            p.currentDirectoryURL = folder
            var env = ["PATH": searchPath, "PORT": String(port), "HOST": "127.0.0.1"]
            if isPackaged, let data = dataFolder { env["BALLAST_HOME"] = data.path }
            env["BALLAST_ENV_FILE"] = keysFile.path
            // The keys file decides the keys: don't let stale copies in the inherited environment override it.
            let inherited = ProcessInfo.processInfo.environment.filter { !keyNames.contains($0.key) }
            p.environment = inherited.merging(env) { $1 }
            p.standardOutput = log ?? FileHandle.nullDevice
            p.standardError = log ?? FileHandle.nullDevice
            p.terminationHandler = { [weak self] proc in
                DispatchQueue.main.async {
                    guard let self = self, !self.stoppingServer, proc === self.server else { return }
                    self.server = nil
                    self.showMessage("Ballast's server stopped",
                                     "Choose <b>View → Restart Server</b> to try again. The last lines of its log:", log: true)
                }
            }
            DispatchQueue.main.async {
                self.stoppingServer = false
                do {
                    try p.run()
                    self.server = p
                    self.waitForServer(attempts: 60)
                } catch {
                    self.showMessage("Couldn't start Ballast's server", escapeHTML(error.localizedDescription))
                }
            }
        }
    }

    /// Polls the server until it answers, then shows the app.
    func waitForServer(attempts: Int) {
        var request = URLRequest(url: home.appendingPathComponent("api/status"), timeoutInterval: 2)
        request.cachePolicy = .reloadIgnoringLocalCacheData
        URLSession.shared.dataTask(with: request) { [weak self] _, response, _ in
            DispatchQueue.main.async {
                guard let self = self, self.server != nil else { return }
                if (response as? HTTPURLResponse)?.statusCode == 200 {
                    self.webView.load(URLRequest(url: home))
                    self.offerKeysOnce()
                } else if attempts > 0 {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { self.waitForServer(attempts: attempts - 1) }
                } else {
                    self.showMessage("Ballast's server didn't start", "The last lines of its log:", log: true)
                }
            }
        }.resume()
    }

    func stopServer() {
        guard let p = server else { return }
        stoppingServer = true
        server = nil
        p.terminate()
        p.waitUntilExit()
    }

    @objc func restartServer(_ sender: Any?) {
        stopServer()
        startServer()
    }

    // MARK: Updates

    /// Modification dates of the page files, so local edits and pulled changes show up without a restart.
    private func signature() -> String {
        guard let folder = codeFolder?.appendingPathComponent("public"),
              let walker = FileManager.default.enumerator(at: folder, includingPropertiesForKeys: [.contentModificationDateKey, .fileSizeKey])
        else { return "" }
        var parts: [String] = []
        for case let url as URL in walker {
            let v = try? url.resourceValues(forKeys: [.contentModificationDateKey, .fileSizeKey])
            parts.append("\(url.path):\(v?.contentModificationDate?.timeIntervalSince1970 ?? 0):\(v?.fileSize ?? 0)")
        }
        return parts.sorted().joined(separator: "|")
    }

    private func checkPageChanges() {
        let sig = signature()
        guard sig != pageSignature else { return }
        pageSignature = sig
        if webView.url?.host == "127.0.0.1" { webView.reloadFromOrigin() }
    }

    /// Pulls the latest main from GitHub, then restarts the server or rebuilds the app if their files changed.
    func pullUpdates() {
        guard let folder = sourceFolder, Date().timeIntervalSince(lastPull) > 60,
              FileManager.default.fileExists(atPath: folder.appendingPathComponent(".git").path) else { return }
        lastPull = Date()
        DispatchQueue.global(qos: .utility).async { [self] in
            let git = "/usr/bin/git"
            guard let before = run(git, ["rev-parse", "HEAD"], in: folder),
                  run(git, ["fetch", "--quiet", "origin", "main"], in: folder) != nil,
                  run(git, ["checkout", "--quiet", "main"], in: folder) != nil,
                  run(git, ["merge", "--ff-only", "--quiet", "origin/main"], in: folder) != nil,
                  let after = run(git, ["rev-parse", "HEAD"], in: folder), after != before,
                  let changed = run(git, ["diff", "--name-only", before, after], in: folder)?.split(separator: "\n").map(String.init)
            else { return }
            if changed.contains(where: { $0.hasPrefix("app/macos/") }) {
                // build.sh reinstalls the app and reopens it; it quits this copy first.
                run("/bin/zsh", [folder.appendingPathComponent("app/macos/build.sh").path], in: folder)
                return
            }
            if changed.contains(where: { $0 == "package.json" || $0 == "package-lock.json" }), let node = findNode() {
                run((node as NSString).deletingLastPathComponent + "/npm", ["install", "--no-audit", "--no-fund"], in: folder)
            }
            // The server also loads shared modules from public/lib, so any script change restarts it.
            if changed.contains(where: { $0.hasSuffix(".js") || $0.hasPrefix("package") }) {
                DispatchQueue.main.async { self.restartServer(nil) }
            }
        }
    }

    func applicationDidBecomeActive(_ notification: Notification) {
        pullUpdates()
        checkForAppUpdate()
    }

    // MARK: Self-update (packaged app)

    let repoAPI = "https://api.github.com/repos/bollineni-create/ballast"
    var lastUpdateCheck = Date.distantPast
    var updating = false

    var buildSHA: String { Bundle.main.object(forInfoDictionaryKey: "BallastBuildSHA") as? String ?? "" }

    func updateToken() -> String? {
        guard let token = readKeys(keysFile)["BALLAST_UPDATE_TOKEN"], !token.isEmpty else { return nil }
        return token
    }

    /// Runs curl against GitHub with the token in a header file, so it never shows in the process list.
    /// Returns what curl printed, or nil if the request failed.
    func github(_ args: [String], token: String) -> Data? {
        let header = FileManager.default.temporaryDirectory.appendingPathComponent("ballast-auth-\(UUID().uuidString)")
        FileManager.default.createFile(atPath: header.path, contents: Data("Authorization: Bearer \(token)\n".utf8),
                                       attributes: [.posixPermissions: 0o600])
        defer { try? FileManager.default.removeItem(at: header) }
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/curl")
        // curl drops the Authorization header when a download redirects to another host.
        p.arguments = ["-fsSL", "--max-time", "900", "-H", "@\(header.path)", "-H", "Accept: application/vnd.github+json"] + args
        let out = Pipe()
        p.standardOutput = out
        p.standardError = FileHandle.nullDevice
        guard (try? p.run()) != nil else { return nil }
        let data = out.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        return p.terminationStatus == 0 ? data : nil
    }

    enum UpdateResult { case current, ready(URL), failed(String) }

    /// Checks hourly (or now, from the menu) for a newer build, downloads it and swaps it in.
    func checkForAppUpdate(manual: Bool = false) {
        guard isPackaged, !updating, manual || Date().timeIntervalSince(lastUpdateCheck) > 3600 else { return }
        lastUpdateCheck = Date()
        guard let token = updateToken() else {
            if manual { tell("Automatic updates are off", "Add a GitHub update token in Ballast → Edit Keys… to turn them on. The README explains how to make one.") }
            return
        }
        let appPath = Bundle.main.bundleURL.path
        guard !appPath.contains("/AppTranslocation/"), FileManager.default.isWritableFile(atPath: (appPath as NSString).deletingLastPathComponent) else {
            if manual { tell("Move Ballast into Applications first", "Ballast can only update itself from the Applications folder.") }
            return
        }
        updating = true
        DispatchQueue.global(qos: .utility).async { [self] in
            let result = downloadUpdate(token: token)
            DispatchQueue.main.async {
                self.updating = false
                switch result {
                case .ready(let app): self.installUpdate(app)
                case .current: if manual { self.tell("Ballast is up to date", "") }
                case .failed(let why): if manual { self.tell("Couldn't update Ballast", why) }
                }
            }
        }
    }

    func downloadUpdate(token: String) -> UpdateResult {
        guard let data = github(["\(repoAPI)/actions/workflows/ci.yml/runs?branch=main&status=success&per_page=1"], token: token),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let latest = (json["workflow_runs"] as? [[String: Any]])?.first,
              let sha = latest["head_sha"] as? String, let runID = latest["id"] as? Int
        else { return .failed("GitHub didn't accept the update token. Check that it hasn't expired and can read this repository's Actions.") }
        if sha == buildSHA { return .current }
        guard let listData = github(["\(repoAPI)/actions/runs/\(runID)/artifacts"], token: token),
              let list = try? JSONSerialization.jsonObject(with: listData) as? [String: Any],
              let artifact = (list["artifacts"] as? [[String: Any]])?.first(where: { $0["name"] as? String == "Ballast-mac" && $0["expired"] as? Bool != true }),
              let zipURL = artifact["archive_download_url"] as? String
        else { return .failed("The newest build has no app to download.") }

        let work = FileManager.default.temporaryDirectory.appendingPathComponent("ballast-update-\(UUID().uuidString)")
        try? FileManager.default.createDirectory(at: work, withIntermediateDirectories: true)
        let zip = work.appendingPathComponent("Ballast-mac.zip"), mount = work.appendingPathComponent("mnt")
        let newApp = work.appendingPathComponent("Ballast.app")
        guard github(["-o", zip.path, zipURL], token: token) != nil,
              run("/usr/bin/ditto", ["-x", "-k", zip.path, work.path], in: nil) != nil,
              run("/usr/bin/hdiutil", ["attach", "-nobrowse", "-readonly", "-mountpoint", mount.path,
                                      work.appendingPathComponent("Ballast.dmg").path], in: nil) != nil
        else { return .failed("Downloading the new version failed.") }
        let copied = run("/usr/bin/ditto", [mount.appendingPathComponent("Ballast.app").path, newApp.path], in: nil) != nil
        run("/usr/bin/hdiutil", ["detach", mount.path, "-force"], in: nil)
        guard copied, run("/usr/bin/codesign", ["--verify", "--deep", newApp.path], in: nil) != nil
        else { return .failed("The downloaded app didn't pass its signature check.") }
        return .ready(newApp)
    }

    /// Swaps in the new app once this one has quit, then reopens it. Waits while the autopilot is mid-check.
    func installUpdate(_ newApp: URL) {
        if let lock = dataFolder?.appendingPathComponent("autopilot-data/.lock"),
           let modified = (try? FileManager.default.attributesOfItem(atPath: lock.path))?[.modificationDate] as? Date,
           Date().timeIntervalSince(modified) < 15 * 60 {
            DispatchQueue.main.asyncAfter(deadline: .now() + 60) { self.installUpdate(newApp) }
            return
        }
        let script = """
        while kill -0 \(ProcessInfo.processInfo.processIdentifier) 2>/dev/null; do sleep 0.5; done
        rm -rf "$1.old"
        if mv "$1" "$1.old" && mv "$2" "$1"; then rm -rf "$1.old"; elif [ -d "$1.old" ] && [ ! -d "$1" ]; then mv "$1.old" "$1"; fi
        open "$1"
        """
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/zsh")
        p.arguments = ["-c", script, "ballast-update", Bundle.main.bundleURL.path, newApp.path]
        guard (try? p.run()) != nil else { return }
        NSApp.terminate(nil)
    }

    @objc func checkForUpdatesNow(_ sender: Any?) {
        if isPackaged { checkForAppUpdate(manual: true) } else { lastPull = .distantPast; pullUpdates() }
    }

    func tell(_ title: String, _ detail: String) {
        guard window.attachedSheet == nil else { return }
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = detail
        alert.beginSheetModal(for: window, completionHandler: nil)
    }

    // MARK: Window

    // The red close button hides the window, so the autopilot keeps running; Quit (Cmd-Q) stops it.
    func windowShouldClose(_ sender: NSWindow) -> Bool {
        sender.orderOut(nil)
        return false
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag { window.makeKeyAndOrderFront(nil) }
        return true
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    // MARK: Web view

    // Links to other sites open in the default browser; CSV exports are saved to Downloads.
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if action.shouldPerformDownload { return decisionHandler(.download) }
        if let url = action.request.url, url.scheme?.hasPrefix("http") == true, url.host != "127.0.0.1" {
            NSWorkspace.shared.open(url)
            return decisionHandler(.cancel)
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        download.delegate = self
    }

    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String,
                  completionHandler: @escaping (URL?) -> Void) {
        let downloads = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask)[0]
        let name = (suggestedFilename as NSString).deletingPathExtension, ext = (suggestedFilename as NSString).pathExtension
        var url = downloads.appendingPathComponent(suggestedFilename)
        var n = 2
        while FileManager.default.fileExists(atPath: url.path) {
            url = downloads.appendingPathComponent("\(name) \(n)").appendingPathExtension(ext)
            n += 1
        }
        completionHandler(url)
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) { NSWorkspace.shared.activateFileViewerSelecting([url]) }
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url { NSWorkspace.shared.open(url) }
        return nil
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let alert = NSAlert()
        alert.messageText = message
        alert.beginSheetModal(for: window) { _ in completionHandler() }
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let alert = NSAlert()
        alert.messageText = message
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Cancel")
        alert.beginSheetModal(for: window) { completionHandler($0 == .alertFirstButtonReturn) }
    }

    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
        let alert = NSAlert()
        alert.messageText = prompt
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 360, height: 24))
        field.stringValue = defaultText ?? ""
        alert.accessoryView = field
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Cancel")
        alert.beginSheetModal(for: window) { completionHandler($0 == .alertFirstButtonReturn ? field.stringValue : nil) }
    }

    // MARK: Menu actions

    @objc func reloadPage(_ sender: Any?) { if server == nil { startServer() } else { webView.load(URLRequest(url: home)) } }

    /// Reads KEY=value lines from the keys file.
    func readKeys(_ url: URL) -> [String: String] {
        guard let text = try? String(contentsOf: url, encoding: .utf8) else { return [:] }
        var out: [String: String] = [:]
        for line in text.split(separator: "\n") where !line.hasPrefix("#") {
            let parts = line.split(separator: "=", maxSplits: 1).map { $0.trimmingCharacters(in: .whitespaces) }
            if parts.count == 2 { out[parts[0]] = parts[1] }
        }
        return out
    }

    /// The first time the app runs without a keys file, offers the keys form once.
    func offerKeysOnce() {
        guard !FileManager.default.fileExists(atPath: keysFile.path), !UserDefaults.standard.bool(forKey: "offeredKeys") else { return }
        UserDefaults.standard.set(true, forKey: "offeredKeys")
        editKeys(nil)
    }

    /// Cleans a pasted key: drops spaces, line breaks, surrounding quotes and a leading "NAME=".
    func cleanKey(_ raw: String, name: String) -> String {
        var s = raw.components(separatedBy: .whitespacesAndNewlines).joined()
        if s.hasPrefix(name + "=") { s.removeFirst(name.count + 1) }
        return s.trimmingCharacters(in: CharacterSet(charactersIn: "\"'"))
    }

    /// Tries the Alpaca and Anthropic keys against their services and reports the ones they reject.
    /// A network failure counts as fine, so being offline never blocks saving.
    func checkKeys(_ keys: [String: String], done: @escaping ([String]) -> Void) {
        var checks: [(problem: String, request: URLRequest)] = []
        if let id = keys["ALPACA_API_KEY_ID"], let secret = keys["ALPACA_API_SECRET_KEY"], !id.isEmpty || !secret.isEmpty {
            var r = URLRequest(url: URL(string: "https://paper-api.alpaca.markets/v2/account")!)
            r.setValue(id, forHTTPHeaderField: "APCA-API-KEY-ID")
            r.setValue(secret, forHTTPHeaderField: "APCA-API-SECRET-KEY")
            checks.append((problem: "Alpaca rejected the paper key ID and secret. Copy both from the Paper Trading dashboard at alpaca.markets (live-account keys don't work); regenerate them if the secret is no longer shown.", request: r))
        }
        if let key = keys["ANTHROPIC_API_KEY"], !key.isEmpty {
            var r = URLRequest(url: URL(string: "https://api.anthropic.com/v1/models?limit=1")!)
            r.setValue(key, forHTTPHeaderField: "x-api-key")
            r.setValue("2023-06-01", forHTTPHeaderField: "anthropic-version")
            checks.append((problem: "Anthropic rejected the API key. Create one at console.anthropic.com under API Keys; it starts with sk-ant-.", request: r))
        }
        let group = DispatchGroup()
        var problems: [String] = []
        for check in checks {
            var request = check.request
            request.timeoutInterval = 10
            group.enter()
            URLSession.shared.dataTask(with: request) { _, response, _ in
                let code = (response as? HTTPURLResponse)?.statusCode
                DispatchQueue.main.async {
                    if code == 401 || code == 403 { problems.append(check.problem) }
                    group.leave()
                }
            }.resume()
        }
        group.notify(queue: .main) { done(problems) }
    }

    /// A small form for the optional keys. Saving writes them to the keys file, restarts the server, then
    /// checks the keys and reopens the form with what was rejected, so a bad key is caught right away.
    @objc func editKeys(_ sender: Any?) { showKeysForm(readKeys(keysFile), problems: []) }

    func showKeysForm(_ saved: [String: String], problems: [String]) {
        guard window.attachedSheet == nil else {
            // Another sheet is up: rejected keys must still be reported, so try again once it's gone.
            if !problems.isEmpty { DispatchQueue.main.asyncAfter(deadline: .now() + 1) { self.showKeysForm(saved, problems: problems) } }
            return
        }
        let envFile = keysFile
        var keys = saved
        let fields: [(name: String, label: String, secret: Bool)] = [
            ("ALPACA_API_KEY_ID", "Alpaca paper API key ID", false),
            ("ALPACA_API_SECRET_KEY", "Alpaca paper secret key", true),
            ("ANTHROPIC_API_KEY", "Anthropic API key (Claude strategy builder)", true),
            ("BALLAST_UPDATE_TOKEN", "GitHub update token (turns on automatic updates)", true),
        ]
        let stack = NSStackView()
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 6
        var inputs: [String: NSTextField] = [:]
        for f in fields {
            stack.addArrangedSubview(NSTextField(labelWithString: f.label))
            let input = f.secret ? NSSecureTextField() : NSTextField()
            input.stringValue = keys[f.name] ?? ""
            input.placeholderString = "Optional"
            input.translatesAutoresizingMaskIntoConstraints = false
            input.widthAnchor.constraint(equalToConstant: 380).isActive = true
            stack.addArrangedSubview(input)
            inputs[f.name] = input
        }
        stack.frame = NSRect(origin: .zero, size: stack.fittingSize)

        let alert = NSAlert()
        alert.messageText = problems.isEmpty ? "Keys" : "Check these keys"
        if !problems.isEmpty { alert.alertStyle = .warning }
        alert.informativeText = problems.isEmpty ? "All optional. Saved only on this Mac, and kept through updates and reinstalls, so you enter them once. Alpaca paper keys give official stock prices and turn on the paper autopilot: use a paper account nothing else trades in. Without them, stock prices come from Yahoo Finance. The GitHub update token lets Ballast download its own updates from the private repository." : problems.joined(separator: "\n\n") + "\n\nThe keys are saved as they are; fix them here or click Cancel."
        alert.accessoryView = stack
        alert.addButton(withTitle: "Save")
        alert.addButton(withTitle: "Cancel")
        window.makeKeyAndOrderFront(nil)
        alert.beginSheetModal(for: window) { [self] response in
            guard response == .alertFirstButtonReturn else { return }
            for f in fields { keys[f.name] = cleanKey(inputs[f.name]?.stringValue ?? "", name: f.name) }
            let text = "# Ballast keys. This file stays on this Mac.\n" + keys.keys.sorted().map { "\($0)=\(keys[$0] ?? "")" }.joined(separator: "\n") + "\n"
            FileManager.default.createFile(atPath: envFile.path, contents: Data(text.utf8))
            try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: envFile.path)
            restartServer(nil)
            // Check the keys before any update-check sheet can claim the window, so a rejection always shows.
            checkKeys(keys) { found in
                if !found.isEmpty { self.showKeysForm(keys, problems: found) }
                else if self.isPackaged, !(keys["BALLAST_UPDATE_TOKEN"] ?? "").isEmpty { self.checkForAppUpdate(manual: true) }
            }
        }
    }

    @objc func showLog(_ sender: Any?) { NSWorkspace.shared.open(logURL) }
    @objc func revealProject(_ sender: Any?) {
        if let folder = dataFolder { NSWorkspace.shared.activateFileViewerSelecting([folder]) }
    }
    @objc func openRepository(_ sender: Any?) {
        NSWorkspace.shared.open(URL(string: "https://github.com/bollineni-create/ballast")!)
    }

    private func buildMenu() {
        let main = NSMenu()

        let appItem = NSMenuItem(); main.addItem(appItem)
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "About Ballast", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Check for Updates…", action: #selector(checkForUpdatesNow(_:)), keyEquivalent: "")
        appMenu.addItem(withTitle: "Edit Keys…", action: #selector(editKeys(_:)), keyEquivalent: ",")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Hide Ballast", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Quit Ballast", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu

        // Without an Edit menu, Cmd-C / Cmd-V don't reach the page's text fields.
        let editItem = NSMenuItem(); main.addItem(editItem)
        let edit = NSMenu(title: "Edit")
        edit.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        edit.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "Z")
        edit.addItem(.separator())
        edit.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = edit

        let viewItem = NSMenuItem(); main.addItem(viewItem)
        let view = NSMenu(title: "View")
        view.addItem(withTitle: "Reload", action: #selector(reloadPage(_:)), keyEquivalent: "r")
        view.addItem(withTitle: "Restart Server", action: #selector(restartServer(_:)), keyEquivalent: "R")
        view.addItem(.separator())
        let fullScreen = NSMenuItem(title: "Enter Full Screen", action: #selector(NSWindow.toggleFullScreen(_:)), keyEquivalent: "f")
        fullScreen.keyEquivalentModifierMask = [.command, .control]
        view.addItem(fullScreen)
        viewItem.submenu = view

        let windowItem = NSMenuItem(); main.addItem(windowItem)
        let windowMenu = NSMenu(title: "Window")
        windowMenu.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        windowMenu.addItem(withTitle: "Zoom", action: #selector(NSWindow.performZoom(_:)), keyEquivalent: "")
        windowItem.submenu = windowMenu
        NSApp.windowsMenu = windowMenu

        let helpItem = NSMenuItem(); main.addItem(helpItem)
        let help = NSMenu(title: "Help")
        help.addItem(withTitle: "Ballast on GitHub", action: #selector(openRepository(_:)), keyEquivalent: "")
        help.addItem(withTitle: "Show Ballast Folder", action: #selector(revealProject(_:)), keyEquivalent: "")
        help.addItem(withTitle: "Open Server Log", action: #selector(showLog(_:)), keyEquivalent: "")
        helpItem.submenu = help

        NSApp.mainMenu = main
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
