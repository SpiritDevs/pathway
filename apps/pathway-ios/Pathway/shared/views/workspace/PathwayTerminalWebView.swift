import SwiftUI
import WebKit

/// Keeps terminal output outside SwiftUI state and drains it in ordered bridge batches.
@MainActor
final class PathwayTerminalRenderer {
    private weak var webView: WKWebView?
    private var ready = false
    private var draining = false
    private var failed = false
    private var enabled = false
    private var pending: [[String: Any]] = []
    private var pendingBytes = 0
    private var drainTask: Task<Void, Never>?
    var columns = 80
    var rows = 24
    private var inputTask: Task<Void, Never>?
    var onError: (String) -> Void = { _ in }

    func attach(_ view: WKWebView) { webView = view; ready = false; failed = false }
    func didBecomeReady() { ready = true; enqueue(["kind": "enabled", "enabled": enabled]); drain() }
    func setEnabled(_ value: Bool) {
        guard value != enabled else { return }
        enabled = value; enqueue(["kind": "enabled", "enabled": value])
    }
    func write(_ text: String) { enqueue(["kind": "write", "data": text], bytes: text.utf8.count) }
    func reset(_ history: String = "") {
        failed = false; pending = []; pendingBytes = 0
        enqueue(["kind": "reset", "data": history], bytes: history.utf8.count)
        enqueue(["kind": "enabled", "enabled": enabled])
    }
    func copySelection() { enqueue(["kind": "copy"]) }
    func focus() { enqueue(["kind": "focus"]) }
    func paste(_ text: String) { guard enabled else { return }; enqueue(["kind": "paste", "data": text], bytes: text.utf8.count) }
    func sendInput(_ text: String, handler: @escaping @MainActor (String) async -> Void) {
        guard enabled, !text.isEmpty else { return }
        let previous = inputTask
        inputTask = Task { @MainActor in
            await previous?.value
            guard !Task.isCancelled else { return }
            // terminal.write bounds each message to 65,536 characters.
            var remaining = text[...]
            while !remaining.isEmpty {
                let chunk = remaining.prefix(32_768)
                await handler(String(chunk))
                remaining = remaining.dropFirst(chunk.count)
                if Task.isCancelled { return }
            }
        }
    }
    func dispose() {
        ready = false; enabled = false
        drainTask?.cancel(); drainTask = nil; inputTask?.cancel(); inputTask = nil
        pending = []; pendingBytes = 0
        webView?.evaluateJavaScript("window.pathwayTerminal?.dispose()", completionHandler: nil)
        webView = nil
    }
    private func enqueue(_ command: [String: Any], bytes: Int = 0) {
        guard !failed else { return }
        guard pendingBytes + bytes <= 4 * 1024 * 1024 else {
            failed = true; pending = []; pendingBytes = 0
            onError("Terminal display could not keep up. Reattach to reload the current screen.")
            return
        }
        pending.append(command); pendingBytes += bytes; drain()
    }
    private func drain() {
        guard ready, !draining, !pending.isEmpty, let webView else { return }
        let commands = pending
        pending = []; pendingBytes = 0; draining = true
        drainTask = Task { @MainActor [weak self, weak webView] in
            guard let self, let webView else { return }
            defer { self.draining = false; self.drain() }
            do {
                _ = try await webView.callAsyncJavaScript("window.pathwayTerminal.receive(commands)", arguments: ["commands": commands], in: nil, contentWorld: .page)
            } catch {
                guard !Task.isCancelled else { return }
                self.failed = true
                self.onError("Terminal renderer failed: \(error.localizedDescription)")
            }
        }
    }
}

