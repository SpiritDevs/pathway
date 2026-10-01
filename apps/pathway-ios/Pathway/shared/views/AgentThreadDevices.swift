import SwiftUI
import WebKit

/// Drives one device stream page. The page lives at the environment's origin so media and
/// input are same-origin, and authenticates them with the connection's short-lived ticket.
@MainActor @Observable
final class PathwayDeviceStreamController {
    enum Status: Equatable { case preparing, connecting, streaming, failed(String) }
    typealias Prepare = @MainActor () async throws -> PathwayPreparedEnvironmentConnection

    private(set) var status: Status = .preparing
    private(set) var inputConnected = false
    /// The origin the page is loaded at.
    private(set) var origin: URL?
    /// Identifies the current document. A new value recreates the web view; callbacks from older pages are ignored.
    private(set) var page = UUID()
    /// What the page starts with once it loads; nil while a ticket is being minted.
    @ObservationIgnored private(set) var configuration: [String: Any]?
    @ObservationIgnored private weak var webView: WKWebView?
    @ObservationIgnored private var pageReady = false
    @ObservationIgnored private var pageFailed = false
    @ObservationIgnored private var ticketExpiresAt: Date?
    @ObservationIgnored private var refreshesLeft = PathwayDeviceStreamController.maxRefreshes
    @ObservationIgnored private var inputEnabled = false
    @ObservationIgnored private var proof: PathwayDeviceControlProof?
    @ObservationIgnored private var generation = 0
    @ObservationIgnored private var preparation: Task<Void, Never>?
    @ObservationIgnored private let prepare: Prepare
    @ObservationIgnored private let now: () -> Date

    /// Automatic credential refreshes allowed before the stream connects or the user retries.
    static let maxRefreshes = 2
    static let rejectedMessage = "This environment rejected the device stream credentials."
    static let expiredMessage = "The device stream's credentials kept expiring."

    static let javaScript: String? = Bundle.main.url(forResource: "PathwayDeviceStream", withExtension: "bundle")
        .flatMap { try? String(contentsOf: $0.appendingPathComponent("device-stream.js"), encoding: .utf8) }

    init(now: @escaping () -> Date = Date.init, prepare: @escaping Prepare) {
        self.now = now
        self.prepare = prepare
    }

    /// Mints a ticket and (re)starts the stream for `preview`. Only a credential refresh after a rejection
    /// spends the refresh budget; every other start is a fresh attempt.
    @discardableResult
    func start(_ preview: PathwayThreadDevicePreview, hubBasePath: String, refreshingCredentials: Bool = false) -> Task<Void, Never> {
        preparation?.cancel()
        generation += 1
        let generation = generation
        if !refreshingCredentials { refreshesLeft = Self.maxRefreshes }
        // The previous stream, possibly another device, stops and gives up input while the ticket is minted.
        configuration = nil
        stopPage()
        status = .preparing
        let task = Task { [prepare] in
            do {
                let prepared = try await prepare()
                guard generation == self.generation else { return }
                let expiresAt = prepared.ticketExpiresAt ?? now().addingTimeInterval(PathwayDeviceHubAccess.fallbackTicketLifetime)
                guard let access = PathwayDeviceHubAccess.make(httpBaseURL: prepared.httpBaseURL, webSocketURL: prepared.webSocketURL,
                                                              hubBasePath: hubBasePath, hostID: preview.hostID, expiresAt: expiresAt),
                      let origin = PathwayDeviceHubAccess.origin(prepared.httpBaseURL) else {
                    status = .failed("This environment's address can't stream devices."); return
                }
                ticketExpiresAt = expiresAt
                // Input permission may have changed while the ticket was minted.
                configuration = ["platform": preview.platform, "deviceId": preview.deviceID, "access": access,
                                 "inputEnabled": inputEnabled, "control": proof?.page ?? NSNull()]
                status = .connecting
                if self.origin != origin || pageFailed {
                    pageReady = false
                    pageFailed = false
                    self.origin = origin
                    page = UUID()
                } else {
                    deliver()
                }
            } catch {
                guard generation == self.generation, !(error is CancellationError) else { return }
                status = .failed(error.localizedDescription)
            }
        }
        preparation = task
        return task
    }

