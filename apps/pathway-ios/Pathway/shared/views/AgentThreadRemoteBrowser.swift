import SwiftUI
import UniformTypeIdentifiers

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

/// The page's pending prompts and downloads for one tab (`PreviewRemoteInteractionState` in
/// `packages/contracts/src/previewRemoteInteractions.ts`).
struct PathwayRemoteBrowserInteraction: Decodable, Equatable {
    struct Dialog: Decodable, Equatable {
        let dialogId: String
        let kind: String
        let message: String
        let defaultValue: String
    }
    struct FileChooser: Decodable, Equatable {
        let chooserId: String
        let multiple: Bool
    }
    struct Select: Decodable, Equatable, Identifiable {
        struct Option: Decodable, Equatable, Identifiable {
            let index: Int
            let label: String
            let value: String
            let disabled: Bool
            let selected: Bool
            var id: Int { index }
        }
        let selectId: String
        let multiple: Bool
        let options: [Option]
        var id: String { selectId }
    }
    struct Download: Decodable, Equatable, Identifiable {
        let downloadId: String
        let name: String
        let status: String
        let url: String?
        let error: String?
        var id: String { downloadId }
    }
    let tabId: String
    let dialog: Dialog?
    let fileChooser: FileChooser?
    let select: Select?
    let downloads: [Download]
}

/// Which of a tab's page prompts to present. The environment refuses answers while the agent
/// is working without a takeover, so then none present and the page waits for control instead.
/// A prompt being answered stays hidden until the environment clears it; one whose answer
/// failed is held back until the user asks for it again, so a refusal never re-opens a modal.
struct PathwayRemoteBrowserPrompts: Equatable {
    let dialog: PathwayRemoteBrowserInteraction.Dialog?
    let select: PathwayRemoteBrowserInteraction.Select?
    let chooser: PathwayRemoteBrowserInteraction.FileChooser?
    /// The page is asking something only taking control can answer.
    let waitingForControl: Bool
    /// The page is still asking something whose answer failed.
    let held: Bool

    init(_ interaction: PathwayRemoteBrowserInteraction?, answered: Set<String>, held: Set<String>, canInteract: Bool) {
        let ids = [interaction?.dialog?.dialogId, interaction?.select?.selectId, interaction?.fileChooser?.chooserId].compactMap { $0 }
        waitingForControl = !ids.isEmpty && !canInteract
        self.held = canInteract && ids.contains { held.contains($0) && !answered.contains($0) }
        guard canInteract, let interaction else { (dialog, select, chooser) = (nil, nil, nil); return }
        let hidden = answered.union(held)
        dialog = interaction.dialog.flatMap { hidden.contains($0.dialogId) ? nil : $0 }
        select = interaction.select.flatMap { hidden.contains($0.selectId) ? nil : $0 }
        chooser = interaction.fileChooser.flatMap { hidden.contains($0.chooserId) ? nil : $0 }
    }

    /// Mirrors the environment's check for browser input.
    static func canInteract(runStatuses: [String], takeoverStatus: String?) -> Bool {
        takeoverStatus == "active" || !runStatuses.contains { ["preparing", "starting", "running"].contains($0) }
    }
}

/// Maps a point in an aspect-fitted view of the page to the page's CSS pixels.
enum PathwayRemoteBrowserGeometry {
    static func point(_ location: CGPoint, in size: CGSize, page: CGSize) -> CGPoint? {
        guard page.width > 0, page.height > 0, size.width > 0, size.height > 0 else { return nil }
        let scale = min(size.width / page.width, size.height / page.height)
        let point = CGPoint(x: (location.x - (size.width - page.width * scale) / 2) / scale,
                            y: (location.y - (size.height - page.height * scale) / 2) / scale)
        return point.x >= 0 && point.y >= 0 && point.x < page.width && point.y < page.height ? point : nil
    }
}

