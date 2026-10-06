import Foundation
import Network
import SwiftUI
@testable import Pathway
import Testing
import UIKit
import WebKit

/// Real WebKit, off screen, loading pages over loopback HTTP with the environment's sandbox
/// headers, so these cover what unit tests of the Swift alone cannot.
@MainActor
struct PathwayHTMLRenderWebViewTests {
    private static let sandboxed = ["Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": "sandbox allow-scripts allow-forms allow-popups"]
    private static let tallPage = "<!doctype html><meta name=viewport content=\"width=device-width\"><style>html,body{margin:0}</style><div style=\"height:500px\"></div>"

    @Test(.timeLimit(.minutes(1))) func reportsTheContentHeightOfASandboxedPage() async throws {
        let server = try await PageServer.start(pages: ["/api/assets/token/Chart.html": (Self.tallPage, Self.sandboxed)])
        defer { server.stop() }
        #expect(await load("/api/assets/token/Chart.html", server: server) == ["load", "height 500"])
    }

    @Test(.timeLimit(.minutes(1))) func fittedPagesLeaveScrollingToTheFeed() async throws {
        let server = try await PageServer.start(pages: ["/api/assets/token/Chart.html": (Self.tallPage, Self.sandboxed)])
        defer { server.stop() }
        #expect(await load("/api/assets/token/Chart.html", server: server, frameHeight: 500, expectedScrollEnabled: false) == ["load", "height 500"])
    }

    @Test(.timeLimit(.minutes(1))) func refusesAPageServedWithoutTheSandbox() async throws {
        let server = try await PageServer.start(pages: [
            "/api/assets/token/Plain.html": (Self.tallPage, ["Content-Type": "text/html"]),
            "/api/assets/token/Download.html": (Self.tallPage, ["Content-Type": "application/octet-stream", "Content-Security-Policy": "default-src 'none'; sandbox"]),
            "/api/assets/token/FalseSandbox.html": (Self.tallPage, ["Content-Type": "text/html", "Content-Security-Policy": "default-src https://sandbox.example"]),
            "/api/assets/token/SameOrigin.html": (Self.tallPage, ["Content-Type": "text/html", "Content-Security-Policy": "sandbox allow-scripts allow-same-origin"])
        ])
        defer { server.stop() }
        #expect(await load("/api/assets/token/Plain.html", server: server) == ["failure"])
        #expect(await load("/api/assets/token/Download.html", server: server) == ["failure"])
        #expect(await load("/api/assets/token/FalseSandbox.html", server: server) == ["failure"])
        #expect(await load("/api/assets/token/SameOrigin.html", server: server) == ["failure"])
    }

