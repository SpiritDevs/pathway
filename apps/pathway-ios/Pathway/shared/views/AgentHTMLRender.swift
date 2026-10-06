import SwiftUI
import UIKit
import WebKit

/// A published HTML page in the feed, at the height that fits it at this width. Its web view
/// exists only while the row is on screen, so a long thread never holds many live pages.
struct AgentTranscriptHTMLRender: View {
    let render: PathwayHTMLRender
    let model: PathwayAgentThreadModel
    @State private var width = 0.0
    @State private var contentHeight: Double?
    @State private var visible = false
    @State private var showsFullScreen = false

    var body: some View {
        Group {
            if visible {
                AgentHTMLRenderDocument(render: render, model: model, nested: true,
                                        onContentHeight: { if contentHeight != $0 { contentHeight = $0 } },
                                        onExpand: { showsFullScreen = true })
            } else {
                Color.clear
            }
        }
        .frame(maxWidth: .infinity)
        .frame(height: render.frameHeight(width: width, contentHeight: contentHeight))
        .onGeometryChange(for: Double.self) { Double($0.size.width) } action: { width = $0 }
        .onScrollVisibilityChange(threshold: 0.01) { visible = $0 }
        .onDisappear { visible = false }
        .fullScreenCover(isPresented: $showsFullScreen) { AgentHTMLRenderFullScreen(render: render, model: model) }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("thread-html-render-\(render.attachmentID)")
    }
}

/// The page with a Done button and a 16 pt gutter in the page's background color, since pages
/// carry no horizontal padding of their own.
struct AgentHTMLRenderFullScreen: View {
    let render: PathwayHTMLRender
    let model: PathwayAgentThreadModel
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            AgentHTMLRenderDocument(render: render, model: model, nested: false)
                .padding(.horizontal, 16)
                .background(Color(uiColor: .systemBackground))
                .ignoresSafeArea(edges: .bottom)
                .navigationTitle(render.title)
                .navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
    }
}