/// Owns its browser connections; closing the browser never stops the task's subscription.
/// Pixels arrive over `surface`; tab metadata over a frame-less `preview.remote.frames`
/// subscription; the page's prompts over `preview.remote.interactions`.
@MainActor @Observable
final class PathwayRemoteBrowserModel {
    private(set) var tabs: [PathwayRemoteBrowserTab] = []
    var selectedID: String?
    private(set) var busy = false
    private(set) var isHostReady = false
    var error: String?
    private(set) var artifactURL: URL?
    private(set) var artifactURLs: [URL] = []
    private(set) var interactions: [String: PathwayRemoteBrowserInteraction] = [:]
    private(set) var uploadStatus: String?
    /// Downloads fetched to this device, ready to share or save.
    private(set) var savedDownloads: [String: URL] = [:]
    let surface: PathwayEnvironmentSurfaceStream
    @ObservationIgnored private let thread: PathwayAgentThreadModel
    @ObservationIgnored private let injectedRequest: PathwayAgentThreadModel.Request?
    @ObservationIgnored private var commandRPC: PathwayRPCClient?
    @ObservationIgnored private var httpBaseURL: URL?
    @ObservationIgnored private var metadataRevision: Double?
    @ObservationIgnored private var wheel: (point: CGPoint, deltaX: Double, deltaY: Double)?
    @ObservationIgnored private var wheelInFlight = false
    /// Where saved downloads wait to be shared; removed with the browser.
    @ObservationIgnored private let downloadsDirectory = FileManager.default.temporaryDirectory
        .appending(path: "browser-downloads/\(UUID().uuidString)")

    /// The page's file inputs accept at most this many files, this large in total, per pick.
    static let maxUploadFiles = 20
    static let maxUploadBytes = 50 * 1024 * 1024

    var takeoverStatus: String? { thread.browserTakeover?["status"]?.stringValue }
    var canTakeControl: Bool { thread.runs.contains { ["preparing", "starting", "running"].contains($0.status) } }
    /// Whether the environment accepts input from this client now.
    var canInteract: Bool {
        PathwayRemoteBrowserPrompts.canInteract(runStatuses: thread.runs.map(\.status), takeoverStatus: takeoverStatus)
    }
    func takeControl(_ action: String) async {
        do {
            var fields: [String: JSONValue] = [:]
            if action != "request", let id = thread.browserTakeover?["id"] { fields["takeoverId"] = id }
            try await thread.dispatch("thread.browser-takeover.\(action)", fields: fields)
        } catch { self.error = error.localizedDescription }
    }
    var selected: PathwayRemoteBrowserTab? { tabs.first { $0.id == selectedID } ?? tabs.first }
    var interaction: PathwayRemoteBrowserInteraction? { selected.flatMap { interactions[$0.id] } }
    var threadID: String { thread.threadID }

    init(thread: PathwayAgentThreadModel, request: PathwayAgentThreadModel.Request? = nil) {
        self.thread = thread
        injectedRequest = request
        surface = PathwayEnvironmentSurfaceStream.forThread(thread, sizing: .active)
        // Open on the page the agent is using, so watching it is one tap.
        selectedID = thread.agentRemoteBrowserTabID
    }

    deinit { try? FileManager.default.removeItem(at: downloadsDirectory) }

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

