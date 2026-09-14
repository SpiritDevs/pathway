import SwiftUI
import PhotosUI
import UniformTypeIdentifiers
import ImageIO

struct AgentOrchestratorView: View {
    var isSeparateWindow = false
    @Environment(PathwayAppModel.self) private var appModel
    @Environment(\.dismiss) private var dismiss
    @Environment(\.dismissWindow) private var dismissWindow
    @State private var search = ""
    @State private var creating = false
    @State private var archived = false
    private var model: PathwayOrchestratorsModel { appModel.cloud.orchestrators }

    var body: some View {
        NavigationStack {
            List {
                if let error = model.errorMessage { Text(error).foregroundStyle(.red) }
                if model.loading { ProgressView("Loading conversations…") }
                ForEach(model.chats.filter { $0.flag("archived") == archived && (search.isEmpty || $0.string("title").localizedCaseInsensitiveContains(search)) }) { chat in
                    Button { model.selectedID = chat.id } label: {
                        HStack(spacing: 12) {
                            PathwayOrchestratorAvatar(name: chat.string("title"), color: "blue")
                            VStack(alignment: .leading, spacing: 5) {
                                HStack { Text(chat.string("title")).font(.headline); Spacer(); if chat.number("lastSequence") > chat.number("readSequence") { Circle().fill(.blue).frame(width: 8, height: 8) } }
                                Text(chat.string("lastMessage").isEmpty ? "Start a conversation" : chat.string("lastMessage")).lineLimit(2).font(.subheadline).foregroundStyle(.secondary)
                            }
                        }.padding(.vertical, 5)
                    }.tint(.primary)
                }
                if !archived {
                    Section("Your orchestrators") {
                        ForEach(model.contacts.filter { $0.string("status") != "archived" }) { contact in
                            Button {
                                Task { do { _ = try await model.conversation(title: contact.string("name"), orchestratorIDs: [contact.id], companyIDs: contact.string("companyId").isEmpty ? [] : [contact.string("companyId")]) } catch { model.errorMessage = error.localizedDescription } }
                            } label: { Label(contact.string("name"), systemImage: "person.crop.circle") }
                            .disabled(!contact.flag("canDirect"))
                        }
                    }
                }
            }
            .listStyle(.insetGrouped)
            .navigationTitle("Orchestrators")
            .safeAreaInset(edge: .bottom) {
                Button { archived.toggle() } label: {
                    Label(archived ? "Show conversations" : "Archived conversations", systemImage: "archivebox")
                        .frame(maxWidth: .infinity, alignment: .leading).padding()
                }.background(.regularMaterial)
            }
            .searchable(text: $search, prompt: "Search conversations")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Done", action: close) }
                ToolbarItem(placement: .primaryAction) { Button("New conversation", systemImage: "square.and.pencil") { creating = true } }
            }
            .navigationDestination(item: Binding(get: { model.selectedID }, set: { model.selectedID = $0 })) { id in
                if let chat = model.chats.first(where: { $0.id == id }) { PathwayOrchestratorConversation(chat: chat, onOpenWork: close) }
            }
            .sheet(isPresented: $creating) { PathwayNewOrchestratorConversation() }
        }
        .task(id: appModel.accountID) { if let id = appModel.accountID { model.start(accountID: id, companyIDs: appModel.cloud.companies.map(\.id)) } }
        .accessibilityIdentifier("agent-orchestrator-view")
    }
    private func close() {
        #if os(visionOS)
        if isSeparateWindow { dismissWindow(id: PathwayWindow.agentOrchestrator.rawValue) } else { dismiss() }
        #else
        dismiss()
        #endif
    }
}

struct PathwayOrchestratorAvatar: View {
    let name: String
    let color: String
    private var tint: Color { switch color { case "green", "emerald": .green; case "blue": .blue; case "orange": .orange; case "pink": .pink; default: .purple } }
    var body: some View { Text(String(name.prefix(1)).uppercased()).font(.headline).foregroundStyle(.white).frame(width: 40, height: 40).background(tint, in: Circle()).accessibilityHidden(true) }
}