    func stop() {
        preparation?.cancel()
        preparation = nil
        generation += 1
        configuration = nil
        stopPage()
    }

    func setInputEnabled(_ enabled: Bool) {
        guard enabled != inputEnabled else { return }
        inputEnabled = enabled
        configuration?["inputEnabled"] = enabled
        call("window.pathwayDeviceStream.setInputEnabled(enabled)", ["enabled": enabled])
    }

    /// Input sockets carry the control proof in their URLs, so a new grant restarts the stream with it.
    /// Renewals keep the proof and losing it needs no reconnect: the environment ignores stale input.
    func setInput(enabled: Bool, proof: PathwayDeviceControlProof?) {
        let reconnects = proof != nil && proof != self.proof
        self.proof = proof
        configuration?["control"] = proof?.page ?? NSNull()
        guard reconnects else { setInputEnabled(enabled); return }
        inputEnabled = enabled
        configuration?["inputEnabled"] = enabled
        deliver()
    }

    func command(_ button: String) { call("window.pathwayDeviceStream.command(button)", ["button": button]) }

    func attach(_ view: WKWebView) { webView = view; pageReady = false }
    func detach(_ view: WKWebView) { if webView === view { webView = nil; pageReady = false } }
    func didLoad(page: UUID) {
        guard page == self.page else { return }
        pageReady = true
        deliver()
    }

    /// Returns true when the owner should mint a fresh ticket and restart with `refreshingCredentials`.
    func received(_ message: [String: Any], page: UUID) -> Bool {
        guard page == self.page, configuration != nil else { return false }
        switch message["type"] as? String {
        case "status":
            switch message["status"] as? String {
            case "streaming": status = .streaming
            case "error": status = .failed("The device stream failed.")
            default: if status != .preparing { status = .connecting }
            }
        case "input":
            inputConnected = message["connected"] as? Bool ?? false
        case "unauthorized":
            if refreshesLeft > 0 {
                refreshesLeft -= 1
                return true
            }
            let expired = ticketExpiresAt.map { now() >= $0 } ?? false
            status = .failed(expired ? Self.expiredMessage : Self.rejectedMessage)
            return false
        default: break
        }
        if status == .streaming, inputConnected { refreshesLeft = Self.maxRefreshes }
        return false
    }

    /// The page itself broke; the next start loads a new document.
    func failed(_ message: String, page: UUID) {
        guard page == self.page else { return }
        pageReady = false
        pageFailed = true
        status = .failed(message)
    }

    private func stopPage() {
        inputConnected = false
        webView?.evaluateJavaScript("window.pathwayDeviceStream?.stop()", completionHandler: nil)
    }

    private func deliver() {
        guard pageReady, let configuration else { return }
        inputConnected = false
        call("window.pathwayDeviceStream.start(configuration)", ["configuration": configuration])
    }

    private func call(_ script: String, _ arguments: [String: Any]) {
        guard pageReady, let webView else { return }
        let page = page
        Task { [weak self] in
            do { _ = try await webView.callAsyncJavaScript(script, arguments: arguments, in: nil, contentWorld: .page) }
            catch { self?.failed("The device viewer stopped: \(error.localizedDescription)", page: page) }
        }
    }
}

/// An empty page at the environment's origin running the bundled stream client.
struct PathwayDeviceStreamWebView: UIViewRepresentable {
    let controller: PathwayDeviceStreamController
    let origin: URL
    let page: UUID
    let onUnauthorized: () -> Void

    static func html(origin: URL) -> String {
        let http = origin.absoluteString.hasSuffix("/") ? String(origin.absoluteString.dropLast()) : origin.absoluteString
        let ws = (http.hasPrefix("https:") ? "wss:" : "ws:") + http.drop { $0 != ":" }.dropFirst()
        // The stream script is a user script, so the page itself allows none.
        let policy = "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src \(http) blob: data:; connect-src \(http) \(ws); base-uri 'none'; form-action 'none'"
        return """
        <!doctype html><html><head><meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
        <meta http-equiv="Content-Security-Policy" content="\(policy)">
        <style>html,body{margin:0;height:100%;overflow:hidden;background:#000;-webkit-user-select:none}</style>
        </head><body></body></html>
        """
    }

