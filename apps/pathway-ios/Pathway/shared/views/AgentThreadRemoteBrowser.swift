import SwiftUI

struct PathwayRemoteBrowserTab: Decodable, Identifiable, Equatable {
    let tabId: String
    let url: String
    let title: String
    let recording: Bool
    var id: String { tabId }
}

struct PathwayRemoteBrowserResult: Decodable {
    struct Artifact: Decodable {
        let url: String
        let mimeType: String
    }
    let tabs: [PathwayRemoteBrowserTab]
    let selectedTabId: String?
    let artifact: Artifact?
    let artifacts: [Artifact]?
}

struct PathwayRemoteBrowserFrame {
    let image: UIImage
    let width: Double
    let height: Double

    /// Decodes one streamed frame for `tabID`; metadata-only updates and other tabs yield nil.
    static func decode(_ fields: [String: JSONValue], tabID: String) -> PathwayRemoteBrowserFrame? {
        guard fields["tabId"]?.stringValue == tabID,
              let encoded = fields["data"]?.stringValue, !encoded.isEmpty,
              let data = Data(base64Encoded: encoded), let image = UIImage(data: data),
              case let .number(width)? = fields["width"], case let .number(height)? = fields["height"] else { return nil }
        return PathwayRemoteBrowserFrame(image: image, width: width, height: height)
    }

    static func point(_ location: CGPoint, in size: CGSize, width: Double, height: Double) -> CGPoint? {
        guard width > 0, height > 0, size.width > 0, size.height > 0 else { return nil }
        let scale = min(size.width / width, size.height / height)
        let point = CGPoint(x: (location.x - (size.width - width * scale) / 2) / scale,
                            y: (location.y - (size.height - height * scale) / 2) / scale)
        return point.x >= 0 && point.y >= 0 && point.x < width && point.y < height ? point : nil
    }
}

/// Owns its browser connections; closing the browser never stops the task's subscription.
@MainActor @Observable
final class PathwayRemoteBrowserModel {
    private(set) var tabs: [PathwayRemoteBrowserTab] = []
    var selectedID: String?
    private(set) var frame: PathwayRemoteBrowserFrame?
    private(set) var busy = false
    private(set) var isHostReady = false
    var error: String?
    private(set) var artifactURL: URL?
    private(set) var artifactURLs: [URL] = []
    @ObservationIgnored private let thread: PathwayAgentThreadModel
    @ObservationIgnored private let injectedRequest: PathwayAgentThreadModel.Request?
    @ObservationIgnored private var commandRPC: PathwayRPCClient?
    @ObservationIgnored private var httpBaseURL: URL?
    @ObservationIgnored private var metadataRevision: Double?

    var takeoverStatus: String? { thread.browserTakeover?["status"]?.stringValue }
    var canTakeControl: Bool { thread.runs.contains { ["preparing", "starting", "running"].contains($0.status) } }
    func takeControl(_ action: String) async {
        do {
            var fields: [String: JSONValue] = [:]
            if action != "request", let id = thread.browserTakeover?["id"] { fields["takeoverId"] = id }
            try await thread.dispatch("thread.browser-takeover.\(action)", fields: fields)
        } catch { self.error = error.localizedDescription }
    }
    var selected: PathwayRemoteBrowserTab? { tabs.first { $0.id == selectedID } ?? tabs.first }

    init(thread: PathwayAgentThreadModel, request: PathwayAgentThreadModel.Request? = nil) {
        self.thread = thread
        injectedRequest = request
        // Open on the page the agent is using, so watching it is one tap.
        selectedID = thread.agentRemoteBrowserTabID
    }

    func start() async {
        isHostReady = false
        error = nil
        do {
            if injectedRequest == nil && commandRPC == nil {
                guard let connect = thread.connect else { error = "Connect to an environment to use its browser."; return }
                let environment = thread.environment
                httpBaseURL = try await connect.prepare(environment: environment).httpBaseURL
                commandRPC = PathwayRPCClient { try await connect.prepare(environment: environment).webSocketURL }
            }
            guard await command("selectHost", fields: ["host": .string("environment")]), !Task.isCancelled else { return }
            isHostReady = true
            if !(await command("list")) { isHostReady = false }
        } catch { self.error = error.localizedDescription }
    }

    func stop() async {
        isHostReady = false
        let rpc = commandRPC
        commandRPC = nil
        await rpc?.stop()
    }