struct PathwayTerminalWebView: UIViewRepresentable {
    let renderer: PathwayTerminalRenderer
    let enabled: Bool
    let onInput: @MainActor (String) async -> Void
    let onResize: @MainActor (Int, Int) async -> Void
    let onError: (String) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(self) }
    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        config.preferences.javaScriptCanOpenWindowsAutomatically = false
        config.setURLSchemeHandler(context.coordinator.assets, forURLScheme: "pathway-terminal")
        config.userContentController.add(context.coordinator, name: "terminal")
        let view = WKWebView(frame: .zero, configuration: config)
        view.navigationDelegate = context.coordinator
        view.isOpaque = true; view.backgroundColor = UIColor(red: 20/255, green: 22/255, blue: 25/255, alpha: 1)
        view.scrollView.isScrollEnabled = false
        renderer.onError = onError; renderer.attach(view); renderer.setEnabled(enabled)
        view.load(URLRequest(url: URL(string: "pathway-terminal://bundle/index.html")!))
        return view
    }
    func updateUIView(_ uiView: WKWebView, context: Context) {
        context.coordinator.parent = self
        renderer.onError = onError; renderer.setEnabled(enabled)
    }
    static func dismantleUIView(_ uiView: WKWebView, coordinator: Coordinator) {
        coordinator.parent.renderer.dispose()
        coordinator.resizeTask?.cancel()
        uiView.stopLoading()
        uiView.configuration.userContentController.removeScriptMessageHandler(forName: "terminal")
        uiView.navigationDelegate = nil
    }

    @MainActor final class Coordinator: NSObject, WKNavigationDelegate, WKScriptMessageHandler {
        var parent: PathwayTerminalWebView
        let assets = PathwayTerminalAssets()
        var resizeTask: Task<Void, Never>?
        init(_ parent: PathwayTerminalWebView) { self.parent = parent }
        func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
            guard message.name == "terminal", message.frameInfo.isMainFrame,
                  let url = message.frameInfo.request.url,
                  url.scheme == "pathway-terminal", url.host == "bundle", url.path == "/index.html",
                  let fields = message.body as? [String: Any], let type = fields["type"] as? String else { return }
            switch type {
            case "ready": parent.renderer.didBecomeReady()
            case "input":
                if let data = fields["data"] as? String, data.utf8.count <= 4 * 1024 * 1024 { parent.renderer.sendInput(data, handler: parent.onInput) }
            case "resize":
                if let cols = fields["cols"] as? Int, let rows = fields["rows"] as? Int,
                   (1...1000).contains(cols), (1...500).contains(rows) {
                    parent.renderer.columns = cols; parent.renderer.rows = rows
                    let handler = parent.onResize
                    let previous = resizeTask
                    resizeTask = Task { @MainActor in await previous?.value; guard !Task.isCancelled else { return }; await handler(cols, rows) }
                }
            case "copy":
                if let text = fields["data"] as? String, !text.isEmpty, text.utf8.count <= 4 * 1024 * 1024 { UIPasteboard.general.string = text }
            case "error": parent.onError(fields["message"] as? String ?? "Terminal renderer failed")
            default: break
            }
        }
        func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy) -> Void) {
            let url = navigationAction.request.url
            let allowed = navigationAction.targetFrame?.isMainFrame == true && url?.scheme == "pathway-terminal" && url?.host == "bundle" && url?.path == "/index.html"
            decisionHandler(allowed ? .allow : .cancel)
        }
        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { parent.onError(error.localizedDescription) }
        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { parent.onError("Terminal renderer stopped. Reopen the terminal view to reconnect.") }
    }
}

/// Serves only packaged assets, including WASM fetches; there is no network transport.
@MainActor
final class PathwayTerminalAssets: NSObject, WKURLSchemeHandler {
    private let root = Bundle.main.url(forResource: "PathwayTerminal", withExtension: "bundle")
    func webView(_ webView: WKWebView, start urlSchemeTask: any WKURLSchemeTask) {
        guard let root, let requestURL = urlSchemeTask.request.url,
              requestURL.scheme == "pathway-terminal", requestURL.host == "bundle",
              let file = Self.assetURL(root: root, path: requestURL.path) else {
            urlSchemeTask.didFailWithError(URLError(.fileDoesNotExist)); return
        }
        do {
            let data = try Data(contentsOf: file, options: .mappedIfSafe)
            let mime: String
            switch file.pathExtension { case "html": mime = "text/html"; case "js": mime = "application/javascript"; case "wasm": mime = "application/wasm"; case "woff2": mime = "font/woff2"; default: mime = "application/octet-stream" }
            guard let response = HTTPURLResponse(url: requestURL, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": mime, "Content-Length": String(data.count), "Access-Control-Allow-Origin": "*"]) else { throw URLError(.badServerResponse) }
            urlSchemeTask.didReceive(response)
            urlSchemeTask.didReceive(data); urlSchemeTask.didFinish()
        } catch { urlSchemeTask.didFailWithError(error) }
    }
    func webView(_ webView: WKWebView, stop urlSchemeTask: any WKURLSchemeTask) { }
    static func assetURL(root: URL, path: String) -> URL? {
        guard path == "/index.html" || path.hasPrefix("/assets/"),
              !path.split(separator: "/").contains("..") else { return nil }
        let file = root.appendingPathComponent(String(path.dropFirst())).standardizedFileURL
        guard file.path.hasPrefix(root.standardizedFileURL.path + "/") else { return nil }
        return file
    }
}
