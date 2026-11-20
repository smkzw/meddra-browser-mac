import AppKit
import WebKit

private struct LocalService: Decodable {
    let url: URL
    let port: Int
}

private final class MedDRAApp: NSObject, NSApplicationDelegate, NSWindowDelegate,
    WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandlerWithReply, WKDownloadDelegate
{
    private let title = "MedDRA Browser"
    private let window = NSWindow(
        contentRect: NSRect(x: 0, y: 0, width: 1440, height: 900),
        styleMask: [.titled, .closable, .miniaturizable, .resizable],
        backing: .buffered, defer: false
    )
    private var webView: WKWebView?
    private var workbenchReady = false
    private var serviceURL: URL?
    private var server: Process?
    private var parentPipe: Pipe?
    private var session: URL?
    private var exiting = false
    private var closing = false
    private var workbenchError: String?
    private struct SaveJob {
        let staged: URL
        let final: URL
        let requestURL: String
    }

    private var saves: [ObjectIdentifier: SaveJob] = [:]

    private var state: URL {
        if let override = ProcessInfo.processInfo.environment["MEDDRA_BROWSER_STATE_DIR"] {
            return URL(fileURLWithPath: override, isDirectory: true)
        }
        return FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/MedDRA Browser Mac/data", isDirectory: true)
    }

    private var log: URL { state.appendingPathComponent("startup.log") }

    func applicationDidFinishLaunching(_ notification: Notification) {
        window.title = title
        window.tabbingMode = .disallowed
        window.appearance = NSAppearance(named: .aqua)
        window.minSize = NSSize(width: 830, height: 580)
        if let screen = window.screen ?? NSScreen.main {
            let available = screen.visibleFrame.insetBy(dx: 18, dy: 22)
            let size = NSSize(width: min(1440, available.width), height: min(900, available.height))
            window.setContentSize(size)
        }
        window.delegate = self
        window.center()
        installMenu()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        start()
    }

    private func installMenu() {
        let menuBar = NSMenu()
        let appItem = NSMenuItem()
        let menu = NSMenu(title: title)
        menu.addItem(withTitle: "关于 MedDRA Browser", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        menu.addItem(withTitle: "查看启动日志", action: #selector(showLog), keyEquivalent: "")
        menu.addItem(.separator())
        menu.addItem(withTitle: "退出 MedDRA Browser", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        menu.items[1].target = self
        appItem.submenu = menu
        menuBar.addItem(appItem)

        let editItem = NSMenuItem()
        let edit = NSMenu(title: "编辑")
        edit.addItem(withTitle: "撤销", action: Selector(("undo:")), keyEquivalent: "z")
        edit.addItem(.separator())
        edit.addItem(withTitle: "剪切", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "复制", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "粘贴", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "全选", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = edit
        menuBar.addItem(editItem)
        let windowItem = NSMenuItem()
        let windowMenu = NSMenu(title: "窗口")
        windowMenu.addItem(withTitle: "关闭窗口", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        windowMenu.addItem(withTitle: "最小化", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        windowItem.submenu = windowMenu
        menuBar.addItem(windowItem)
        NSApp.windowsMenu = windowMenu
        NSApp.mainMenu = menuBar
    }

    private func showStatus(_ heading: String, _ detail: String, error: Bool = false) {
        let panel = NSView()
        panel.wantsLayer = true
        panel.layer?.backgroundColor = NSColor(srgbRed: 0.989, green: 0.973, blue: 0.95, alpha: 1).cgColor
        let label = NSTextField(labelWithString: heading)
        label.font = .systemFont(ofSize: 24, weight: .semibold)
        let message = NSTextField(wrappingLabelWithString: detail)
        message.font = .systemFont(ofSize: 15)
        message.textColor = .secondaryLabelColor
        message.alignment = .center
        message.preferredMaxLayoutWidth = 540
        let row = NSStackView()
        row.orientation = .horizontal
        row.spacing = 10
        if error {
            row.addArrangedSubview(NSButton(title: "重新启动", target: self, action: #selector(start)))
            row.addArrangedSubview(NSButton(title: "查看启动日志", target: self, action: #selector(showLog)))
        } else {
            let spinner = NSProgressIndicator()
            spinner.style = .spinning
            spinner.startAnimation(nil)
            row.addArrangedSubview(spinner)
        }
        let stack = NSStackView(views: [label, message, row])
        stack.orientation = .vertical
        stack.alignment = .centerX
        stack.spacing = 14
        stack.translatesAutoresizingMaskIntoConstraints = false
        panel.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.centerXAnchor.constraint(equalTo: panel.centerXAnchor),
            stack.centerYAnchor.constraint(equalTo: panel.centerYAnchor),
            stack.widthAnchor.constraint(lessThanOrEqualToConstant: 540)
        ])
        window.contentViewController = nil
        window.contentView = panel
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        if self.webView === webView, let serviceURL {
            showWorkbench(serviceURL)
        }
    }

    @objc private func showLog() {
        if FileManager.default.fileExists(atPath: log.path) {
            NSWorkspace.shared.open(log)
        } else {
            presentError("尚无启动日志。若提示文件缺失，请重新解压应用发行包。")
        }
    }

    @objc private func start() {
        guard server?.isRunning != true, !exiting else { return }
        cleanSession()
        workbenchError = nil
        showStatus("正在打开 MedDRA Browser", "正在启动本机词典服务。")
        #if arch(arm64)
        let arch = "arm64"
        #else
        let arch = "x86_64"
        #endif
        let files = FileManager.default
        guard let resources = Bundle.main.resourceURL else {
            showStatus("无法打开工作台", "应用资源目录缺失，请重新下载并完整解压。", error: true)
            return
        }
        let payload = resources.appendingPathComponent("app", isDirectory: true)
        let interpreter = payload.appendingPathComponent("tools/python/macos-\(arch)/bin/python3.13")
        guard files.isExecutableFile(atPath: interpreter.path) else {
            showStatus("找不到包内运行环境", "请重新下载 Mac App 压缩包并完整解压，再打开应用。", error: true)
            return
        }
        do {
            try files.createDirectory(at: state, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            let directory = files.temporaryDirectory.appendingPathComponent("meddra-\(UUID().uuidString)", isDirectory: true)
            try files.createDirectory(at: directory, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
            session = directory
            let ready = directory.appendingPathComponent("ready.json")
            try Data().write(to: log, options: .atomic)
            let output = try FileHandle(forWritingTo: log)
            defer { try? output.close() }
            let pipe = Pipe()
            let process = Process()
            process.executableURL = interpreter
            process.arguments = ["-I", "-B", "-X", "utf8", payload.appendingPathComponent("scripts/run_portable_server.py").path, "--native", ready.path]
            process.currentDirectoryURL = state
            var env = ProcessInfo.processInfo.environment
            env["MEDDRA_BROWSER_STATE_DIR"] = state.path
            env["MEDDRA_APP_STORE_MODE"] = Bundle.main.object(forInfoDictionaryKey: "MedDRAAppStoreCandidate") as? Bool == true ? "1" : "0"
            process.environment = env
            process.standardInput = pipe
            process.standardOutput = output
            process.standardError = output
            process.terminationHandler = { [weak self] stopped in
                DispatchQueue.main.async { self?.serverStopped(stopped) }
            }
            try process.run()
            server = process
            parentPipe = pipe
            waitForService(ready, process: process, deadline: .now() + .seconds(20))
        } catch {
            cleanSession()
            showStatus("无法启动本地服务", error.localizedDescription, error: true)
        }
    }

    private func waitForService(_ ready: URL, process: Process, deadline: DispatchTime) {
        guard server === process, process.isRunning, !exiting else { return }
        if let data = try? Data(contentsOf: ready),
            let service = try? JSONDecoder().decode(LocalService.self, from: data),
            service.url.scheme == "http", service.url.host == "127.0.0.1", service.url.port == service.port {
            showWorkbench(service.url)
        } else if DispatchTime.now() < deadline {
            DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(80)) { [weak self] in
                self?.waitForService(ready, process: process, deadline: deadline)
            }
        } else {
            stopServer()
        }
    }

    private func showWorkbench(_ url: URL, attempt: Int = 1) {
        guard !exiting else { return }
        webView?.configuration.userContentController.removeScriptMessageHandler(forName: "chooseDictionary")
        serviceURL = url
        workbenchReady = false
        let configuration = WKWebViewConfiguration()
        configuration.userContentController.addScriptMessageHandler(self, contentWorld: .page, name: "chooseDictionary")
        let view = WKWebView(frame: window.contentLayoutRect, configuration: configuration)
        view.autoresizingMask = [.width, .height]
        view.navigationDelegate = self
        view.uiDelegate = self
        webView = view
        let controller = NSViewController()
        controller.view = view
        window.contentViewController = controller
        view.load(URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 8))
        waitForWorkbench(view, url: url, attempt: attempt, deadline: .now() + .seconds(8))
    }

    private func waitForWorkbench(_ view: WKWebView, url: URL, attempt: Int, deadline: DispatchTime) {
        guard webView === view, !workbenchReady, !exiting else { return }
        if DispatchTime.now() >= deadline {
            if attempt == 1 {
                showWorkbench(url, attempt: 2)
            } else {
                let message = "本地服务已启动，工作台页面加载超时。请重新启动，或查看启动日志。"
                workbenchError = message
                if let output = try? FileHandle(forWritingTo: log) {
                    _ = try? output.seekToEnd()
                    try? output.write(contentsOf: Data("\n\(message)\n".utf8))
                    try? output.close()
                }
                stopServer()
            }
            return
        }
        view.evaluateJavaScript("document.readyState === 'complete' && document.getElementById('root')?.childElementCount > 0") { [weak self, weak view] value, _ in
            guard let self, let view, self.webView === view, !self.exiting,
                  self.workbenchError == nil, (value as? Bool) == true else { return }
            if !self.workbenchReady {
                self.workbenchReady = true
                if self.window.isVisible && !self.window.isMiniaturized {
                    self.window.makeKeyAndOrderFront(nil)
                }
                self.window.makeFirstResponder(view)
                view.needsDisplay = true
                self.window.displayIfNeeded()
            }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(240)) { [weak self, weak view] in
            if let view {
                self?.waitForWorkbench(view, url: url, attempt: attempt, deadline: deadline)
            }
        }
    }

    private func cleanSession() {
        webView?.configuration.userContentController.removeScriptMessageHandler(forName: "chooseDictionary")
        webView = nil
        workbenchReady = false
        serviceURL = nil
        if let session {
            try? FileManager.default.removeItem(at: session)
        }
        session = nil
    }

    private func serverStopped(_ process: Process) {
        guard server === process else { return }
        server = nil
        parentPipe = nil
        cleanSession()
        if exiting {
            NSApp.reply(toApplicationShouldTerminate: true)
        } else if let workbenchError {
            showStatus("无法载入工作台", workbenchError, error: true)
        } else {
            let message = (try? String(contentsOf: log, encoding: .utf8))?
                .split(whereSeparator: \.isNewline).last(where: { $0.hasPrefix("MedDRA Browser 启动失败") })
            showStatus("本地服务已停止", message.map(String.init) ?? "可以重新启动，或查看启动日志了解原因。", error: true)
        }
    }

    private func stopServer() {
        guard let process = server, process.isRunning else { return }
        try? parentPipe?.fileHandleForWriting.close()
        DispatchQueue.main.asyncAfter(deadline: .now() + .seconds(5)) { [weak self] in
            if self?.server === process && process.isRunning { process.terminate() }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + .seconds(7)) { [weak self] in
            if self?.server === process && process.isRunning { kill(process.processIdentifier, SIGKILL) }
        }
    }

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        NSApp.terminate(nil)
        return false
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if exiting || closing { return .terminateLater }
        if let view = webView {
            closing = true
            view.evaluateJavaScript("window.__meddraHasUnsavedWork === true") { [weak self] value, error in
                guard let self, self.closing else { return }
                if (value as? Bool) == true || error != nil {
                    self.confirmQuit()
                } else {
                    self.finishQuit()
                }
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + .seconds(2)) { [weak self] in
                if self?.closing == true && self?.window.attachedSheet == nil {
                    self?.confirmQuit()
                }
            }
            return .terminateLater
        }
        guard server?.isRunning == true else { return .terminateNow }
        exiting = true
        stopServer()
        return .terminateLater
    }

    private func confirmQuit() {
        // The timeout and the web callback can both arrive. Only one confirmation is needed.
        guard closing, !exiting else { return }
        closing = false
        let alert = NSAlert()
        alert.messageText = "退出 MedDRA Browser？"
        alert.informativeText = "请确认已导出需要保留的编码审阅结果。退出将关闭本地服务。"
        alert.addButton(withTitle: "继续审阅")
        alert.addButton(withTitle: "退出")
        alert.beginSheetModal(for: window) { [weak self] result in
            if result == .alertSecondButtonReturn {
                self?.finishQuit()
            } else {
                NSApp.reply(toApplicationShouldTerminate: false)
            }
        }
    }

    private func finishQuit() {
        closing = false
        exiting = true
        if server?.isRunning == true {
            stopServer()
        } else {
            NSApp.reply(toApplicationShouldTerminate: true)
        }
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        window.makeKeyAndOrderFront(nil)
        return true
    }

    private func isLocal(_ url: URL?) -> Bool {
        guard let url, let serviceURL else { return false }
        return url.scheme == serviceURL.scheme && url.host == serviceURL.host && url.port == serviceURL.port
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage,
                               replyHandler: @escaping (Any?, String?) -> Void) {
        guard message.name == "chooseDictionary", message.frameInfo.isMainFrame,
              isLocal(message.frameInfo.request.url) else {
            replyHandler(nil, "文件夹选择器只供本机工作台使用。")
            return
        }
        let panel = NSOpenPanel()
        panel.message = "选择 MedDRA ASCII 词典文件夹或其上级文件夹"
        panel.prompt = "选择"
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.beginSheetModal(for: window) { response in
            replyHandler(response == .OK ? (panel.url?.path as Any? ?? NSNull()) : NSNull(), nil)
        }
    }

    func webView(_ view: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        guard frame.isMainFrame, isLocal(frame.request.url) else {
            completionHandler(nil)
            return
        }
        let panel = NSOpenPanel()
        panel.prompt = "导入"
        panel.canChooseFiles = !parameters.allowsDirectories
        panel.canChooseDirectories = parameters.allowsDirectories
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.beginSheetModal(for: window) { response in
            completionHandler(response == .OK ? panel.urls : nil)
        }
    }

    func webView(_ view: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if action.shouldPerformDownload, isLocal(action.sourceFrame.request.url) {
            decisionHandler(.download)
        } else {
            decisionHandler(isLocal(action.request.url) ? .allow : .cancel)
        }
    }

    func webView(_ view: WKWebView, decidePolicyFor response: WKNavigationResponse,
                 decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        guard isLocal(response.response.url) else { decisionHandler(.cancel); return }
        let http = response.response as? HTTPURLResponse
        let attachment = http?.value(forHTTPHeaderField: "Content-Disposition")?.lowercased().hasPrefix("attachment") == true
        decisionHandler(attachment || !response.canShowMIMEType ? .download : .allow)
    }

    func webView(_ view: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        download.delegate = self
    }

    func webView(_ view: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
        download.delegate = self
    }

    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse,
                  suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
        let save = NSSavePanel()
        save.nameFieldStringValue = suggestedFilename
        let requestURL = download.originalRequest?.url?.absoluteString ?? response.url?.absoluteString ?? ""
        save.beginSheetModal(for: window) { [weak self] result in
            guard let self, result == .OK, let destination = save.url else {
                completionHandler(nil)
                self?.reportDownload(requestURL, saved: false)
                return
            }
            let staged = destination.deletingLastPathComponent().appendingPathComponent(".meddra-\(UUID().uuidString).tmp")
            self.saves[ObjectIdentifier(download)] = SaveJob(staged: staged, final: destination, requestURL: requestURL)
            completionHandler(staged)
        }
    }

    func downloadDidFinish(_ download: WKDownload) {
        guard let job = saves.removeValue(forKey: ObjectIdentifier(download)) else { return }
        let files = FileManager.default
        defer { try? files.removeItem(at: job.staged) }
        do {
            if files.fileExists(atPath: job.final.path) {
                _ = try files.replaceItemAt(job.final, withItemAt: job.staged)
            } else {
                try files.moveItem(at: job.staged, to: job.final)
            }
            reportDownload(job.requestURL, saved: true)
        } catch {
            reportDownload(job.requestURL, saved: false)
            presentError("无法保存导出文件。\n\(error.localizedDescription)")
        }
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        if let job = saves.removeValue(forKey: ObjectIdentifier(download)) {
            try? FileManager.default.removeItem(at: job.staged)
            reportDownload(job.requestURL, saved: false)
            presentError("导出未完成。\n\(error.localizedDescription)")
        } else if let requestURL = download.originalRequest?.url?.absoluteString {
            reportDownload(requestURL, saved: false)
        }
    }

    private func reportDownload(_ requestURL: String, saved: Bool) {
        let event = saved ? "meddra:native-download-saved" : "meddra:native-download-cancelled"
        webView?.callAsyncJavaScript(
            "window.dispatchEvent(new CustomEvent(eventName, { detail: requestURL }));",
            arguments: ["eventName": event, "requestURL": requestURL],
            in: nil, in: .page, completionHandler: nil
        )
    }

    func webView(_ view: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let alert = NSAlert()
        alert.messageText = message
        alert.addButton(withTitle: "继续")
        alert.addButton(withTitle: "取消")
        alert.beginSheetModal(for: window) { completionHandler($0 == .alertFirstButtonReturn) }
    }

    func webView(_ view: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let alert = NSAlert()
        alert.messageText = message
        alert.addButton(withTitle: "好")
        alert.beginSheetModal(for: window) { _ in completionHandler() }
    }

    private func presentError(_ message: String) {
        let alert = NSAlert()
        alert.messageText = message
        alert.addButton(withTitle: "好")
        alert.beginSheetModal(for: window)
    }
}

let app = NSApplication.shared
private let delegate = MedDRAApp()
app.setActivationPolicy(.regular)
app.delegate = delegate
app.run()