    @discardableResult
    func command(_ action: String, fields: [String: JSONValue] = [:], tabID: String? = nil) async -> Bool {
        guard isHostReady || action == "selectHost", commandRPC != nil || injectedRequest != nil else { return false }
        var payload = fields
        payload["action"] = .string(action)
        payload["threadId"] = .string(thread.threadID)
        if !["selectHost", "list", "open"].contains(action), let id = tabID ?? selected?.id { payload["tabId"] = .string(id) }
        if action != "list" { busy = true; error = nil }
        defer { if action != "list" { busy = false } }
        do {
            let value: JSONValue
            if let injectedRequest { value = try await injectedRequest("preview.remote.command", .object(payload)) }
            else if let commandRPC { value = try await commandRPC.request("preview.remote.command", payload: .object(payload)) }
            else { return false }
            let result = try JSONDecoder().decode(PathwayRemoteBrowserResult.self, from: JSONEncoder().encode(value))
            tabs = result.tabs
            if action == "open" || !tabs.contains(where: { $0.id == selectedID }) {
                selectedID = result.selectedTabId ?? tabs.first?.id
            }
            if let artifact = result.artifact, let httpBaseURL {
                artifactURL = URL(string: artifact.url, relativeTo: httpBaseURL)?.absoluteURL
            }
            if let artifacts = result.artifacts, let httpBaseURL {
                artifactURLs = artifacts.compactMap { URL(string: $0.url, relativeTo: httpBaseURL)?.absoluteURL }
            }
            return true
        } catch is CancellationError { return false }
        catch { self.error = error.localizedDescription; return false }
    }

    /// Streams the selected tab, retrying a dropped stream a few times before asking for Reconnect.
    func watchSelectedTab() async {
        frame = nil
        let id = selected?.id
        for delay in [1.0, 2.0, 4.0, nil] {
            guard isHostReady, !Task.isCancelled, selected?.id == id else { return }
            if await watchTab(id) || Task.isCancelled { return }
            guard let delay else { return }
            try? await Task.sleep(for: .seconds(delay))
            if !Task.isCancelled { error = nil }
        }
    }

    /// Returns false when the stream failed rather than ending normally.
    private func watchTab(_ id: String?) async -> Bool {
        guard let connect = thread.connect else { return true }
        let environment = thread.environment
        let rpc = PathwayRPCClient { try await connect.prepare(environment: environment).webSocketURL }
        defer { Task { await rpc.stop() } }
        do {
            var payload: [String: JSONValue] = ["threadId": .string(thread.threadID)]
            if let id { payload["tabId"] = .string(id) }
            for try await value in await rpc.subscribe("preview.remote.frames", payload: .object(payload), bufferingPolicy: .bufferingNewest(1)) {
                guard !Task.isCancelled, selected?.id == id else { return true }
                guard let fields = value.objectValue else { continue }
                let nextRevision: Double?
                if case let .number(value)? = fields["metadataRevision"] { nextRevision = value } else { nextRevision = nil }
                if let tabValues = fields["tabs"], let nextTabs = try? JSONDecoder().decode([PathwayRemoteBrowserTab].self, from: JSONEncoder().encode(tabValues)), nextTabs != tabs || (nextRevision != nil && nextRevision != metadataRevision) {
                    tabs = nextTabs
                    metadataRevision = nextRevision
                    if !tabs.contains(where: { $0.id == selectedID }) { selectedID = tabs.first?.id }
                    _ = await command("list")
                }
                guard let id, let decoded = PathwayRemoteBrowserFrame.decode(fields, tabID: id) else { continue }
                frame = decoded
            }
            return true
        } catch is CancellationError { return true }
        catch { self.error = error.localizedDescription; return false }
    }
}

struct AgentThreadRemoteBrowser: View {
    @State private var browser: PathwayRemoteBrowserModel
    @State private var address = ""
    @State private var typing = ""
    @State private var showsPasswords = false
    @State private var passwordTabID: String?
    @State private var passwordOrigin: String?
    init(model: PathwayAgentThreadModel) { _browser = State(initialValue: PathwayRemoteBrowserModel(thread: model)) }