    private func request(_ method: String, _ payload: JSONValue) async throws -> JSONValue {
        if let injectedRequest { return try await injectedRequest(method, payload) }
        guard let commandRPC else { throw PathwayRPCError.disconnected }
        return try await commandRPC.request(method, payload: payload)
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
            let value = try await request("preview.remote.command", .object(payload))
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

    /// Precise page input (`preview.remote.interact`), for the selected tab unless a prompt's
    /// own tab is given: answers must reach the tab that asked, even after switching tabs.
    @discardableResult
    func interact(_ action: String, fields: [String: JSONValue] = [:], tabID: String? = nil) async -> Bool {
        guard isHostReady, let tabID = tabID ?? selected?.id else { return false }
        var payload = fields
        payload["action"] = .string(action)
        payload["threadId"] = .string(thread.threadID)
        payload["tabId"] = .string(tabID)
        do {
            _ = try await request("preview.remote.interact", .object(payload))
            return true
        } catch is CancellationError { return false }
        catch { self.error = error.localizedDescription; return false }
    }

    /// Adds a pan to the pending wheel; one message is in flight at a time, so a fast pan
    /// coalesces into as few messages as the connection can carry.
    func wheel(at point: CGPoint, deltaX: Double, deltaY: Double) {
        wheel = (point, (wheel?.deltaX ?? 0) + deltaX, (wheel?.deltaY ?? 0) + deltaY)
        guard !wheelInFlight else { return }
        wheelInFlight = true
        Task {
            while let next = wheel {
                wheel = nil
                guard await interact("wheel", fields: ["x": .number(next.point.x), "y": .number(next.point.y),
                                                       "deltaX": .number(next.deltaX), "deltaY": .number(next.deltaY)]) else { wheel = nil; break }
            }
            wheelInFlight = false
        }
    }

    /// Follows tab metadata. Without a tabId the frames subscription captures nothing.
    func watchTabs() async {
        guard isHostReady, let connect = thread.connect else { return }
        let environment = thread.environment
        for delay in [1.0, 2.0, 4.0, nil] {
            let rpc = PathwayRPCClient { try await connect.prepare(environment: environment).webSocketURL }
            do {
                let payload: JSONValue = .object(["threadId": .string(thread.threadID)])
                for try await value in await rpc.subscribe("preview.remote.frames", payload: payload, bufferingPolicy: .bufferingNewest(1)) {
                    guard let fields = value.objectValue else { continue }
                    let nextRevision: Double?
                    if case let .number(value)? = fields["metadataRevision"] { nextRevision = value } else { nextRevision = nil }
                    if let tabValues = fields["tabs"], let nextTabs = try? JSONDecoder().decode([PathwayRemoteBrowserTab].self, from: JSONEncoder().encode(tabValues)), nextTabs != tabs || (nextRevision != nil && nextRevision != metadataRevision) {
                        tabs = nextTabs
                        metadataRevision = nextRevision
                        if !tabs.contains(where: { $0.id == selectedID }) { selectedID = tabs.first?.id }
                        _ = await command("list")
                    }
                }
                await rpc.stop()
                return
            } catch {
                await rpc.stop()
                if Task.isCancelled { return }
            }
            guard let delay else { return }
            try? await Task.sleep(for: .seconds(delay))
            if Task.isCancelled { return }
        }
    }

    /// Follows the page's prompts and downloads. Subscribing is what asks the environment to
    /// present them here instead of auto-dismissing them.
    func watchInteractions() async {
        guard isHostReady, let connect = thread.connect else { return }
        let environment = thread.environment
        for delay in [1.0, 2.0, 4.0, nil] {
            let rpc = PathwayRPCClient { try await connect.prepare(environment: environment).webSocketURL }
            do {
                let payload: JSONValue = .object(["threadId": .string(thread.threadID)])
                for try await value in await rpc.subscribe("preview.remote.interactions", payload: payload, bufferingPolicy: .bufferingNewest(1)) {
                    guard let tabValues = value.objectValue?["tabs"],
                          let states = try? JSONDecoder().decode([PathwayRemoteBrowserInteraction].self, from: JSONEncoder().encode(tabValues)) else { continue }
                    interactions = Dictionary(states.map { ($0.tabId, $0) }, uniquingKeysWith: { $1 })
                }
                await rpc.stop()
                releaseInteractions()
                return
            } catch {
                await rpc.stop()
                if Task.isCancelled { releaseInteractions(); return }
            }
            guard let delay else { return }
            try? await Task.sleep(for: .seconds(delay))
            if Task.isCancelled { return }
        }
    }

    /// Unsubscribed, the environment stops holding prompts for this client; stale ones must not
    /// present when it subscribes again.
    private func releaseInteractions() { interactions = [:] }

    func respond(to dialog: PathwayRemoteBrowserInteraction.Dialog, accept: Bool, text: String, tabID: String) async -> Bool {
        var fields: [String: JSONValue] = ["dialogId": .string(dialog.dialogId), "accept": .bool(accept)]
        if dialog.kind == "prompt", accept { fields["promptText"] = .string(text) }
        return await interact("dialogRespond", fields: fields, tabID: tabID)
    }

    func choose(_ select: PathwayRemoteBrowserInteraction.Select, indices: [Int]?, tabID: String) async -> Bool {
        await interact("selectChoose", fields: ["selectId": .string(select.selectId),
                                                "indices": indices.map { .array($0.map { .number(Double($0)) }) } ?? .null],
                       tabID: tabID)
    }

    /// Uploads the picked files to the environment, then hands them to the page.
    /// Returns false when the upload or the page refused them, so the picker can be offered again.
    func respond(to chooser: PathwayRemoteBrowserInteraction.FileChooser, files: [URL], tabID: String) async -> Bool {
        guard !files.isEmpty else {
            return await interact("fileChooserRespond", fields: ["chooserId": .string(chooser.chooserId), "files": .array([])], tabID: tabID)
        }
        guard let files = checkedUploads(files) else { return false }
        uploadStatus = files.count == 1 ? "Uploading \(files[0].0.lastPathComponent)…" : "Uploading \(files.count) files…"
        defer { uploadStatus = nil }
        do {
            var uploaded: [JSONValue] = []
            for (file, size) in files { uploaded.append(try await upload(file, size: size)) }
            uploadStatus = "Sending to the page…"
            return await interact("fileChooserRespond", fields: ["chooserId": .string(chooser.chooserId), "files": .array(uploaded)], tabID: tabID)
        } catch is CancellationError { return false }
        catch { self.error = error.localizedDescription; return false }
    }

    /// Sizes the picked files, or says why the pick is too big before anything uploads.
    private func checkedUploads(_ files: [URL]) -> [(URL, Int)]? {
        guard files.count <= Self.maxUploadFiles else {
            error = "Choose up to \(Self.maxUploadFiles) files at a time."
            return nil
        }
        var sized: [(URL, Int)] = []
        for file in files {
            let access = file.startAccessingSecurityScopedResource()
            defer { if access { file.stopAccessingSecurityScopedResource() } }
            guard let size = try? file.resourceValues(forKeys: [.fileSizeKey]).fileSize, size > 0 else {
                error = "\(file.lastPathComponent) could not be read, or is empty."
                return nil
            }
            sized.append((file, size))
        }
        guard sized.reduce(0, { $0 + $1.1 }) <= Self.maxUploadBytes else {
            error = files.count == 1 ? "Choose a file under 50 MB." : "Choose files under 50 MB in total."
            return nil
        }
        return sized
    }

    /// The same upload path as composer attachments: an upload URL, then an authenticated POST.
    private func upload(_ file: URL, size: Int) async throws -> JSONValue {
        guard let connect = thread.connect else { throw PathwayRPCError.disconnected }
        let access = file.startAccessingSecurityScopedResource()
        defer { if access { file.stopAccessingSecurityScopedResource() } }
        let name = String(file.lastPathComponent.prefix(255))
        let mimeType = UTType(filenameExtension: file.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
        let value = try await request("attachments.createUploadUrl", .object([
            "name": .string(name), "type": .string("file"), "mimeType": .string(mimeType), "sizeBytes": .number(Double(size))]))
        guard let fields = value.objectValue, let attachmentID = fields["attachmentId"]?.stringValue,
              let relative = fields["relativeUrl"]?.stringValue else { throw PathwayThreadConversationError.message("The upload URL was unavailable.") }
        var upload = try await connect.authenticatedRequest(environment: thread.environment, method: "POST", path: relative)
        upload.setValue(mimeType, forHTTPHeaderField: "Content-Type")
        let (_, response) = try await URLSession.shared.upload(for: upload, fromFile: file)
        guard let response = response as? HTTPURLResponse, (200..<300).contains(response.statusCode) else {
            _ = try? await request("attachments.delete", .object(["attachmentId": .string(attachmentID)]))
            throw PathwayThreadConversationError.message("The file could not be uploaded. Try again.")
        }
        return .object(["attachmentId": .string(attachmentID), "name": .string(name), "mimeType": .string(mimeType)])
    }

    /// Fetches a finished download to this device under its own name, for the share sheet.
    func save(_ download: PathwayRemoteBrowserInteraction.Download) async {
        guard let relative = download.url, let httpBaseURL,
              let url = URL(string: relative, relativeTo: httpBaseURL)?.absoluteURL,
              url.scheme == httpBaseURL.scheme, url.host == httpBaseURL.host, url.port == httpBaseURL.port else {
            error = "The download is not available."; return
        }
        do {
            let (temporary, response) = try await URLSession.shared.download(from: url)
            guard let response = response as? HTTPURLResponse, (200..<300).contains(response.statusCode) else { throw URLError(.badServerResponse) }
            let directory = downloadsDirectory.appending(path: download.downloadId)
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            let destination = directory.appending(path: (download.name as NSString).lastPathComponent)
            try? FileManager.default.removeItem(at: destination)
            try FileManager.default.moveItem(at: temporary, to: destination)
            savedDownloads[download.downloadId] = destination
        } catch is CancellationError { return }
        catch { self.error = "Could not save \(download.name): \(error.localizedDescription)" }
    }

    /// Drops a saved download once it has been shared; Save fetches it again if needed.
    func discardSaved(_ downloadID: String) {
        guard savedDownloads.removeValue(forKey: downloadID) != nil else { return }
        try? FileManager.default.removeItem(at: downloadsDirectory.appending(path: downloadID))
    }
}

extension PathwayEnvironmentSurfaceStream {
    /// A surface stream authorized like the thread's RPC socket, including over Pathway Connect.
    static func forThread(_ thread: PathwayAgentThreadModel, sizing: PathwaySurfaceSizing) -> PathwayEnvironmentSurfaceStream {
        let connect = thread.connect, environment = thread.environment
        return PathwayEnvironmentSurfaceStream(sizing: sizing) {
            guard let connect else { throw PathwayRPCError.disconnected }
            return try await connect.prepare(environment: environment).webSocketURL
        }
    }
}

struct AgentThreadRemoteBrowser: View {
    @State private var browser: PathwayRemoteBrowserModel
    @State private var address = ""
    @State private var typing = ""
    @State private var showsPasswords = false
    @State private var showsDownloads = false
    @State private var passwordTabID: String?
    @State private var passwordOrigin: String?
    @Environment(\.scenePhase) private var scenePhase
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
                RemoteBrowserPage(browser: browser).modifier(RemoteBrowserPrompts(browser: browser))
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
                    if let downloads = browser.interaction?.downloads, !downloads.isEmpty {
                        Button("Downloads (\(downloads.count))", systemImage: "arrow.down.circle") { showsDownloads = true }
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
                        Task { await browser.stop(); await browser.start(); browser.surface.reconnect() }
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
            .sheet(isPresented: $showsDownloads) { RemoteBrowserDownloads(browser: browser) }
            .task { await browser.start() }
            .task(id: browser.isHostReady) { await browser.watchTabs() }
            // Subscribing makes the environment hold page prompts for this client, so a phone in
            // the background lets go of them, as it does of the pixels.
            .task(id: "\(browser.isHostReady):\(scenePhase == .background)") {
                guard scenePhase != .background else { return }
                await browser.watchInteractions()
            }
            .onDisappear { Task { await browser.stop() } }
            .onChange(of: browser.selected?.url) { _, url in address = url == "about:blank" ? "" : url ?? "" }
    }
    private func navigate() {
        Task { await browser.command(browser.selected == nil ? "open" : "navigate", fields: ["url": .string(address)]) }
    }
}

/// The selected tab's live page: taps click, pans scroll the page under the finger.
private struct RemoteBrowserPage: View {
    let browser: PathwayRemoteBrowserModel
    @State private var panned = CGSize.zero

    var body: some View {
        GeometryReader { geometry in
            if let tab = browser.selected {
                RemoteBrowserSurfaceView(stream: browser.surface, threadID: browser.threadID, tabID: tab.id)
                    .contentShape(Rectangle())
                    .accessibilityLabel("Remote browser page")
                    .gesture(DragGesture(minimumDistance: 10).onChanged { value in
                        guard let page = browser.surface.pageSize,
                              let point = PathwayRemoteBrowserGeometry.point(value.startLocation, in: geometry.size, page: page) else { return }
                        let scale = min(geometry.size.width / page.width, geometry.size.height / page.height)
                        let delta = CGSize(width: value.translation.width - panned.width, height: value.translation.height - panned.height)
                        panned = value.translation
                        guard scale > 0 else { return }
                        browser.wheel(at: point, deltaX: -delta.width / scale, deltaY: -delta.height / scale)
                    }.onEnded { _ in panned = .zero })
                    .simultaneousGesture(SpatialTapGesture().onEnded { value in
                        guard let page = browser.surface.pageSize,
                              let point = PathwayRemoteBrowserGeometry.point(value.location, in: geometry.size, page: page) else { return }
                        Task { await browser.command("click", fields: ["x": .number(point.x), "y": .number(point.y)]) }
                    })
                    .overlay {
                        if let status = browser.uploadStatus {
                            ProgressView(status).padding(12).background(.regularMaterial, in: .rect(cornerRadius: 12))
                        }
                    }
            } else {
                ContentUnavailableView {
                    Label("Open a website", systemImage: "globe")
                } description: {
                    Text("Enter a website address above, or open a new tab. The page runs on your connected environment.")
                } actions: {
                    Button("New tab", systemImage: "plus") { Task { await browser.command("open") } }
                }
                .frame(width: geometry.size.width, height: geometry.size.height)
            }
        }.frame(maxHeight: .infinity)
    }
}

/// Presents the selected tab's page prompts natively: dialogs as alerts, `<select>` menus as a
/// sheet, file choosers as the document picker. While the agent works without a takeover, or
/// after an answer fails, a banner says the page is asking instead of a modal covering the screen.
private struct RemoteBrowserPrompts: ViewModifier {
    let browser: PathwayRemoteBrowserModel
    @State private var answered: Set<String> = []
    @State private var held: Set<String> = []
    @State private var promptText = ""
    @State private var picking = false

    func body(content: Content) -> some View {
        let prompts = PathwayRemoteBrowserPrompts(browser.interaction, answered: answered, held: held, canInteract: browser.canInteract)
        let dialog = prompts.dialog, chooser = prompts.chooser, tabID = browser.interaction?.tabId ?? ""
        content
            .overlay(alignment: .top) {
                if prompts.waitingForControl || prompts.held { banner(prompts) }
            }
            .alert(dialog?.kind == "beforeunload" ? "Leave this page?" : "The page says",
                   isPresented: Binding(get: { dialog != nil }, set: { _ in }), presenting: dialog) { dialog in
                if dialog.kind == "prompt" { TextField("Response", text: $promptText) }
                if dialog.kind != "alert" {
                    Button(dialog.kind == "beforeunload" ? "Stay" : "Cancel", role: .cancel) { answer(dialog, accept: false, tabID: tabID) }
                }
                Button(dialog.kind == "beforeunload" ? "Leave" : "OK") { answer(dialog, accept: true, tabID: tabID) }
            } message: { dialog in
                Text(dialog.message.isEmpty && dialog.kind == "beforeunload" ? "Changes you made may not be saved." : dialog.message)
            }
            .onChange(of: dialog?.dialogId) { promptText = dialog?.defaultValue ?? "" }
            .sheet(item: Binding(get: { prompts.select }, set: { next in
                // Swiping the sheet away cancels the menu, as Escape does in the page.
                if next == nil, let select = prompts.select { choose(select, indices: nil, tabID: tabID) }
            })) { select in
                RemoteBrowserSelectSheet(select: select) { choose(select, indices: $0, tabID: tabID) }
            }
            .onChange(of: chooser?.chooserId) { picking = chooser != nil }
            .fileImporter(isPresented: $picking, allowedContentTypes: [.item], allowsMultipleSelection: chooser?.multiple ?? false) { result in
                if let chooser { pick(chooser, files: (try? result.get()) ?? [], tabID: tabID) }
            } onCancellation: {
                if let chooser { pick(chooser, files: [], tabID: tabID) }
            }
            // Gaining control is the moment a held prompt can be answered.
            .onChange(of: browser.canInteract) { _, canInteract in if canInteract { held = [] } }
    }

    private func banner(_ prompts: PathwayRemoteBrowserPrompts) -> some View {
        HStack(spacing: 10) {
            Image(systemName: "questionmark.bubble")
            if prompts.waitingForControl {
                Text("The page is asking for a response. Take control to answer.")
                if browser.canTakeControl && !["requested", "pausing", "proceeding", "active"].contains(browser.takeoverStatus ?? "") {
                    Button("Take control") { Task { await browser.takeControl("request") } }.bold()
                }
            } else {
                Text("The page is still asking for a response.")
                Button("Answer") { held = [] }.bold()
            }
        }
        .font(.caption)
        .padding(.horizontal, 12).padding(.vertical, 8)
        .background(.regularMaterial, in: .rect(cornerRadius: 12))
        .padding(8)
        .accessibilityElement(children: .combine)
    }

    /// Sends the pick, or the cancel as no files. The answer goes to the tab that asked, even if
    /// another tab is selected by the time the upload finishes.
    private func pick(_ chooser: PathwayRemoteBrowserInteraction.FileChooser, files: [URL], tabID: String) {
        answer(chooser.chooserId) { await browser.respond(to: chooser, files: files, tabID: tabID) }
    }

    private func answer(_ dialog: PathwayRemoteBrowserInteraction.Dialog, accept: Bool, tabID: String) {
        let text = promptText
        answer(dialog.dialogId) { await browser.respond(to: dialog, accept: accept, text: text, tabID: tabID) }
    }

    private func choose(_ select: PathwayRemoteBrowserInteraction.Select, indices: [Int]?, tabID: String) {
        answer(select.selectId) { await browser.choose(select, indices: indices, tabID: tabID) }
    }

    /// Hides the prompt while its answer is sent. If the answer fails, it is held behind the
    /// banner rather than presented again, so a refusal cannot trap the screen in a modal.
    private func answer(_ id: String, send: @escaping () async -> Bool) {
        guard answered.insert(id).inserted else { return }
        Task {
            guard !(await send()) else { return }
            answered.remove(id)
            held.insert(id)
        }
    }
}

private struct RemoteBrowserSelectSheet: View {
    let select: PathwayRemoteBrowserInteraction.Select
    let choose: ([Int]?) -> Void
    @State private var chosen: Set<Int>

    init(select: PathwayRemoteBrowserInteraction.Select, choose: @escaping ([Int]?) -> Void) {
        self.select = select
        self.choose = choose
        _chosen = State(initialValue: Set(select.options.filter(\.selected).map(\.index)))
    }

    var body: some View {
        NavigationStack {
            List(select.options) { option in
                Button {
                    if select.multiple {
                        if chosen.contains(option.index) { chosen.remove(option.index) } else { chosen.insert(option.index) }
                    } else { choose([option.index]) }
                } label: {
                    HStack {
                        Text(option.label.isEmpty ? option.value : option.label).foregroundStyle(.primary)
                        Spacer()
                        if select.multiple ? chosen.contains(option.index) : option.selected {
                            Image(systemName: "checkmark").foregroundStyle(.tint)
                        }
                    }
                }
                .disabled(option.disabled)
            }
            .navigationTitle("Choose an option")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { choose(nil) } }
                if select.multiple {
                    ToolbarItem(placement: .confirmationAction) { Button("Done") { choose(chosen.sorted()) } }
                }
            }
        }
        .presentationDetents([.medium, .large])
    }
}

