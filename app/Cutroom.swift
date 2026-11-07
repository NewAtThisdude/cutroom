// Cutroom.app: a native window (AppKit + WKWebView) around Cutroom's local server.
// If nothing answers on the port it starts ~/cutroom/server.py, and on quit it stops only a server it started.
// Build: app/build.sh -> ~/Applications/Cutroom.app
import AppKit
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

@MainActor final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, WKUIDelegate, WKNavigationDelegate {
    var window: NSWindow!
    var web: WKWebView!
    var server: Process? // set only when this app started the server
    var popups: [NSWindow] = [] // window.open() targets, released on close

    func applicationDidFinishLaunching(_ note: Notification) {
        NSApp.appearance = NSAppearance(named: .darkAqua)
        NSWindow.allowsAutomaticWindowTabbing = false
        NSApp.mainMenu = mainMenu()
        let cfg = WKWebViewConfiguration()
        cfg.mediaTypesRequiringUserActionForPlayback = [] // the preview plays <video>s from code
        web = WKWebView(frame: .zero, configuration: cfg)
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

    func connect() {
        Task {
            var ok = await ping()
            if !ok, let p = startServer() {
                server = p
                let deadline = Date().addingTimeInterval(8)
                while !ok, p.isRunning, Date() < deadline {
                    try? await Task.sleep(nanoseconds: 200_000_000)
                    ok = await ping()
                }
            }
            if ok { web.load(URLRequest(url: base)) } else { failed() }
        }
    }

    func failed() {
        server?.terminate()
        server = nil
        let log = String(decoding: (try? Data(contentsOf: logURL)) ?? Data(), as: UTF8.self)
        let a = alert("Cutroom's server isn't answering", ["Retry", "Quit"])
        a.informativeText = log.split(separator: "\n").suffix(12).joined(separator: "\n") + "\n\n" + logURL.path
        if a.runModal() == .alertFirstButtonReturn { connect() } else { NSApp.terminate(nil) }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ app: NSApplication) -> Bool { true }

    func applicationWillTerminate(_ note: Notification) {
        guard let p = server, p.isRunning else { return }
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
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.canChooseDirectories = parameters.allowsDirectories
        panel.beginSheetModal(for: webView.window ?? window) { completionHandler($0 == .OK ? panel.urls : nil) }
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