    func makeCoordinator() -> Coordinator { Coordinator(self, page: page) }
    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        config.preferences.javaScriptCanOpenWindowsAutomatically = false
        config.allowsInlineMediaPlayback = true
        config.userContentController.add(context.coordinator, name: "deviceStream")
        if let script = PathwayDeviceStreamController.javaScript {
            config.userContentController.addUserScript(WKUserScript(source: script, injectionTime: .atDocumentEnd,
                                                                    forMainFrameOnly: true, in: .page))
        }
        let view = WKWebView(frame: .zero, configuration: config)
        view.navigationDelegate = context.coordinator
        view.isOpaque = true
        view.backgroundColor = .black
        view.scrollView.isScrollEnabled = false
        view.scrollView.contentInsetAdjustmentBehavior = .never
        controller.attach(view)
        if PathwayDeviceStreamController.javaScript == nil {
            controller.failed("The device viewer is missing from this build.", page: page)
        } else {
            view.loadHTMLString(Self.html(origin: origin), baseURL: origin)
        }
        return view
    }
    func updateUIView(_ uiView: WKWebView, context: Context) { context.coordinator.parent = self }
    static func dismantleUIView(_ uiView: WKWebView, coordinator: Coordinator) {
        uiView.evaluateJavaScript("window.pathwayDeviceStream?.stop()", completionHandler: nil)
        coordinator.parent.controller.detach(uiView)
        uiView.stopLoading()
        uiView.configuration.userContentController.removeScriptMessageHandler(forName: "deviceStream")
        uiView.navigationDelegate = nil
    }

    @MainActor final class Coordinator: NSObject, WKNavigationDelegate, WKScriptMessageHandler {
        var parent: PathwayDeviceStreamWebView
        /// The document this web view was created for.
        let page: UUID
        init(_ parent: PathwayDeviceStreamWebView, page: UUID) { self.parent = parent; self.page = page }

        func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
            let origin = message.frameInfo.securityOrigin
            guard message.name == "deviceStream", message.frameInfo.isMainFrame,
                  origin.host == parent.origin.host, origin.protocol == parent.origin.scheme,
                  let fields = message.body as? [String: Any] else { return }
            if parent.controller.received(fields, page: page) { parent.onUnauthorized() }
        }
        func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                     decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy) -> Void) {
            // Only the initial document; links and redirects never navigate the viewer.
            let url = navigationAction.request.url
            let allowed = navigationAction.targetFrame?.isMainFrame == true && navigationAction.navigationType == .other
                && url?.scheme == parent.origin.scheme && url?.host == parent.origin.host && url?.port == parent.origin.port
                && (url?.path ?? "/").count <= 1
            decisionHandler(allowed ? .allow : .cancel)
        }
        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { parent.controller.didLoad(page: page) }
        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            parent.controller.failed(error.localizedDescription, page: page)
        }
        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
            parent.controller.failed("The device viewer stopped. Reconnect to reload it.", page: page)
        }
    }
}

/// The button above the composer while this thread has devices open.
struct AgentThreadDevicesButton: View {
    let devices: PathwayThreadDevicesModel
    let open: () -> Void

    var body: some View {
        let previews = devices.previews
        if let first = previews.first {
            Button(action: open) {
                HStack(spacing: 8) {
                    Image(systemName: first.platform == "ios" ? "iphone" : "smartphone")
                    Text(PathwayThreadDevicePreview.buttonTitle(count: previews.count)).lineLimit(1)
                    Spacer(minLength: 0)
                    Text("View").font(.caption.bold())
                }
                .font(.caption)
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
            #if os(visionOS)
            .background(.regularMaterial, in: .capsule)
            #else
            .glassEffect(.regular.interactive(), in: .capsule)
            #endif
            .padding(.horizontal)
            .accessibilityLabel("\(PathwayThreadDevicePreview.buttonTitle(count: previews.count)). Opens the device viewer.")
            .accessibilityIdentifier("thread-devices-button")
        }
    }
}

/// The viewer for the thread's devices. The stream runs only while this is on screen
/// and the app is in the foreground; returning reconnects with a fresh ticket.
struct AgentThreadDeviceViewer: View {
    let devices: PathwayThreadDevicesModel
    let model: PathwayAgentThreadModel
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase
    @State private var controller: PathwayDeviceStreamController
    @State private var lease: PathwayDeviceControlLease
    @State private var selectedID: String?
    @State private var attempt = 0
    @State private var confirmsTakeControl = false
    @State private var confirmsShutdown = false
    @State private var handBack = ""
    @State private var error: String?
    @State private var isWorking = false