/// Files the page downloaded on the environment. Save fetches one to this device, then Share
/// hands it to the system share sheet, which includes Save to Files.
private struct RemoteBrowserDownloads: View {
    let browser: PathwayRemoteBrowserModel
    @Environment(\.dismiss) private var dismiss
    @State private var saving: Set<String> = []
    @State private var sharing: PathwayRemoteBrowserSavedDownload?

    var body: some View {
        NavigationStack {
            List(browser.interaction?.downloads ?? []) { download in
                HStack {
                    Text(download.name).lineLimit(1)
                    Spacer()
                    if let local = browser.savedDownloads[download.downloadId] {
                        Button("Share", systemImage: "square.and.arrow.up") {
                            sharing = PathwayRemoteBrowserSavedDownload(id: download.downloadId, url: local)
                        }
                    } else if download.status == "ready" {
                        if saving.contains(download.downloadId) { ProgressView() } else {
                            Button("Save") {
                                saving.insert(download.downloadId)
                                Task { await browser.save(download); saving.remove(download.downloadId) }
                            }
                        }
                    } else if download.status == "failed" {
                        Text("Failed").foregroundStyle(.red).help(download.error ?? "")
                    } else {
                        Text("Downloading…").foregroundStyle(.secondary)
                    }
                }
            }
            .overlay { if browser.interaction?.downloads.isEmpty ?? true { ContentUnavailableView("No downloads", systemImage: "arrow.down.circle") } }
            .navigationTitle("Downloads")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
        .presentationDetents([.medium, .large])
        .sheet(item: $sharing) { saved in
            RemoteBrowserShareSheet(url: saved.url) { browser.discardSaved(saved.id) }
        }
    }
}

private struct PathwayRemoteBrowserSavedDownload: Identifiable {
    let id: String
    let url: URL
}

/// The system share sheet, reporting when it closes so the local copy can go.
private struct RemoteBrowserShareSheet: UIViewControllerRepresentable {
    let url: URL
    let finished: () -> Void