    var body: some View {
        VStack(spacing: 8) {
                if !browser.isHostReady {
                    if let error = browser.error {
                        Text(error).font(.caption).foregroundStyle(.red)
                        Button("Retry browser connection") { Task { await browser.start() } }
                    } else {
                        ProgressView("Connecting to the remote browser…")
                            .frame(maxWidth: .infinity, maxHeight: .infinity)
                    }
                } else {
                HStack {
                    if browser.takeoverStatus == "active" {
                        Text("You control the browser").font(.caption)
                        Button("Resume agent") { Task { await browser.takeControl("proceed") } }
                        Button("End takeover") { Task { await browser.takeControl("release") } }
                    } else if ["requested", "pausing", "proceeding"].contains(browser.takeoverStatus ?? "") {
                        Text(browser.takeoverStatus == "proceeding" ? "Resuming agent…" : "Pausing agent…").font(.caption)
                    } else if browser.canTakeControl {
                        Button("Take control") { Task { await browser.takeControl("request") } }
                    }
                }.font(.caption)
                HStack {
                    Picker("Browser tab", selection: $browser.selectedID) {
                        ForEach(browser.tabs) { tab in Text(tab.title.isEmpty ? tab.url : tab.title).tag(Optional(tab.id)) }
                    }
                    Button("New tab", systemImage: "plus") { Task { await browser.command("open") } }
                    if let tab = browser.selected {
                        Button("Close tab", systemImage: "xmark") { Task { await browser.command("close", tabID: tab.id) } }
                    }
                }.labelStyle(.iconOnly)
                HStack {
                    Button("Back", systemImage: "chevron.left") { Task { await browser.command("back") } }
                    Button("Forward", systemImage: "chevron.right") { Task { await browser.command("forward") } }
                    TextField("Website address", text: $address)
                        .textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.URL)
                        .textFieldStyle(.roundedBorder).onSubmit(navigate)
                    Button("Go", action: navigate).disabled(address.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }.labelStyle(.iconOnly)
                if let error = browser.error { Text(error).font(.caption).foregroundStyle(.red) }
                RemoteBrowserImage(browser: browser)
                HStack {
                    TextField("Type in selected page field", text: $typing)
                        .textFieldStyle(.roundedBorder).textInputAutocapitalization(.never).autocorrectionDisabled()
                    Button("Type") {
                        let text = typing
                        Task { if await browser.command("type", fields: ["text": .string(text)]), typing == text { typing = "" } }
                    }.disabled(typing.isEmpty)
                    Menu("Keys", systemImage: "keyboard") {
                        ForEach(["Tab", "Enter", "Backspace", "Escape"], id: \.self) { key in
                            Button(key) { Task { await browser.command("press", fields: ["key": .string(key)]) } }
                        }
                    }
                }
                ScrollView(.horizontal) {
                HStack(spacing: 20) {
                    Button("Reload", systemImage: "arrow.clockwise") { Task { await browser.command("reload") } }
                    Button("Passwords", systemImage: "key") {
                        passwordTabID = browser.selected?.id
                        if let url = browser.selected.flatMap({ URL(string: $0.url) }), let scheme = url.scheme, ["http", "https"].contains(scheme), let host = url.host {
                            passwordOrigin = "\(scheme)://\(host)" + (url.port.map { ":\($0)" } ?? "")
                        } else { passwordOrigin = nil }
                        showsPasswords = true
                    }
                    Button("Screenshot", systemImage: "camera") { Task { await browser.command("screenshot") } }
                    Button(browser.selected?.recording == true ? "Stop recording" : "Record video", systemImage: "record.circle") {
                        Task { await browser.command(browser.selected?.recording == true ? "recordingStop" : "recordingStart") }
                    }
                    if !browser.artifactURLs.isEmpty {
                        Menu("Captures", systemImage: "photo.on.rectangle") {
                            ForEach(Array(browser.artifactURLs.enumerated()), id: \.element) { index, url in
                                ShareLink("Capture \(index + 1)", item: url)
                            }
                        }
                    } else if let url = browser.artifactURL { ShareLink("Share capture", item: url) }
                }.font(.subheadline).labelStyle(.iconOnly).frame(minHeight: 44)
                }.scrollIndicators(.hidden)
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .disabled(browser.busy)
            .navigationTitle("Remote browser")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Reconnect browser", systemImage: "arrow.triangle.2.circlepath") {
                        Task { await browser.stop(); await browser.start() }
                    }.disabled(browser.busy)
                }
            }
            .sheet(isPresented: $showsPasswords) {
                if let origin = passwordOrigin, let tabID = passwordTabID {
                    BrowserPasswordsView(origin: origin) { origin, username, password in
                        await browser.command("autofill", fields: ["origin": .string(origin), "username": .string(username), "password": .string(password)], tabID: tabID)
                    }
                } else {
                    BrowserPasswordsView(origin: nil)
                }
            }
            .task { await browser.start() }
            .task(id: "\(browser.isHostReady):\(browser.selectedID ?? "")") { await browser.watchSelectedTab() }
            .onDisappear { Task { await browser.stop() } }
            .onChange(of: browser.selected?.url) { _, url in address = url == "about:blank" ? "" : url ?? "" }
    }
    private func navigate() {
        Task { await browser.command(browser.selected == nil ? "open" : "navigate", fields: ["url": .string(address)]) }
    }
}