    @Test(.timeLimit(.minutes(1))) func bridgeForwardsLinkRequestsAndThePageReceivesTheTheme() async throws {
        // The page reports its origin and whether it can see the bridge's handler, then answers a
        // theme notification with a link request, the way the published bootstrap checks its source.
        let page = """
        <!doctype html><html><body><p>Page</p><script>
        window.addEventListener("message", function (e) {
          var d = e.data;
          if (e.source !== window.parent || !d || d.method !== "ui/notifications/host-context-changed") return;
          window.parent.postMessage({jsonrpc: "2.0", id: "theme", method: "ui/open-link",
            params: {url: "https://example.com/" + d.params.theme + "/" + d.params.styles.variables["--chart-2"].slice(1)}}, "*");
        });
        window.addEventListener("load", function () {
          for (var id of [true, null, NaN, Infinity]) window.postMessage({jsonrpc: "2.0", id: id,
            method: "ui/open-link", params: {url: "https://example.com/invalid"}}, "*");
          var reachable = typeof (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.pathwayHtmlRender);
          window.parent.postMessage({jsonrpc: "2.0", id: 7, method: "ui/open-link",
            params: {url: "https://example.com/" + self.origin + "/" + reachable}}, "*");
        });
        </script></body></html>
        """
        let server = try await PageServer.start(pages: ["/api/assets/token/Bridge.html": (page, Self.sandboxed)])
        defer { server.stop() }
        let (events, continuation) = AsyncStream.makeStream(of: String.self)
        let recorder = Recorder(continuation: continuation)
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.userContentController.addUserScript(WKUserScript(source: PathwayHTMLRenderWebView.bridgeScript, injectionTime: .atDocumentEnd,
                                                                        forMainFrameOnly: true, in: .defaultClient))
        configuration.userContentController.add(recorder, contentWorld: .defaultClient, name: PathwayHTMLRenderWebView.messageHandler)
        let view = WKWebView(frame: CGRect(x: 0, y: 0, width: 320, height: 200), configuration: configuration)
        defer { view.stopLoading(); configuration.userContentController.removeAllScriptMessageHandlers() }
        view.load(URLRequest(url: server.url("/api/assets/token/Bridge.html")))
        var iterator = events.makeAsyncIterator()
        func nextLink() async -> String? {
            while let event = await iterator.next(isolation: #isolation) { if event.hasPrefix("link") { return event } }
            return nil
        }
        // Sandboxed: an opaque origin, and the page's own scripts cannot post to the handler.
        #expect(await nextLink() == "link https://example.com/null/undefined 7")
        view.evaluateJavaScript(PathwayHTMLRenderTheme.current(UITraitCollection(userInterfaceStyle: .dark)).hostContextChangedScript,
                                in: nil, in: .page, completionHandler: nil)
        #expect(await nextLink() == "link https://example.com/dark/2dd4bf theme")
        withExtendedLifetime((view, recorder)) {}
    }

    @Test func responseRequiresTheSignedPageAndARestrictiveSandboxDirective() throws {
        let url = try #require(URL(string: "https://environment.example/api/assets/token/Chart.html"))
        func accepts(_ policy: String, status: Int = 200, mime: String = "text/html", responseURL: URL? = nil) -> Bool {
            let response = HTTPURLResponse(url: responseURL ?? url, statusCode: status, httpVersion: "HTTP/1.1",
                                           headerFields: ["Content-Type": mime, "Content-Security-Policy": policy])!
            return PathwayHTMLRenderWebView.Coordinator.acceptsResponse(response, for: url)
        }
        #expect(accepts("sandbox allow-scripts allow-forms allow-popups"))
        #expect(accepts("default-src 'none'; SANDBOX"))
        #expect(!accepts("default-src https://sandbox.example"))
        #expect(!accepts("sandbox\u{00A0}allow-scripts"))
        #expect(!accepts("sandbox allow-scripts allow-same-origin"))
        #expect(!accepts("sandbox allow-top-navigation"))
        #expect(!accepts("sandbox allow-popups-to-escape-sandbox"))
        #expect(!accepts("sandbox allow-same-origin; sandbox"))
        #expect(!accepts("sandbox", status: 403))
        #expect(!accepts("sandbox", mime: "application/octet-stream"))
        #expect(!accepts("sandbox", responseURL: URL(string: "https://other.example/Chart.html")))
    }

    @Test func nativeBridgeRejectsBooleanNonfiniteNumbersAndNonHttpLinks() {
        for value: Any in [true, false, Double.nan, Double.infinity, "412"] {
            #expect(PathwayHTMLRenderWebView.Coordinator.number(value) == nil)
        }
        #expect(PathwayHTMLRenderWebView.Coordinator.number(412) == 412)
        for link in ["file:///etc/passwd", "javascript:alert(1)", "https://", "about:blank", "https:example.com"] {
            #expect(PathwayHTMLRenderWebView.Coordinator.externalURL(link) == nil)
        }
        #expect(PathwayHTMLRenderWebView.Coordinator.externalURL("https://example.com/a") != nil)
    }

    @Test func externalLinksRequireATapAndConsumeItOnlyOnce() {
        let coordinator = PathwayHTMLRenderWebView.Coordinator(parent())
        var opened: [URL] = []
        coordinator.openURL = OpenURLAction { url in opened.append(url); return .handled }
        let url = URL(string: "https://example.com/a")!
        #expect(!coordinator.openExternally(url))
        coordinator.tapped()
        #expect(!coordinator.openExternally(URL(string: "file:///etc/passwd")))
        #expect(coordinator.openExternally(url))
        #expect(!coordinator.openExternally(url))
        #expect(opened == [url])
    }

    @Test func webViewDoesNotRetainItsCoordinatorAndUsesEphemeralStorage() throws {
        var coordinator: PathwayHTMLRenderWebView.Coordinator? = .init(parent())
        weak var weakCoordinator = coordinator
        let view = PathwayHTMLRenderWebView.makeWebView(coordinator: try #require(coordinator))
        #expect(!view.configuration.websiteDataStore.isPersistent)
        #expect(!view.configuration.preferences.javaScriptCanOpenWindowsAutomatically)
        #expect(!view.scrollView.isScrollEnabled)
        coordinator = nil
        #expect(weakCoordinator == nil)
        withExtendedLifetime(view) {}
    }

    @Test func secondProcessCrashFailsWithoutAURLRetry() {
        var retries: [Bool] = []
        let coordinator = PathwayHTMLRenderWebView.Coordinator(parent(onFailure: { retries.append($0) }))
        let view = PathwayHTMLRenderWebView.makeWebView(coordinator: coordinator)
        defer { PathwayHTMLRenderWebView.dismantleUIView(view, coordinator: coordinator) }
        coordinator.webViewWebContentProcessDidTerminate(view)
        #expect(retries.isEmpty)
        coordinator.webViewWebContentProcessDidTerminate(view)
        coordinator.webViewWebContentProcessDidTerminate(view)
        #expect(retries == [false])
    }

    @Test func handoffUsesOnlyOutwardVerticalDragsAtThePageEdges() throws {
        let coordinator = PathwayHTMLRenderWebView.Coordinator(parent())
        let view = PathwayHTMLRenderWebView.makeWebView(coordinator: coordinator)
        defer { PathwayHTMLRenderWebView.dismantleUIView(view, coordinator: coordinator) }
        view.frame = CGRect(x: 0, y: 0, width: 320, height: 200)
        view.scrollView.frame = view.bounds
        view.scrollView.contentSize = CGSize(width: 320, height: 500)
        let pan = TestPan()
        view.addGestureRecognizer(pan)
        coordinator.handoff = pan
        pan.direction = CGPoint(x: 0, y: 100)
        #expect(!coordinator.gestureRecognizerShouldBegin(pan))
        view.scrollView.isScrollEnabled = true
        #expect(coordinator.gestureRecognizerShouldBegin(pan))
        pan.direction.y = -100
        #expect(!coordinator.gestureRecognizerShouldBegin(pan))
        view.scrollView.contentOffset.y = 100
        #expect(!coordinator.gestureRecognizerShouldBegin(pan))
        view.scrollView.contentOffset.y = 300
        #expect(coordinator.gestureRecognizerShouldBegin(pan))
        pan.direction.y = 100
        #expect(!coordinator.gestureRecognizerShouldBegin(pan))
        pan.direction.x = 200
        #expect(!coordinator.gestureRecognizerShouldBegin(pan))
        #expect(coordinator.gestureRecognizer(pan, shouldRecognizeSimultaneouslyWith: UIPanGestureRecognizer()))
    }

    private func parent(onFailure: @escaping (Bool) -> Void = { _ in }) -> PathwayHTMLRenderWebView {
        .init(url: URL(string: "http://127.0.0.1:9/api/assets/token/Chart.html")!, title: "Chart",
              theme: .current(UITraitCollection(userInterfaceStyle: .dark)), nested: true,
              onLoad: {}, onContentHeight: { _ in }, onFailure: onFailure)
    }

    private func load(_ path: String, server: PageServer, frameHeight: CGFloat = 200, expectedScrollEnabled: Bool = true) async -> Set<String> {
        let (events, continuation) = AsyncStream.makeStream(of: String.self)
        let parent = PathwayHTMLRenderWebView(
            url: server.url(path), title: "Chart",
            theme: .current(UITraitCollection(userInterfaceStyle: .dark)), nested: true,
            onLoad: { continuation.yield("load") }, onContentHeight: { continuation.yield("height \(Int($0))") },
            onFailure: { _ in continuation.yield("failure") })
        let coordinator = PathwayHTMLRenderWebView.Coordinator(parent)
        let view = PathwayHTMLRenderWebView.makeWebView(coordinator: coordinator)
        defer { PathwayHTMLRenderWebView.dismantleUIView(view, coordinator: coordinator) }
        view.frame = CGRect(x: 0, y: 0, width: 320, height: frameHeight)
        coordinator.load(view)
        var seen = Set<String>()
        for await event in events {
            seen.insert(event)
            if event == "failure" || seen.isSuperset(of: ["load", "height 500"]) { break }
        }
        if !seen.contains("failure") { #expect(view.scrollView.isScrollEnabled == expectedScrollEnabled) }
        withExtendedLifetime((view, coordinator)) {}
        return seen
    }
}

@MainActor private final class TestPan: UIPanGestureRecognizer {
    var direction = CGPoint.zero
    override func velocity(in view: UIView?) -> CGPoint { direction }
}

/// Serves pages over loopback HTTP the way the environment's asset route does, headers included.
private final class PageServer: @unchecked Sendable {
    typealias Page = (html: String, headers: [String: String])
    private let listener: NWListener
    private let port: UInt16

    private init(listener: NWListener, port: UInt16) {
        self.listener = listener
        self.port = port
    }

    func url(_ path: String) -> URL { URL(string: "http://127.0.0.1:\(port)\(path)")! }

    static func start(pages: [String: Page]) async throws -> PageServer {
        let parameters = NWParameters.tcp
        parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: .any)
        let listener = try NWListener(using: parameters)
        listener.newConnectionHandler = { connection in
            connection.start(queue: .global())
            respond(on: connection, pages: pages, request: Data())
        }
        let port: UInt16 = try await withCheckedThrowingContinuation { ready in
            listener.stateUpdateHandler = { state in
                switch state {
                case .ready: listener.stateUpdateHandler = nil; ready.resume(returning: listener.port?.rawValue ?? 0)
                case let .failed(error): listener.stateUpdateHandler = nil; ready.resume(throwing: error)
                default: break
                }
            }
            listener.start(queue: .global())
        }
        return PageServer(listener: listener, port: port)
    }

    /// Reads one request's head, answers it, and closes the connection.
    private static func respond(on connection: NWConnection, pages: [String: Page], request: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 65_536) { data, _, isComplete, error in
            let request = request + (data ?? Data())
            let head = String(decoding: request, as: UTF8.self)
            guard head.contains("\r\n\r\n") else {
                if error == nil && !isComplete { respond(on: connection, pages: pages, request: request) } else { connection.cancel() }
                return
            }
            let path = head.split(separator: " ", maxSplits: 2).dropFirst().first.map(String.init) ?? "/"
            let page = pages[path]
            let body = Data((page?.html ?? "Not found").utf8)
            var lines = ["HTTP/1.1 \(page == nil ? "404 Not Found" : "200 OK")", "Content-Length: \(body.count)", "Connection: close"]
            lines += (page?.headers ?? ["Content-Type": "text/plain"]).map { "\($0.key): \($0.value)" }
            connection.send(content: Data((lines.joined(separator: "\r\n") + "\r\n\r\n").utf8) + body,
                            completion: .contentProcessed { _ in connection.cancel() })
        }
    }

    func stop() { listener.cancel() }
}

@MainActor
private final class Recorder: NSObject, WKScriptMessageHandler {
    let continuation: AsyncStream<String>.Continuation
    init(continuation: AsyncStream<String>.Continuation) { self.continuation = continuation }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any] else { return }
        if let link = body["openLink"] as? String {
            continuation.yield("link \(link) \(body["id"].map { "\($0)" } ?? "")")
        } else if let height = body["height"] as? NSNumber {
            continuation.yield("height \(height.intValue)")
        }
    }
}