private struct PathwayThinkingAvatar: View {
    let contact: PathwayOrchestratorRecord
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        TimelineView(.animation(minimumInterval: 0.15, paused: reduceMotion || scenePhase != .active)) { context in
            let phase = context.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 2)
            PathwayOrchestratorAvatar(name: contact.string("name"), color: contact.string("color"))
                .scaleEffect(0.5).frame(width: 20, height: 20)
                .opacity(reduceMotion ? 1 : 0.65 + 0.35 * abs(phase - 1))
        }
    }
}

private struct PathwayOrchestratorTimelineEntry: Identifiable {
    let record: PathwayOrchestratorRecord
    let isWork: Bool
    var id: String { "\(isWork ? "work" : "message"):\(record.id)" }
}

private struct PathwayOrchestratorConversation: View {
    let chat: PathwayOrchestratorRecord
    let onOpenWork: () -> Void
    @Environment(PathwayAppModel.self) private var appModel
    @Environment(\.scenePhase) private var scenePhase
    @State private var details = false
    @State private var sending = false
    @State private var targetID = ""
    @State private var followsLatest = true
    @State private var showsFiles = false
    @State private var showsPhotos = false
    @State private var selectedPhotos: [PhotosPickerItem] = []
    private var attachmentDrafts: [PathwayThreadAttachmentDraft] { model.attachmentDrafts[chat.id] ?? [] }
    private var destinationID: String { targetID.isEmpty ? current.string("leadId") : targetID }
    private var canDirect: Bool { model.contacts.first { $0.id == destinationID }?.flag("canDirect") == true }
    private var model: PathwayOrchestratorsModel { appModel.cloud.orchestrators }
    private var current: PathwayOrchestratorRecord { model.chats.first { $0.id == chat.id } ?? chat }
    private var messages: [PathwayOrchestratorRecord] { model.messages[chat.id] ?? [] }
    private var timeline: [PathwayOrchestratorTimelineEntry] {
        let work = (model.work[chat.id] ?? []).sorted {
            if $0.number("createdAt") != $1.number("createdAt") {
                return $0.number("createdAt") < $1.number("createdAt")
            }
            return $0.id < $1.id
        }
        var entries: [PathwayOrchestratorTimelineEntry] = []
        var cursor = 0
        for message in messages {
            while cursor < work.count && work[cursor].number("createdAt") < message.number("createdAt") {
                entries.append(.init(record: work[cursor], isWork: true))
                cursor += 1
            }
            entries.append(.init(record: message, isWork: false))
        }
        entries.append(contentsOf: work.dropFirst(cursor).map { .init(record: $0, isWork: true) })
        return entries
    }
    private var activityDeadlines: [Date] {
        ([Date()] + (model.activity[chat.id] ?? []).map {
            Date(timeIntervalSince1970: Double($0.number("expiresAt")) / 1000)
        }).sorted()
    }
    private func activeContacts(at date: Date) -> [PathwayOrchestratorRecord] {
        model.contacts.filter { contact in
            current.strings("orchestratorIds").contains(contact.id) &&
                (model.activity[chat.id] ?? []).contains {
                    $0.id == contact.id && Double($0.number("expiresAt")) > date.timeIntervalSince1970 * 1000
                }
        }
    }
    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 18) {
                    if model.nextBefore[chat.id] != nil { Button("Earlier messages") { Task { do { try await model.loadEarlier(chat.id) } catch { model.errorMessage = error.localizedDescription } } }.frame(maxWidth: .infinity) }
                    if messages.isEmpty { ContentUnavailableView("A continuing conversation", systemImage: "bubble.left.and.bubble.right", description: Text("Share what you need, and your orchestrators will coordinate the work.")) }
                    ForEach(timeline) { entry in
                        if entry.isWork { workCard(entry.record) }
                        else { bubble(entry.record) }
                    }
                    Color.clear.frame(height: 1).id("latest").onAppear { followsLatest = true }.onDisappear { followsLatest = false }
                }.padding()
            }
            .defaultScrollAnchor(.bottom)
            .onChange(of: timeline.map(\.id)) { if followsLatest { proxy.scrollTo("latest", anchor: .bottom) } }
        }
        .safeAreaInset(edge: .bottom) {
            VStack(spacing: 8) {
                if let error = model.errorMessage { Text(error).font(.caption).foregroundStyle(.red).padding(.horizontal) }
                if !current.flag("archived") {
                    TimelineView(.explicit(activityDeadlines)) { timeline in
                        VStack(alignment: .leading, spacing: 6) {
                            ForEach(activeContacts(at: timeline.date)) { contact in
                                HStack(spacing: 6) {
                                    PathwayThinkingAvatar(contact: contact)
                                    Text("\(contact.string("name")) is thinking").font(.caption).foregroundStyle(.secondary)
                                }
                            }
                        }.frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal)
                    }
                }
                if current.strings("orchestratorIds").count > 1 {
                    Picker("Address orchestrator", selection: $targetID) {
                        Text("Conversation lead").tag("")
                        ForEach(model.contacts.filter { current.strings("orchestratorIds").contains($0.id) }) { Text($0.string("name")).tag($0.id) }
                    }.pickerStyle(.menu).font(.caption)
                }
                if !attachmentDrafts.isEmpty {
                    ScrollView(.horizontal) { HStack(spacing: 8) {
                        ForEach(attachmentDrafts) { attachment in
                            AgentThreadComposerAttachmentChip(attachment: attachment,
                                remove: { Task { await model.removeAttachment(chatID: chat.id, id: attachment.id) } },
                                retry: { Task { await model.retryAttachment(chatID: chat.id, targetID: destinationID, id: attachment.id) } })
                        }
                    }.padding(.horizontal) }.scrollIndicators(.hidden).disabled(sending)
                }
                HStack(alignment: .bottom, spacing: 10) {
                    Menu {
                        Button("Photos", systemImage: "photo.on.rectangle") { showsPhotos = true }
                        Button("Choose files", systemImage: "folder") { showsFiles = true }
                        PasteButton(supportedContentTypes: [.image]) { providers in
                            Task { for provider in providers.filter(PathwayPastedImage.supports) {
                                do { let image = try await PathwayPastedImage.load(provider); await model.addAttachment(chatID: chat.id, targetID: destinationID, data: image.data, name: image.name, mimeType: image.mimeType) }
                                catch { model.errorMessage = error.localizedDescription }
                            } }
                        }
                    } label: { Image(systemName: "paperclip").frame(width: 44, height: 44) }
                    .accessibilityLabel("Attach images and files").disabled(sending || current.flag("archived") || !canDirect || attachmentDrafts.count >= 8)
                    TextField("Message \(current.string("title"))", text: Binding(get: { model.drafts[chat.id] ?? "" }, set: { model.drafts[chat.id] = $0 }), axis: .vertical).lineLimit(1...6).disabled(sending || current.flag("archived")).padding(12).background(.quaternary, in: RoundedRectangle(cornerRadius: 24))
                    Button {
                        sending = true
                        Task { defer { sending = false }; do { try await model.send(chatID: chat.id, targetID: targetID.isEmpty ? nil : targetID) } catch { model.errorMessage = error.localizedDescription } }
                    } label: { Image(systemName: "arrow.up").font(.headline).foregroundStyle(.white).frame(width: 40, height: 40).background(.blue, in: Circle()) }
                    .accessibilityLabel("Send message").disabled(sending || !canDirect || !attachmentDrafts.allSatisfy { $0.state == .ready } || ((model.drafts[chat.id] ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && attachmentDrafts.isEmpty) || current.flag("archived"))
                }.padding(.horizontal).padding(.bottom, 8)
            }.background(.regularMaterial)
        }
        .fileImporter(isPresented: $showsFiles, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
            switch result {
            case .success(let urls): Task { for url in urls { await model.addAttachment(chatID: chat.id, targetID: destinationID, fileURL: url) } }
            case .failure(let error): model.errorMessage = error.localizedDescription
            }
        }
        .photosPicker(isPresented: $showsPhotos, selection: $selectedPhotos, maxSelectionCount: max(1, 8 - attachmentDrafts.count), matching: .images, preferredItemEncoding: .compatible)
        .onChange(of: selectedPhotos) { _, photos in
            selectedPhotos = []
            Task { for (index, photo) in photos.enumerated() {
                do {
                    guard let data = try await photo.loadTransferable(type: Data.self) else { continue }
                    let source = CGImageSourceCreateWithData(data as CFData, nil)
                    let type = source.flatMap { CGImageSourceGetType($0) }.flatMap { UTType($0 as String) } ?? .jpeg
                    await model.addAttachment(chatID: chat.id, targetID: destinationID, data: data, name: "Photo \(index + 1).\(type.preferredFilenameExtension ?? "jpg")", mimeType: type.preferredMIMEType ?? "image/jpeg")
                } catch { model.errorMessage = error.localizedDescription }
            } }
        }
        .navigationTitle(current.string("title"))
        .toolbar { ToolbarItem(placement: .primaryAction) { Button("Conversation details", systemImage: "info.circle") { details = true } } }
        .sheet(isPresented: $details) { PathwayOrchestratorParticipants(chat: current) }
        .task(id: "\(chat.id):\(scenePhase == .active)") { if scenePhase == .active { await model.observeConversation(chat.id) } }
    }
    private func workCard(_ item: PathwayOrchestratorRecord) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Label(item.string("title"), systemImage: "checklist").font(.headline)
            Text(item.string("status").capitalized).font(.caption).foregroundStyle(.secondary)
            Text(item.string("detail")).font(.subheadline)
            if let selection = item.fields["selection"]?.objectValue,
               let model = selection["model"]?.stringValue {
                Text("Worker: \(model)").font(.caption).foregroundStyle(.secondary)
            }
            if !item.string("selectionReason").isEmpty {
                Text(item.string("selectionReason")).font(.caption).foregroundStyle(.secondary)
            }
            if !item.string("threadId").isEmpty {
                Button("Open thread") {
                    guard let project = appModel.cloud.projects.first(where: { $0.project.id == item.string("projectId") }) else { model.errorMessage = "This project's environment is unavailable."; return }
                    appModel.pendingThreadRoute = .init(companyId: project.companyId, environmentId: item.string("environmentId"), threadId: item.string("threadId")); onOpenWork()
                }
            }
        }.padding().frame(maxWidth: .infinity, alignment: .leading).background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 18))
    }
    private func receipt(_ message: PathwayOrchestratorRecord, own: Bool) -> String {
        let status = message.string("status")
        if own && (status == "working" || (status == "sent" && message.number("seenAt") > 0)) { return "Seen" }
        if own && status == "sent" { return "Delivered" }
        if status == "working" { return "Coordinating…" }
        let prefix = own && message.number("seenAt") > 0 ? "Seen · " : ""
        return status == "sent" ? "" : prefix + status.capitalized
    }
    @ViewBuilder private func bubble(_ message: PathwayOrchestratorRecord) -> some View {
        let own = message.string("senderKind") == "user" && message.string("senderId") == appModel.accountID
        if message.string("senderKind") == "system" {
            Text(message.string("senderId") == "delegated-work" ? "Delegated work updated" : message.string("text")).font(.caption).foregroundStyle(.secondary).frame(maxWidth: .infinity)
        } else {
            HStack {
                if own { Spacer(minLength: 36) }
                VStack(alignment: own ? .trailing : .leading, spacing: 5) {
                    Text(own ? "You" : message.string("senderName")).font(.caption2).foregroundStyle(.secondary)
                    ForEach(PathwayOrchestratorRecord.records(message.fields["attachments"] ?? .array([]))) { attachment in
                        PathwayOrchestratorAttachmentView(attachment: attachment)
                    }
                    Group {
                        if own { Text(message.string("text")) }
                        else { AgentTranscriptMarkdown(markdown: message.string("text")).equatable() }
                    }.textSelection(.enabled).padding(12).foregroundStyle(own ? Color.white : Color.primary).background(own ? Color.blue : Color.secondary.opacity(0.12), in: RoundedRectangle(cornerRadius: 20))
                    HStack {
                        Text(receipt(message, own: own)).font(.caption2).foregroundStyle(.secondary)
                        if own && ["queued", "failed"].contains(message.string("status")) {
                            Button(message.string("status") == "queued" ? "Cancel" : "Retry") { Task { do { try await model.mutate(message.string("status") == "queued" ? "cancelMessage" : "retryMessage", ["chatId": .string(chat.id), "messageId": .string(message.id)]) } catch { model.errorMessage = error.localizedDescription } } }.font(.caption2)
                        }
                    }
                }
                if !own { Spacer(minLength: 36) }
            }
        }
    }
}

