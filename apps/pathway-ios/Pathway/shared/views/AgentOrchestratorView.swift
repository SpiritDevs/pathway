import SwiftUI

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
                Button(archived ? "Show conversations" : "Archived conversations") { archived.toggle() }
            }
            .listStyle(.insetGrouped)
            .navigationTitle("Conversations")
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

private struct PathwayOrchestratorConversation: View {
    let chat: PathwayOrchestratorRecord
    let onOpenWork: () -> Void
    @Environment(PathwayAppModel.self) private var appModel
    @Environment(\.scenePhase) private var scenePhase
    @State private var details = false
    @State private var sending = false
    @State private var targetID = ""
    @State private var followsLatest = true
    private var model: PathwayOrchestratorsModel { appModel.cloud.orchestrators }
    private var current: PathwayOrchestratorRecord { model.chats.first { $0.id == chat.id } ?? chat }
    private var messages: [PathwayOrchestratorRecord] { model.messages[chat.id] ?? [] }
    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 18) {
                    if model.nextBefore[chat.id] != nil { Button("Earlier messages") { Task { do { try await model.loadEarlier(chat.id) } catch { model.errorMessage = error.localizedDescription } } }.frame(maxWidth: .infinity) }
                    if messages.isEmpty { ContentUnavailableView("A continuing conversation", systemImage: "bubble.left.and.bubble.right", description: Text("Share what you need, and your orchestrators will coordinate the work.")) }
                    ForEach(messages) { message in bubble(message).id(message.id) }
                    ForEach(model.work[chat.id] ?? []) { item in
                        VStack(alignment: .leading, spacing: 8) {
                            Label(item.string("title"), systemImage: "checklist").font(.headline)
                            Text(item.string("status").capitalized).font(.caption).foregroundStyle(.secondary)
                            Text(item.string("detail")).font(.subheadline)
                            if !item.string("threadId").isEmpty {
                                Button("Open thread") {
                                    guard let project = appModel.cloud.projects.first(where: { $0.project.id == item.string("projectId") }) else { model.errorMessage = "This project's environment is unavailable."; return }
                                    appModel.pendingThreadRoute = .init(companyId: project.companyId, environmentId: item.string("environmentId"), threadId: item.string("threadId")); onOpenWork()
                                }
                            }
                        }.padding().frame(maxWidth: .infinity, alignment: .leading).background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 18))
                    }
                    Color.clear.frame(height: 1).id("latest").onAppear { followsLatest = true }.onDisappear { followsLatest = false }
                }.padding()
            }
            .defaultScrollAnchor(.bottom)
            .onChange(of: messages.last?.id) { if followsLatest { proxy.scrollTo("latest", anchor: .bottom) } }
        }
        .safeAreaInset(edge: .bottom) {
            VStack(spacing: 8) {
                if let error = model.errorMessage { Text(error).font(.caption).foregroundStyle(.red).padding(.horizontal) }
                if current.strings("orchestratorIds").count > 1 {
                    Picker("Address orchestrator", selection: $targetID) {
                        Text("Conversation lead").tag("")
                        ForEach(model.contacts.filter { current.strings("orchestratorIds").contains($0.id) }) { Text($0.string("name")).tag($0.id) }
                    }.pickerStyle(.menu).font(.caption)
                }
                HStack(alignment: .bottom, spacing: 10) {
                    TextField("Message \(current.string("title"))", text: Binding(get: { model.drafts[chat.id] ?? "" }, set: { model.drafts[chat.id] = $0 }), axis: .vertical).lineLimit(1...6).padding(12).background(.quaternary, in: RoundedRectangle(cornerRadius: 24))
                    Button {
                        sending = true
                        Task { defer { sending = false }; do { try await model.send(chatID: chat.id, targetID: targetID.isEmpty ? nil : targetID) } catch { model.errorMessage = error.localizedDescription } }
                    } label: { Image(systemName: "arrow.up").font(.headline).foregroundStyle(.white).frame(width: 40, height: 40).background(.blue, in: Circle()) }
                    .accessibilityLabel("Send message").disabled(sending || (model.drafts[chat.id] ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || current.flag("archived"))
                }.padding(.horizontal).padding(.bottom, 8)
            }.background(.regularMaterial)
        }
        .navigationTitle(current.string("title"))
        .toolbar { ToolbarItem(placement: .primaryAction) { Button("Conversation details", systemImage: "info.circle") { details = true } } }
        .sheet(isPresented: $details) { PathwayOrchestratorParticipants(chat: current) }
        .task(id: "\(chat.id):\(scenePhase == .active)") { if scenePhase == .active { await model.observeConversation(chat.id) } }
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
                    Group {
                        if own { Text(message.string("text")) }
                        else { AgentTranscriptMarkdown(markdown: message.string("text")).equatable() }
                    }.textSelection(.enabled).padding(12).foregroundStyle(own ? Color.white : Color.primary).background(own ? Color.blue : Color.secondary.opacity(0.12), in: RoundedRectangle(cornerRadius: 20))
                    HStack {
                        Text(message.string("status") == "working" ? "Coordinating…" : message.string("status").capitalized).font(.caption2).foregroundStyle(.secondary)
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