    init(devices: PathwayThreadDevicesModel, model: PathwayAgentThreadModel) {
        self.devices = devices
        self.model = model
        _controller = State(initialValue: PathwayDeviceStreamController { [connect = devices.connect, environment = devices.environment] in
            try await connect.prepare(environment: environment)
        })
        _lease = State(initialValue: PathwayDeviceControlLease(connect: devices.connect, environment: devices.environment))
    }

    private var selected: PathwayThreadDevicePreview? {
        devices.previews.first { $0.id == selectedID } ?? devices.previews.first
    }
    private var control: PathwayDeviceControl {
        guard devices.isLive, let state = devices.state, let selected else { return .unknown }
        guard state.supportsDeviceControl else {
            return .unleased(runStateKnown: model.isSubscriptionReady && model.connectionState == .live, activeRunID: model.activeRunID)
        }
        return .resolve(state, hostID: selected.hostID, deviceID: selected.deviceID, viewerID: lease.viewerID,
                        lease: lease.lease, acquiring: lease.acquiring)
    }
    private var input: Input { control == .you ? Input(enabled: true, proof: lease.proof) : Input(enabled: control.acceptsInput, proof: nil) }
    private struct Input: Equatable { let enabled: Bool; let proof: PathwayDeviceControlProof? }
    /// Environments with leases only shut a device down for the viewer controlling it.
    private var canShutDown: Bool { devices.state?.supportsDeviceControl != true || control == .you }

    var body: some View {
        VStack(spacing: 0) {
            stream.frame(maxWidth: .infinity, maxHeight: .infinity).background(.black)
            controlBar
        }
        .navigationTitle(selected?.name ?? "Devices")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { toolbar }
        .task(id: scenePhase == .active) {
            guard scenePhase == .active else { return }
            await devices.watch()
        }
        .task(id: "\(scenePhase == .active):\(selected?.id ?? ""):\(devices.state?.hubBasePath ?? ""):\(attempt)") { await sync() }
        .onDisappear { Task { [lease, controller] in try? await lease.release(); controller.stop() } }
        .onChange(of: input, initial: true) { _, input in controller.setInput(enabled: input.enabled, proof: input.proof) }
        .onChange(of: devices.previews.isEmpty) { _, empty in if empty { dismiss() } }
        .confirmationDialog("Take control of the device?", isPresented: $confirmsTakeControl, titleVisibility: .visible) {
            Button("Take control") { Task { await takeControl() } }
        } message: { Text("Whoever is using it loses control. The agent can't use the device again until you resume it.") }
        .confirmationDialog("Shut down \(selected?.name ?? "this device")?", isPresented: $confirmsShutdown, titleVisibility: .visible) {
            Button("Shut down", role: .destructive) { Task { await shutDown() } }
        } message: { Text("The device closes for this thread and its simulator or emulator stops.") }
        .alert("Couldn't update the device", isPresented: Binding(get: { error != nil }, set: { if !$0 { error = nil } })) {
            Button("OK") { error = nil }
        } message: { Text(error ?? "") }
    }

    @ViewBuilder private var stream: some View {
        ZStack {
            if scenePhase == .active, let origin = controller.origin {
                PathwayDeviceStreamWebView(controller: controller, origin: origin, page: controller.page) { connect(refreshingCredentials: true) }
                    .id(controller.page)
                    .accessibilityLabel(selected?.platform == "ios" ? "iOS Simulator screen" : "Android Emulator screen")
            }
            switch controller.status {
            case .streaming:
                if !controller.inputConnected, control.acceptsInput {
                    VStack { Spacer(); Text("Reconnecting device controls…").font(.caption).foregroundStyle(.secondary).padding(8) }
                        .allowsHitTesting(false)
                }
            case .failed(let message):
                ContentUnavailableView {
                    Label("Device stream disconnected", systemImage: "iphone.slash")
                } description: { Text(message) } actions: {
                    Button("Reconnect") { attempt += 1 }.buttonStyle(.borderedProminent)
                }
                .background(.black)
            case .preparing, .connecting:
                ProgressView("Connecting to device…").tint(.white).foregroundStyle(.white)
            }
        }
        .environment(\.colorScheme, .dark)
    }