private struct PathwayNewOrchestratorConversation: View {
    @Environment(PathwayAppModel.self) private var appModel
    @Environment(\.dismiss) private var dismiss
    @State private var title = ""
    @State private var selected: [String] = []
    @State private var saving = false
    @State private var error: String?
    var body: some View {
        NavigationStack {
            Form {
                TextField("Conversation name", text: $title)
                Section("Orchestrators") {
                    ForEach(appModel.cloud.orchestrators.contacts.filter { $0.flag("canDirect") && $0.string("status") != "archived" }) { contact in
                        Toggle(contact.string("name"), isOn: Binding(get: { selected.contains(contact.id) }, set: { if $0 { selected.append(contact.id) } else { selected.removeAll { $0 == contact.id } } }))
                    }
                }
                Text("The first selected orchestrator leads the conversation. You can change the lead and add people in conversation details.").font(.footnote).foregroundStyle(.secondary)
                if let error { Text(error).foregroundStyle(.red) }
            }.navigationTitle("New conversation").toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) { Button("Create") {
                    saving = true
                    Task { defer { saving = false }; do { let contacts = appModel.cloud.orchestrators.contacts.filter { selected.contains($0.id) }; _ = try await appModel.cloud.orchestrators.conversation(title: title.isEmpty ? contacts.map { $0.string("name") }.joined(separator: " + ") : title, orchestratorIDs: selected, companyIDs: Array(Set(contacts.map { $0.string("companyId") }.filter { !$0.isEmpty }))); dismiss() } catch { self.error = error.localizedDescription } }
                }.disabled(saving || selected.isEmpty) }
            }
        }
    }
}