private struct RemoteBrowserImage: View {
    let browser: PathwayRemoteBrowserModel
    var body: some View {
        GeometryReader { geometry in
            if let frame = browser.frame {
                Image(uiImage: frame.image).resizable().scaledToFit()
                    .frame(width: geometry.size.width, height: geometry.size.height)
                    .contentShape(Rectangle())
                    .accessibilityLabel("Remote browser page")
                    .gesture(DragGesture(minimumDistance: 10).onEnded { value in
                        let scale = min(geometry.size.width / frame.width, geometry.size.height / frame.height)
                        guard scale > 0 else { return }
                        Task { await browser.command("scroll", fields: ["deltaX": .number(-value.translation.width / scale), "deltaY": .number(-value.translation.height / scale)]) }
                    })
                    .simultaneousGesture(SpatialTapGesture().onEnded { value in
                        guard let point = PathwayRemoteBrowserFrame.point(value.location, in: geometry.size, width: frame.width, height: frame.height) else { return }
                        Task { await browser.command("click", fields: ["x": .number(point.x), "y": .number(point.y)]) }
                    })
            } else {
                ContentUnavailableView {
                    Label(browser.selected == nil ? "Open a website" : "Waiting for the browser page", systemImage: "globe")
                } description: {
                    Text(browser.selected == nil ? "Enter a website address above, or open a new tab. The page runs on your connected environment." : "If the page does not appear, use Reconnect browser in the toolbar.")
                } actions: {
                    if browser.selected == nil {
                        Button("New tab", systemImage: "plus") { Task { await browser.command("open") } }
                    }
                }
                .frame(width: geometry.size.width, height: geometry.size.height)
            }
        }.frame(maxHeight: .infinity)
    }
}

/// Live strip above the composer while the agent browses in the environment's browser.
/// Tapping it opens the full remote browser on the same tab, where control can be taken.
struct AgentThreadRemoteBrowserPreview: View {
    let model: PathwayAgentThreadModel
    let open: () -> Void
    @State private var frame: PathwayRemoteBrowserFrame?
    @State private var failed = false
    @State private var attempt = 0
    @State private var hiddenTabID: String?

    var body: some View {
        if let tabID = model.agentRemoteBrowserTabID, tabID != hiddenTabID {
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Label("Agent is browsing", systemImage: "globe").font(.caption).lineLimit(1)
                    Spacer()
                    Button("Hide", systemImage: "xmark") { hiddenTabID = tabID }
                        .labelStyle(.iconOnly).font(.caption)
                        .accessibilityIdentifier("thread-remote-browser-preview-hide")
                }
                if let frame {
                    Button(action: open) {
                        Image(uiImage: frame.image).resizable().scaledToFit()
                            .frame(maxWidth: .infinity, maxHeight: 220)
                            .clipShape(.rect(cornerRadius: 12))
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Live view of the agent's browser. Opens the remote browser.")
                } else if failed {
                    HStack {
                        Text("The remote browser disconnected.").font(.caption).foregroundStyle(.secondary)
                        Spacer()
                        Button("Reconnect") { failed = false; attempt += 1 }.font(.caption.bold())
                    }
                } else {
                    Button("Watch", action: open).font(.caption.bold())
                }
            }
            .padding(12)
            #if os(visionOS)
            .background(.regularMaterial, in: .rect(cornerRadius: 22))
            #else
            .glassEffect(.regular, in: .rect(cornerRadius: 22))
            #endif
            .padding(.horizontal)
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("thread-remote-browser-preview")
            .task(id: "\(tabID):\(attempt)") { await watch(tabID) }
        }
    }

    private func watch(_ tabID: String) async {
        frame = nil
        guard let connect = model.connect else { return }
        let environment = model.environment
        for delay in [1.0, 2.0, 4.0, nil] {
            let rpc = PathwayRPCClient { try await connect.prepare(environment: environment).webSocketURL }
            do {
                let payload: [String: JSONValue] = ["threadId": .string(model.threadID), "tabId": .string(tabID)]
                for try await value in await rpc.subscribe("preview.remote.frames", payload: .object(payload), bufferingPolicy: .bufferingNewest(1)) {
                    if let fields = value.objectValue, let decoded = PathwayRemoteBrowserFrame.decode(fields, tabID: tabID) {
                        frame = decoded
                    }
                }
                await rpc.stop()
                return
            } catch {
                await rpc.stop()
                if Task.isCancelled { return }
            }
            guard let delay else { break }
            try? await Task.sleep(for: .seconds(delay))
            if Task.isCancelled { return }
        }
        failed = true
    }
}
