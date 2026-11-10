// Cutroom.app: a native window (AppKit + WKWebView) around Cutroom's local server.
// If nothing answers on the port it starts ~/cutroom/server.py (again, if it ever dies), and on quit it stops only a server it started.
// Build: app/build.sh -> ~/Applications/Cutroom.app
import AppKit
import UniformTypeIdentifiers
import WebKit

let env = ProcessInfo.processInfo.environment
let port = env["CUTROOM_PORT"] ?? "4610" // same overrides as server.py and the shell launcher
let base = URL(string: "http://127.0.0.1:\(port)/")!
let dataDir = URL(fileURLWithPath: env["CUTROOM_HOME"] ?? NSHomeDirectory() + "/Movies/Cutroom")
let logURL = dataDir.appendingPathComponent("server.log")

func ping() async -> Bool {
    let req = URLRequest(url: base.appendingPathComponent("api/ping"), cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 1)
    guard let (data, _) = try? await URLSession.shared.data(for: req) else { return false }
    return (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["ok"] as? Bool == true
}

func startServer() -> Process? {
    try? FileManager.default.createDirectory(at: dataDir, withIntermediateDirectories: true)
    let fd = open(logURL.path, O_WRONLY | O_APPEND | O_CREAT, 0o644) // O_APPEND: other launchers append to it too
    guard fd >= 0 else { return nil }
    let log = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/usr/bin/env")
    p.arguments = ["-u", "PYTHONPATH", "/opt/homebrew/bin/python3", "-I", NSHomeDirectory() + "/cutroom/server.py"]
    p.environment = env.merging(["PATH": "/opt/homebrew/bin:" + (env["PATH"] ?? "/usr/bin:/bin:/usr/sbin:/sbin")]) { $1 } // ffmpeg, whisper-cli, swiftc
    p.standardInput = FileHandle.nullDevice
    p.standardOutput = log
    p.standardError = log
    do { try p.run() } catch {
        log.write(Data("Cutroom.app could not start the server: \(error)\n".utf8))
        return nil
    }
    return p
}

func alert(_ text: String, _ buttons: [String]) -> NSAlert {
    let a = NSAlert()
    a.messageText = text
    buttons.forEach { a.addButton(withTitle: $0) } // a "Cancel" button gets Escape automatically
    return a
}

let pageTypes: Set<String> = ["srt", "vtt", "cube"] // files the page reads itself (subtitles, LUTs), not library media

/// Folders become the media files inside them (a camera card's DCIM folder), in name order; other files stay as they are.
func expand(_ urls: [URL]) -> [URL] {
    urls.flatMap { u -> [URL] in
        guard (try? u.resourceValues(forKeys: [.isDirectoryKey]))?.isDirectory == true else { return [u] }
        let all = FileManager.default.enumerator(at: u, includingPropertiesForKeys: nil, options: [.skipsHiddenFiles])?.allObjects as? [URL] ?? []
        return all.filter { f in UTType(filenameExtension: f.pathExtension).map { $0.conforms(to: .audiovisualContent) || $0.conforms(to: .image) } ?? false }
            .sorted { $0.path.localizedStandardCompare($1.path) == .orderedAscending }
    }
}

/// The editor's web view. Files dropped on it are imported by path (an APFS clone: instant, and no extra disk) instead of
/// being uploaded through the page, which copied every byte (25 GB of 4K clips took 25 GB more). Subtitles and LUTs still
/// go to the page.
final class EditorView: WKWebView {
    var onFiles: (([URL]) -> Void)?
    override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
        let urls = sender.draggingPasteboard.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL] ?? []
        guard !urls.isEmpty, urls.allSatisfy({ !pageTypes.contains($0.pathExtension.lowercased()) }), let take = onFiles else {
            return super.performDragOperation(sender)
        }
        evaluateJavaScript("document.body.classList.remove('dropping')")
        take(urls)
        return true
    }
}