private struct PathwayOrchestratorAttachmentView: View {
    let attachment: PathwayOrchestratorRecord
    @Environment(PathwayAppModel.self) private var appModel
    @State private var image: UIImage?
    @State private var fileURL: URL?
    @State private var loading = false
    @State private var error: String?
    @State private var preview = false
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let image { Button { preview = true } label: { Image(uiImage: image).resizable().scaledToFit().frame(maxWidth: 240, maxHeight: 200) }.accessibilityLabel("Preview \(attachment.string("name"))") }
            else { Button { Task { await load() } } label: { Label(attachment.string("name"), systemImage: "doc") }.disabled(loading) }
            if loading { ProgressView("Loading attachment…") }
            if let fileURL { ShareLink(item: fileURL) { Label("Save or share \(attachment.string("name"))", systemImage: "square.and.arrow.up") } }
            if let error { Text(error).font(.caption).foregroundStyle(.red); Button("Retry") { Task { await load() } } }
        }.padding(8).background(.quaternary, in: RoundedRectangle(cornerRadius: 12))
        .task(id: attachment.id) { if attachment.string("type") == "image" { await load() } }
        .sheet(isPresented: $preview) {
            if let image {
                NavigationStack {
                    Image(uiImage: image).resizable().scaledToFit()
                        .navigationTitle(attachment.string("name"))
                        .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { preview = false } } }
                }
            }
        }
        .onDisappear { if let fileURL { try? FileManager.default.removeItem(at: fileURL.deletingLastPathComponent()) }; fileURL = nil; image = nil }
    }
    private func load() async {
        guard !loading else { return }
        loading = true; error = nil
        defer { loading = false }
        do {
            let data = try await appModel.downloadOrchestratorAttachment(id: attachment.id)
            try Task.checkCancellation()
            if attachment.string("type") == "image" {
                let thumbnail = await Task.detached(priority: .utility) {
                    guard let source = CGImageSourceCreateWithData(data as CFData, nil),
                          let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [
                            kCGImageSourceCreateThumbnailFromImageAlways: true,
                            kCGImageSourceCreateThumbnailWithTransform: true,
                            kCGImageSourceThumbnailMaxPixelSize: 1600,
                            kCGImageSourceShouldCacheImmediately: true
                          ] as CFDictionary) else { return Data?.none }
                    return UIImage(cgImage: image).pngData()
                }.value
                try Task.checkCancellation()
                if let thumbnail { image = UIImage(data: thumbnail) }
            }
            let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            let name = URL(fileURLWithPath: attachment.string("name")).lastPathComponent
            let url = directory.appendingPathComponent(name.isEmpty ? "attachment" : name)
            try data.write(to: url); fileURL = url
        } catch { self.error = error.localizedDescription }
    }
}