/// Signs the page's URL and shows it, holding loading and failure in the same box. A failed load
/// retries once with a fresh URL, since the old one may have expired.
private struct AgentHTMLRenderDocument: View {
    let render: PathwayHTMLRender
    let model: PathwayAgentThreadModel
    let nested: Bool
    var onContentHeight: (Double) -> Void = { _ in }
    var onExpand: (() -> Void)?
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.colorSchemeContrast) private var contrast
    @State private var url: URL?
    @State private var loaded = false
    @State private var failed = false
    @State private var retried = false
    @State private var attempt = 0

    var body: some View {
        ZStack {
            if let url, !failed {
                PathwayHTMLRenderWebView(url: url, title: render.title, theme: theme, nested: nested,
                                         onLoad: { loaded = true }, onContentHeight: onContentHeight, onFailure: loadFailed)
                    .id(url)
                if !loaded { ProgressView() }
            } else if failed {
                Button(action: reload) {
                    VStack(spacing: 4) {
                        Label("Page unavailable", systemImage: "exclamationmark.triangle")
                        Text("Tap to reload").font(.caption)
                    }
                    .font(.subheadline).foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, maxHeight: .infinity).contentShape(.rect)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Page unavailable. Reload \(render.title)")
            } else if model.isSubscriptionReady {
                ProgressView()
            } else {
                Label("Page available when reconnected", systemImage: "network.slash")
                    .font(.subheadline).foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .overlay(alignment: .topTrailing) {
            if loaded, let onExpand {
                Button(action: onExpand) {
                    Image(systemName: "arrow.up.left.and.arrow.down.right")
                        .font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                        .frame(width: 28, height: 28)
                        .background(Color(uiColor: .systemBackground).opacity(0.85), in: .circle)
                        .overlay { Circle().stroke(Color(uiColor: .separator)) }
                        .frame(width: 44, height: 44).contentShape(.rect)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Open \(render.title) full screen")
                .accessibilityIdentifier("thread-html-render-expand-\(render.attachmentID)")
            }
        }
        .task(id: "\(attempt):\(model.isSubscriptionReady)") {
            guard url == nil, !failed else { return }
            do {
                let signed = try await model.htmlRenderURL(render)
                guard !Task.isCancelled else { return }
                url = signed
            } catch {
                guard !Task.isCancelled else { return }
                // Disconnected: wait for the subscription instead of showing a failure.
                failed = model.isSubscriptionReady
            }
        }
    }

    private var theme: PathwayHTMLRenderTheme {
        .current(UITraitCollection { traits in
            traits.userInterfaceStyle = colorScheme == .dark ? .dark : .light
            traits.accessibilityContrast = contrast == .increased ? .high : .normal
        })
    }

    private func loadFailed(retryWithFreshURL: Bool) {
        loaded = false
        if retried || !retryWithFreshURL { failed = true; return }
        retried = true
        url = nil
        attempt += 1
    }

    private func reload() {
        loaded = false
        failed = false
        retried = false
        url = nil
        attempt += 1
    }
}

/// One published page. The page is sandboxed by its response's CSP; this view keeps it in place:
/// no navigation away from its signed URL, no script-opened windows, and links the reader taps
/// open in the browser. Inside the feed it reports its content height and hands vertical drags it
/// cannot use to the feed.
struct PathwayHTMLRenderWebView: UIViewRepresentable {
    let url: URL
    let title: String
    let theme: PathwayHTMLRenderTheme
    let nested: Bool
    let onLoad: () -> Void
    let onContentHeight: (Double) -> Void
    let onFailure: (_ retryWithFreshURL: Bool) -> Void
    @Environment(\.openURL) private var openURL

    static let messageHandler = "pathwayHtmlRender"
    // Runs in a content world page scripts cannot reach, so only this script can post to the
    // handler. Measures as the server does. A top-level page has no parent, so its MCP Apps
    // `ui/open-link` requests arrive as messages to itself.
    static let bridgeScript = """
    (function(){var p=window.webkit&&window.webkit.messageHandlers.\(messageHandler),h,lastOverflow;if(!p)return;\
    function z(){var r=document.documentElement,v=Math.ceil(r.scrollHeight>r.clientHeight?r.scrollHeight:r.getBoundingClientRect().height);\
    var b=document.body,overflow=Math.max(r.scrollHeight,b?b.scrollHeight:0)>window.innerHeight+1||Math.max(r.scrollWidth,b?b.scrollWidth:0)>window.innerWidth+1;\
    if(overflow!==lastOverflow){lastOverflow=overflow;p.postMessage({overflow:overflow});}\
    if(v===h||!Number.isFinite(v)||!(v>0))return;h=v;p.postMessage({height:v});}\
    if(window.ResizeObserver){var o=new ResizeObserver(z);o.observe(document.documentElement);if(document.body)o.observe(document.body);}\
    window.addEventListener("load",z);window.addEventListener("resize",z);z();\
    window.addEventListener("message",function(e){var d=e.data,q=d&&d.params;if(e.source!==window||!d||d.jsonrpc!=="2.0"||d.method!=="ui/open-link")return;\
    if((typeof d.id==="string"||(typeof d.id==="number"&&Number.isFinite(d.id)))&&q&&typeof q.url==="string")p.postMessage({openLink:q.url,id:d.id});});})();
    """

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeUIView(context: Context) -> WKWebView {
        let view = Self.makeWebView(coordinator: context.coordinator)
        context.coordinator.load(view)
        return view
    }

    /// The configured web view, before its page loads.
    static func makeWebView(coordinator: Coordinator, configuration: WKWebViewConfiguration = .init()) -> WKWebView {
        let nested = coordinator.parent.nested
        configuration.websiteDataStore = .nonPersistent()
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
        configuration.allowsInlineMediaPlayback = true
        configuration.mediaTypesRequiringUserActionForPlayback = .all
        configuration.userContentController.addUserScript(WKUserScript(source: Self.bridgeScript, injectionTime: .atDocumentEnd,
                                                                        forMainFrameOnly: true, in: .defaultClient))
        configuration.userContentController.add(WeakMessageHandler(coordinator), contentWorld: .defaultClient, name: Self.messageHandler)
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.navigationDelegate = coordinator
        view.uiDelegate = coordinator
        view.allowsLinkPreview = false
        view.isOpaque = false
        view.backgroundColor = .clear
        view.scrollView.backgroundColor = .clear
        view.accessibilityLabel = coordinator.parent.title
        let tap = UITapGestureRecognizer(target: coordinator, action: #selector(Coordinator.tapped))
        tap.cancelsTouchesInView = false
        tap.delaysTouchesEnded = false
        tap.delegate = coordinator
        view.addGestureRecognizer(tap)
        if nested {
            view.scrollView.isScrollEnabled = false
            view.scrollView.bounces = false
            view.scrollView.showsVerticalScrollIndicator = false
            view.scrollView.showsHorizontalScrollIndicator = false
            view.scrollView.contentInsetAdjustmentBehavior = .never
            let handoff = UIPanGestureRecognizer(target: nil, action: nil)
            handoff.cancelsTouchesInView = false
            handoff.delegate = coordinator
            view.addGestureRecognizer(handoff)
            view.scrollView.panGestureRecognizer.require(toFail: handoff)
            coordinator.handoff = handoff
        }
        return view
    }

    @MainActor private final class WeakMessageHandler: NSObject, WKScriptMessageHandler {
        weak var coordinator: Coordinator?
        init(_ coordinator: Coordinator) { self.coordinator = coordinator }
        func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
            coordinator?.userContentController(controller, didReceive: message)
        }
    }

    func updateUIView(_ view: WKWebView, context: Context) {
        context.coordinator.parent = self
        context.coordinator.openURL = openURL
        context.coordinator.showTheme(in: view)
    }

    static func dismantleUIView(_ view: WKWebView, coordinator: Coordinator) {
        view.stopLoading()
        view.configuration.userContentController.removeAllScriptMessageHandlers()
        view.navigationDelegate = nil
        view.uiDelegate = nil
    }

    @MainActor final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler, UIGestureRecognizerDelegate {
        var parent: PathwayHTMLRenderWebView
        var openURL: OpenURLAction?
        weak var handoff: UIPanGestureRecognizer?
        /// The theme the loaded document shows; nil until it loads.
        private var shownTheme: PathwayHTMLRenderTheme?
        private var loadedTheme: PathwayHTMLRenderTheme?
        private var finished = false
        private var failed = false
        private var crashes = 0
        private var lastTap: TimeInterval?

        init(_ parent: PathwayHTMLRenderWebView) { self.parent = parent }

        func load(_ view: WKWebView) {
            let theme = parent.theme
            loadedTheme = theme
            shownTheme = nil
            finished = false
            view.load(URLRequest(url: URL(string: parent.url.absoluteString + theme.fragment) ?? parent.url))
        }

        func showTheme(in view: WKWebView) {
            guard let shown = shownTheme, shown != parent.theme else { return }
            shownTheme = parent.theme
            view.evaluateJavaScript(parent.theme.hostContextChangedScript, in: nil, in: .page, completionHandler: nil)
        }

        @objc func tapped() { lastTap = ProcessInfo.processInfo.systemUptime }

        /// Opens an http(s) URL in the browser, once per tap on the page; a page cannot open one by itself.
        func openExternally(_ url: URL?) -> Bool {
            guard let url, Self.externalURL(url.absoluteString) != nil, let openURL,
                  let lastTap, ProcessInfo.processInfo.systemUptime - lastTap < 2 else { return false }
            self.lastTap = nil
            openURL(url)
            return true
        }

        private func fail(retryWithFreshURL: Bool = true) {
            guard !failed else { return }
            failed = true
            parent.onFailure(retryWithFreshURL)
        }

        private static func withoutFragment(_ url: URL?) -> String? { url?.absoluteString.components(separatedBy: "#").first }

        // MARK: Messages from the bridge script

        func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
            guard message.name == PathwayHTMLRenderWebView.messageHandler, message.frameInfo.isMainFrame,
                  let body = message.body as? [String: Any] else { return }
            if let overflow = body["overflow"] as? Bool {
                message.webView?.scrollView.isScrollEnabled = !parent.nested || overflow
            } else if let height = Self.number(body["height"]), height > 0 {
                parent.onContentHeight(height)
            } else if let link = body["openLink"] as? String, let id = body["id"], id is String || Self.number(id) != nil,
                      openExternally(Self.externalURL(link)) {
                message.webView?.callAsyncJavaScript("window.postMessage(m, \"*\")",
                                                     arguments: ["m": ["jsonrpc": "2.0", "id": id, "result": [String: Any]()]],
                                                     in: nil, in: .page, completionHandler: nil)
            }
        }

        static func number(_ value: Any?) -> Double? {
            guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(), number.doubleValue.isFinite else { return nil }
            return number.doubleValue
        }

        static func externalURL(_ value: String) -> URL? {
            guard value.range(of: #"^https?://"#, options: [.regularExpression, .caseInsensitive]) != nil,
                  let url = URL(string: value), let host = url.host, !host.isEmpty else { return nil }
            return url
        }

        /// A sandbox directive must actually restrict the page to the allowed capabilities.
        /// A word in another directive, or allow-same-origin/top-navigation, does not isolate it.
        static func acceptsResponse(_ response: HTTPURLResponse, for url: URL) -> Bool {
            guard withoutFragment(response.url) == withoutFragment(url), (200..<300).contains(response.statusCode),
                  response.mimeType == "text/html", let csp = response.value(forHTTPHeaderField: "Content-Security-Policy") else { return false }
            let allowed = Set(["allow-scripts", "allow-forms", "allow-popups"])
            return csp.split(separator: ",").contains { policy in
                for directive in policy.split(separator: ";") {
                    let tokens = directive.lowercased().split(whereSeparator: { " \t\n\r\u{000C}".contains($0) }).map(String.init)
                    if tokens.first == "sandbox" { return tokens.dropFirst().allSatisfy { allowed.contains($0) } }
                }
                return false
            }
        }

        // MARK: Navigation

        func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                     decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy) -> Void) {
            let url = navigationAction.request.url
            guard let target = navigationAction.targetFrame else {
                // A new window: `target=_blank` on a tapped link.
                if navigationAction.navigationType == .linkActivated { _ = openExternally(url) }
                decisionHandler(.cancel)
                return
            }
            if target.isMainFrame {
                if Self.withoutFragment(url) == Self.withoutFragment(parent.url) { decisionHandler(.allow); return }
                if navigationAction.navigationType == .linkActivated { _ = openExternally(url) }
                decisionHandler(.cancel)
            } else {
                decisionHandler(["http", "https", "about", "data"].contains(url?.scheme?.lowercased() ?? "") ? .allow : .cancel)
            }
        }

        func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse,
                     decisionHandler: @escaping @MainActor @Sendable (WKNavigationResponsePolicy) -> Void) {
            guard navigationResponse.isForMainFrame else { decisionHandler(.allow); return }
            // Only a page the environment served inline and sandboxed; an expired token is a 403.
            let response = navigationResponse.response as? HTTPURLResponse
            if let response, Self.acceptsResponse(response, for: parent.url) {
                decisionHandler(.allow)
            } else {
                decisionHandler(.cancel)
                fail()
            }
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            finished = true
            shownTheme = loadedTheme
            showTheme(in: webView)
            parent.onLoad()
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: any Error) {
            loadFailed(error)
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: any Error) {
            loadFailed(error)
        }

        private func loadFailed(_ error: any Error) {
            let error = error as NSError
            guard !finished, !(error.domain == NSURLErrorDomain && error.code == NSURLErrorCancelled) else { return }
            fail()
        }

        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
            // Reload once; a page that keeps crashing its process is not reloaded forever.
            crashes += 1
            if crashes > 1 { fail(retryWithFreshURL: false) } else { load(webView) }
        }

        // MARK: Windows

        func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                     for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
            if navigationAction.navigationType == .linkActivated { _ = openExternally(navigationAction.request.url) }
            return nil
        }

        // MARK: Gestures

        func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer,
                               shouldRecognizeSimultaneouslyWith otherGestureRecognizer: UIGestureRecognizer) -> Bool { true }

        /// The handoff pan begins, failing the page's own scrolling, for a vertical drag the page
        /// cannot follow: down at its top or up at its bottom. The feed then scrolls instead.
        func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
            guard gestureRecognizer === handoff, let handoff, let scrollView = (handoff.view as? WKWebView)?.scrollView else { return true }
            guard scrollView.isScrollEnabled else { return false }
            let velocity = handoff.velocity(in: handoff.view)
            guard abs(velocity.y) > abs(velocity.x) else { return false }
            let top = -scrollView.adjustedContentInset.top
            let bottom = max(top, scrollView.contentSize.height - scrollView.bounds.height + scrollView.adjustedContentInset.bottom)
            return velocity.y > 0 ? scrollView.contentOffset.y <= top + 1 : scrollView.contentOffset.y >= bottom - 1
        }
    }
}