@MainActor final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, WKUIDelegate, WKNavigationDelegate, WKScriptMessageHandler {
    var window: NSWindow!
    var web: WKWebView!
    var server: Process? // set only when this app started the server
    var popups: [NSWindow] = [] // window.open() targets, released on close
    var activity: NSObjectProtocol? // holds off App Nap while work runs (the page says when: jobs, MCP commands, playback)
    var pending: [URL] = [] // files opened with the app (Finder, Dock icon) before the editor is up
    var ready = false
    var pickLibrary = false // the page's "Import media" button opened the next file panel (it says so just before)

    func applicationDidFinishLaunching(_ note: Notification) {
        NSApp.appearance = NSAppearance(named: .darkAqua)
        NSWindow.allowsAutomaticWindowTabbing = false
        NSApp.mainMenu = mainMenu()
        let cfg = WKWebViewConfiguration()
        cfg.mediaTypesRequiringUserActionForPlayback = [] // the preview plays <video>s from code
        cfg.preferences.inactiveSchedulingPolicy = .none // keep running behind other windows: Claude Code drives it (MCP), exports run
        cfg.userContentController.add(self, name: "busy") // at rest the app may nap like any other: it used to hold App Nap off for good
        cfg.userContentController.add(self, name: "pick")
        let view = EditorView(frame: .zero, configuration: cfg)
        view.onFiles = { [weak self] urls in Task { _ = await self?.importPaths(urls, fallback: false) } }
        web = view
        web.isInspectable = true
        web.uiDelegate = self
        web.navigationDelegate = self
        web.isHidden = true // until the page loads: no white flash while the server starts
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1440, height: 900),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = "Cutroom"
        window.minSize = NSSize(width: 1100, height: 700)
        window.backgroundColor = NSColor(white: 0.08, alpha: 1)
        window.isReleasedWhenClosed = false
        window.contentView = web
        window.center()
        window.setFrameAutosaveName("Cutroom") // a saved frame overrides the centred default
        window.makeKeyAndOrderFront(nil)
        NSApp.activate()
        connect()
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        if message.name == "pick" { pickLibrary = true; return }
        guard message.name == "busy" else { return }
        if (message.body as? Bool) == true {
            if activity == nil { activity = ProcessInfo.processInfo.beginActivity(options: .userInitiatedAllowingIdleSystemSleep, reason: "Cutroom is working") }
        } else if let a = activity {
            ProcessInfo.processInfo.endActivity(a)
            activity = nil
        }
    }

    func connect() {
        Task {
            var ok = await ping()
            if !ok, let p = startServer() {
                server = p
                watch(p)
                let deadline = Date().addingTimeInterval(8)
                while !ok, p.isRunning, Date() < deadline {
                    try? await Task.sleep(nanoseconds: 200_000_000)
                    ok = await ping()
                }
            }
            if ok { web.load(URLRequest(url: base)) } else { failed() }
        }
    }

    func watch(_ p: Process) { // a server this app started comes straight back if it dies (a crash, or killed to load new code); the page carries on
        p.terminationHandler = { [weak self] dead in
            Task { @MainActor in
                guard let self, self.server === dead else { return } // quitting, or given up on: server was cleared first
                self.server = nil
                if await ping() { return } // something else answers on the port now
                if let n = startServer() { self.server = n; self.watch(n) }
            }
        }
    }

    func failed() {
        let s = server
        server = nil
        s?.terminate()
        let log = String(decoding: (try? Data(contentsOf: logURL)) ?? Data(), as: UTF8.self)
        let a = alert("Cutroom's server isn't answering", ["Retry", "Quit"])
        a.informativeText = log.split(separator: "\n").suffix(12).joined(separator: "\n") + "\n\n" + logURL.path
        if a.runModal() == .alertFirstButtonReturn { connect() } else { NSApp.terminate(nil) }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ app: NSApplication) -> Bool { true }

    // Files dropped on the Dock icon or opened with Cutroom from Finder: imported into the library
    func application(_ application: NSApplication, open urls: [URL]) {
        pending += urls.filter(\.isFileURL)
        if ready { importPending() }
    }

    func importPending() {
        let urls = pending
        pending = []
        guard !urls.isEmpty else { return }
        Task { _ = await importPaths(urls, fallback: false) }
    }

    /// Imports files by path (the server clones them). Returns the ones it couldn't: with fallback, the caller hands those
    /// to the page to upload instead (a folder macOS hasn't let the server read yet, say).
    func importPaths(_ urls: [URL], fallback: Bool) async -> [URL] {
        var n = 0, failed: [URL] = [], why = ""
        let files = expand(urls)
        for u in files {
            var req = URLRequest(url: base.appendingPathComponent("api/import_path"), cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 900)
            req.httpMethod = "POST"
            req.setValue("1", forHTTPHeaderField: "X-Cutroom") // the server's write guard
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try? JSONSerialization.data(withJSONObject: ["path": u.path])
            let res = try? await URLSession.shared.data(for: req)
            if let (_, r) = res, (r as? HTTPURLResponse)?.statusCode == 200 {
                n += 1
                if files.count > 1 { _ = try? await web.evaluateJavaScript("loadMedia().then(() => toast('Imported \(n) of \(files.count)…'))") } // each card shows as it lands
                continue
            }
            if why.isEmpty, let (data, _) = res {
                why = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["error"] as? String ?? ""
            }
            failed.append(u)
        }
        var msg = n == files.count ? "Imported \(n) file\(n == 1 ? "" : "s")" : fallback ? "Imported \(n) file\(n == 1 ? "" : "s"); uploading the rest"
            : "Imported \(n) of \(files.count) files" + (why.isEmpty ? "" : ": \(why)")
        if files.isEmpty { msg = "No media files there" }
        let js = String(decoding: (try? JSONSerialization.data(withJSONObject: [msg])) ?? Data("[\"\"]".utf8), as: UTF8.self)
        _ = try? await web.evaluateJavaScript("loadMedia().then(() => toast(\(js)[0]))")
        return failed
    }

    // The page saves 400 ms after an edit: quitting inside that window lost the edit. Let it save first (2 s at most).
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard ready, let web else { return .terminateNow }
        var answered = false
        let go = { if !answered { answered = true; NSApp.reply(toApplicationShouldTerminate: true) } }
        web.callAsyncJavaScript("await flushSave()", in: nil, in: .page) { _ in go() }
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { go() }
        return .terminateLater
    }

    func applicationWillTerminate(_ note: Notification) {
        guard let p = server, p.isRunning else { return }
        server = nil // not restarted by watch()
        let kids = Process() // its ffmpeg / whisper children first: they would outlive the server otherwise
        kids.executableURL = URL(fileURLWithPath: "/usr/bin/pkill")
        kids.arguments = ["-TERM", "-P", String(p.processIdentifier)]
        if (try? kids.run()) != nil { kids.waitUntilExit() }
        p.terminate()
    }

    // MARK: menus

    func mainMenu() -> NSMenu {
        let bar = NSMenu()
        func menu(_ title: String, _ items: [NSMenuItem]) -> NSMenu {
            let m = NSMenu(title: title)
            items.forEach(m.addItem)
            let host = NSMenuItem()
            host.submenu = m
            bar.addItem(host)
            return m
        }
        func item(_ title: String, _ action: Selector, _ key: String = "", _ mods: NSEvent.ModifierFlags = .command, target: AnyObject? = nil) -> NSMenuItem {
            let i = NSMenuItem(title: title, action: action, keyEquivalent: key)
            i.keyEquivalentModifierMask = mods
            i.target = target // nil = first responder, so the page's text fields get Edit commands
            return i
        }
        _ = menu("Cutroom", [
            item("About Cutroom", #selector(NSApplication.orderFrontStandardAboutPanel(_:))),
            .separator(),
            item("Hide Cutroom", #selector(NSApplication.hide(_:)), "h"),
            item("Hide Others", #selector(NSApplication.hideOtherApplications(_:)), "h", [.command, .option]),
            item("Show All", #selector(NSApplication.unhideAllApplications(_:))),
            .separator(),
            item("Quit Cutroom", #selector(NSApplication.terminate(_:)), "q"),
        ])
        _ = menu("Edit", [
            item("Undo", Selector(("undo:")), "z"),
            item("Redo", Selector(("redo:")), "z", [.command, .shift]),
            .separator(),
            item("Cut", #selector(NSText.cut(_:)), "x"),
            item("Copy", #selector(NSText.copy(_:)), "c"),
            item("Paste", #selector(NSText.paste(_:)), "v"),
            item("Select All", #selector(NSText.selectAll(_:)), "a"),
        ])
        _ = menu("View", [
            item("Reload", #selector(reloadPage), "r", target: self),
            .separator(),
            item("Actual Size", #selector(zoomActual), "0", target: self),
            item("Zoom In", #selector(zoomIn), "=", target: self),
            item("Zoom Out", #selector(zoomOut), "-", target: self),
        ])
        NSApp.windowsMenu = menu("Window", [
            item("Close", #selector(NSWindow.performClose(_:)), "w"),
            item("Minimize", #selector(NSWindow.performMiniaturize(_:)), "m"),
            item("Zoom", #selector(NSWindow.performZoom(_:))),
            .separator(),
            item("Bring All to Front", #selector(NSApplication.arrangeInFront(_:))),
        ])
        return bar
    }

    @objc func reloadPage() { web.load(URLRequest(url: base)) } // always the editor, even after a stray navigation
    @objc func zoomActual() { web.pageZoom = 1 }
    @objc func zoomIn() { web.pageZoom = min(web.pageZoom * 1.1, 3) }
    @objc func zoomOut() { web.pageZoom = max(web.pageZoom / 1.1, 0.5) }

    // MARK: WKNavigationDelegate

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        ready = true
        importPending()
        guard webView.isHidden else { return }
        webView.isHidden = false
        window.makeFirstResponder(webView) // keyboard shortcuts work without a first click
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { webView.reload() }

    // MARK: WKUIDelegate: JS panels, file picker, window.open, microphone

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping @MainActor () -> Void) {
        _ = alert(message, ["OK"]).runModal()
        completionHandler()
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping @MainActor (Bool) -> Void) {
        completionHandler(alert(message, ["OK", "Cancel"]).runModal() == .alertFirstButtonReturn)
    }

    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?, initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping @MainActor (String?) -> Void) {
        let a = alert(prompt, ["OK", "Cancel"]), field = NSTextField(string: defaultText ?? "")
        field.frame = NSRect(x: 0, y: 0, width: 320, height: 24)
        a.accessoryView = field
        a.window.initialFirstResponder = field
        completionHandler(a.runModal() == .alertFirstButtonReturn ? field.stringValue : nil)
    }

    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping @MainActor ([URL]?) -> Void) {
        let lib = pickLibrary // "Import media": media files are cloned by path, not uploaded (see EditorView)
        pickLibrary = false
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.canChooseDirectories = parameters.allowsDirectories || lib
        panel.beginSheetModal(for: webView.window ?? window) { r in
            guard r == .OK, lib else { completionHandler(r == .OK ? panel.urls : nil); return }
            let page = panel.urls.filter { pageTypes.contains($0.pathExtension.lowercased()) }
            let mine = panel.urls.filter { !pageTypes.contains($0.pathExtension.lowercased()) }
            Task {
                let back = page + (mine.isEmpty ? [] : await self.importPaths(mine, fallback: true))
                completionHandler(back.isEmpty ? nil : back)
            }
        }
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction,
                 windowFeatures: WKWindowFeatures) -> WKWebView? {
        guard let url = navigationAction.request.url else { return nil }
        guard url.host == base.host, url.port == base.port, url.path.hasPrefix("/exports/") else {
            NSWorkspace.shared.open(url) // anything else goes to its default app
            return nil
        }
        let v = WKWebView(frame: .zero, configuration: configuration) // WebKit loads the request into it
        let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 960, height: 600),
                         styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        w.title = url.lastPathComponent
        w.contentView = v
        w.isReleasedWhenClosed = false
        w.delegate = self
        w.center()
        w.makeKeyAndOrderFront(nil)
        popups.append(w)
        return v
    }

    func windowWillClose(_ note: Notification) { popups.removeAll { $0 === note.object as? NSWindow } } // frees the player, stops playback

    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin, initiatedByFrame frame: WKFrameInfo,
                 type: WKMediaCaptureType, decisionHandler: @escaping @MainActor (WKPermissionDecision) -> Void) {
        decisionHandler(origin.host == base.host ? .grant : .deny) // voiceover recording; macOS still asks once per app
    }
}

MainActor.assumeIsolated {
    let app = NSApplication.shared
    let delegate = AppDelegate()
    app.delegate = delegate
    app.setActivationPolicy(.regular)
    app.run()
}