    func makeUIViewController(context: Context) -> UIActivityViewController {
        let controller = UIActivityViewController(activityItems: [url], applicationActivities: nil)
        controller.completionWithItemsHandler = { _, _, _, _ in finished() }
        return controller
    }

    func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}

/// Live strip above the composer while the agent browses in the environment's browser.
/// Tapping it opens the full remote browser on the same tab, where control can be taken.
struct AgentThreadRemoteBrowserPreview: View {
    let model: PathwayAgentThreadModel
    let open: () -> Void
    @State private var stream: PathwayEnvironmentSurfaceStream?
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
                if let stream {
                    // The surface stays mounted while failed: its task keeps retrying on its own.
                    Button(action: open) {
                        RemoteBrowserSurfaceView(stream: stream, threadID: model.threadID, tabID: tabID, compact: true)
                            .frame(maxWidth: .infinity).frame(height: 200)
                            .clipShape(.rect(cornerRadius: 12))
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Live view of the agent's browser. Opens the remote browser.")
                    .overlay {
                        if stream.state == .failed && !stream.hasFrame {
                            VStack(spacing: 8) {
                                Text("The remote browser disconnected. Retrying…").font(.caption).foregroundStyle(.secondary)
                                Button("Reconnect now") { stream.reconnect() }.font(.caption.bold())
                            }
                            .padding(12)
                            .background(.regularMaterial, in: .rect(cornerRadius: 12))
                        }
                    }
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
            // Watches without sizing the page, so the strip never shrinks the agent's page.
            .onAppear { if stream == nil { stream = .forThread(model, sizing: .passive) } }
        }
    }
}