    private var controlBar: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Circle().fill(control.acceptsInput ? Color.green : [.unknown, .nobody].contains(control) ? Color.secondary : Color.orange)
                    .frame(width: 8, height: 8)
                Text(control.label).font(.subheadline).lineLimit(1)
                Spacer()
                if control.canTake || control == .taking {
                    Button("Take control") { if control == .nobody { Task { await takeControl() } } else { confirmsTakeControl = true } }
                        .buttonStyle(.borderedProminent).disabled(isWorking || control == .taking)
                        .accessibilityIdentifier("device-take-control")
                }
            }
            if control.acceptsInput {
                HStack(spacing: 8) {
                    TextField("Message for the agent (optional)", text: $handBack)
                        .textFieldStyle(.roundedBorder)
                    Button("Resume agent") { Task { await resumeAgent() } }
                        .buttonStyle(.bordered).disabled(isWorking)
                        .accessibilityIdentifier("device-resume-agent")
                }
            }
        }
        .padding()
        .background(.bar)
    }

    @ToolbarContentBuilder private var toolbar: some ToolbarContent {
        ToolbarItemGroup(placement: .topBarTrailing) {
            Button("Home", systemImage: "circle.circle") { controller.command("home") }
                .disabled(!control.acceptsInput)
            Menu("Device", systemImage: "ellipsis.circle") {
                if devices.previews.count > 1 {
                    Picker("Device", selection: Binding(get: { selected?.id }, set: { selectedID = $0 })) {
                        ForEach(devices.previews) { preview in
                            VStack { Text(preview.name); if !preview.detail.isEmpty { Text(preview.detail) } }
                                .tag(Optional(preview.id))
                        }
                    }
                }
                Button("Reload stream", systemImage: "arrow.clockwise") { attempt += 1 }
                Section {
                    Button("App switcher", systemImage: "square.on.square") { controller.command("appSwitcher") }
                    if selected?.platform == "android" {
                        Button("Back", systemImage: "chevron.backward") { controller.command("back") }
                    } else {
                        Button("Rotate", systemImage: "rotate.right") { controller.command("rotate") }
                    }
                }
                .disabled(!control.acceptsInput)
                Button("Shut down device", systemImage: "power", role: .destructive) { confirmsShutdown = true }
                    .disabled(!canShutDown)
            }
        }
    }

    /// Gives up control before a hidden viewer or a newly selected device stops its stream.
    private func sync() async {
        if let held = lease.lease, scenePhase != .active || held.hostID != selected?.hostID || held.deviceID != selected?.deviceID {
            try? await lease.release()
        }
        connect()
    }

    private func connect(refreshingCredentials: Bool = false) {
        guard scenePhase == .active, let selected, let hubBasePath = devices.state?.hubBasePath else {
            controller.stop(); return
        }
        controller.start(selected, hubBasePath: hubBasePath, refreshingCredentials: refreshingCredentials)
    }

    private func takeControl() async {
        guard let selected else { return }
        isWorking = true
        defer { isWorking = false }
        do { try await lease.acquire(hostID: selected.hostID, deviceID: selected.deviceID) }
        catch { self.error = PathwayDeviceControl.message(for: error) }
    }

    /// The agent's follow-up goes out only after the environment finishes this viewer's input.
    private func resumeAgent() async {
        isWorking = true
        defer { isWorking = false }
        do {
            try await lease.release()
            try await model.resumeAfterDeviceControl(handBack)
            handBack = ""
        } catch { self.error = PathwayDeviceControl.message(for: error) }
    }

    private func shutDown() async {
        guard let selected else { return }
        isWorking = true
        defer { isWorking = false }
        do { try await devices.shutDown(selected, control: control == .you ? lease.proof : nil) }
        catch { self.error = PathwayDeviceControl.message(for: error) }
    }
}
