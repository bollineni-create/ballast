import AppKit
import WebKit

// Ballast: a native window around the Ballast web app.
// The app needs its small local server (server.js), which fetches market data and keeps the Alpaca keys
// in .env on this Mac, so the window starts `node server.js` from the project folder named in Info.plist
// (BallastSourceFolder) and shows it. The server also runs the paper-trading autopilot while the app is open;
// closing the window only hides it, and Quit stops the server.
// It pulls the latest version of main from GitHub when opened and every 15 minutes: page changes reload the
// window, server changes restart the server, and changes to the Mac app itself rebuild and reopen it.

let port = Int(ProcessInfo.processInfo.environment["BALLAST_PORT"] ?? "") ?? 5179
let home = URL(string: "http://127.0.0.1:\(port)/")!
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
        Timer.scheduledTimer(withTimeInterval: 15 * 60, repeats: true) { [weak self] _ in self?.pullUpdates() }
        pullUpdates()
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
        guard let folder = sourceFolder, FileManager.default.fileExists(atPath: folder.appendingPathComponent("server.js").path) else {
            showMessage("Ballast's folder is missing",
                        "Reinstall it by pasting this into Terminal:<br><code>curl -fsSL https://raw.githubusercontent.com/bollineni-create/ballast/main/app/macos/install.sh | zsh</code>")
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
            if !FileManager.default.fileExists(atPath: folder.appendingPathComponent("node_modules").path) {
                let npm = (node as NSString).deletingLastPathComponent + "/npm"
                run(npm, ["install", "--no-audit", "--no-fund"], in: folder)
            }
            FileManager.default.createFile(atPath: logURL.path, contents: nil)
            let log = try? FileHandle(forWritingTo: logURL)

            let p = Process()
            p.executableURL = URL(fileURLWithPath: node)
            p.arguments = [serverJS]
            p.currentDirectoryURL = folder
            p.environment = ProcessInfo.processInfo.environment.merging(
                ["PATH": searchPath, "PORT": String(port), "HOST": "127.0.0.1"]) { $1 }
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
        guard let folder = sourceFolder?.appendingPathComponent("public"),
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

    func applicationDidBecomeActive(_ notification: Notification) { pullUpdates() }

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

    /// Opens the keys file (.env) in TextEdit, creating it from .env.example the first time.
    @objc func editKeys(_ sender: Any?) {
        guard let folder = sourceFolder else { return }
        let env = folder.appendingPathComponent(".env")
        if !FileManager.default.fileExists(atPath: env.path) {
            try? FileManager.default.copyItem(at: folder.appendingPathComponent(".env.example"), to: env)
            try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: env.path)
        }
        run("/usr/bin/open", ["-e", env.path], in: nil)
        let alert = NSAlert()
        alert.messageText = "After saving your keys, choose View → Restart Server so Ballast picks them up."
        alert.beginSheetModal(for: window, completionHandler: nil)
    }

    @objc func showLog(_ sender: Any?) { NSWorkspace.shared.open(logURL) }
    @objc func revealProject(_ sender: Any?) {
        if let folder = sourceFolder { NSWorkspace.shared.activateFileViewerSelecting([folder]) }
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
