import SwiftUI

/// A queued thread remains readable while its destination is disconnected.
struct PathwayQueuedThreadView: View {
    @Environment(PathwayAppModel.self) private var appModel
    let thread: PathwayQueuedThread
    @State private var messages: [JSONValue] = []
    @State private var errorMessage: String?
    @State private var editingCommand: String?
    @State private var editingRevision = 0
    @State private var editText = ""
    @State private var isEditing = false
    @State private var showMove = false
    @State private var nextMessage = ""
    @State private var sending = false

    private var current: PathwayQueuedThread { appModel.cloud.threadQueue.threads.first { $0.id == thread.id } ?? thread }

    var body: some View {
        List {
            Section {
                Label(current.status, systemImage: "tray.and.arrow.up")
                if let environment = appModel.cloud.environments.first(where: {
                    $0.companyId == current.companyID && $0.environment.environmentId == current.environmentID
                }) {
                    Text(environment.environment.label).foregroundStyle(.secondary)
                    if environment.environment.descriptor.capabilities?["durableThreadQueue"]?.boolValue != true {
                        Label("Update Pathway on this environment to run queued messages.", systemImage: "arrow.down.circle")
                            .font(.footnote).foregroundStyle(.secondary)
                    }
                }
                if let error = current.fields["error"]?.stringValue { Text(error).foregroundStyle(.red) }
                Text("Queued messages run when this environment reconnects, even if you close the app.")
                    .font(.footnote).foregroundStyle(.secondary)
            }
            Section("Messages") {
                ForEach(Array(messages.enumerated()), id: \.element.queueCommandID) { _, value in
                    let fields = value.objectValue ?? [:]
                    let submission = fields["submission"]?.objectValue ?? [:]
                    let input = submission["input"]?.objectValue ?? [:]
                    let text = input["initialMessage"]?.objectValue?["text"]?.stringValue ?? input["text"]?.stringValue ?? ""
                    VStack(alignment: .leading, spacing: 8) {
                        Text(text).textSelection(.enabled)
                        Text(fields["state"]?.stringValue ?? "queued").font(.caption).foregroundStyle(.secondary)
                        if let error = fields["error"]?.stringValue { Text(error).font(.caption).foregroundStyle(.red) }
                        if fields["editable"]?.boolValue == true || (["queued", "blocked"].contains(fields["state"]?.stringValue ?? "") && fields["acceptedAt"] == .null) {
                            HStack {
                                Button("Edit") {
                                    editingCommand = fields["commandId"]?.stringValue
                                    editingRevision = fields["revision"]?.intValue ?? 0
                                    editText = text; isEditing = true
                                }
                                Button("Cancel", role: .destructive) {
                                    perform("cancel", fields: ["commandId": fields["commandId"] ?? .null,
                                                               "revision": fields["revision"] ?? .number(0)])
                                }
                                if fields["state"]?.stringValue == "blocked" {
                                    Button("Retry") { perform("retry", fields: ["commandId": fields["commandId"] ?? .null, "revision": fields["revision"] ?? .number(0)]) }
                                }
                            }.buttonStyle(.borderless)
                        } else if ["blocked", "canceled"].contains(fields["state"]?.stringValue ?? "") {
                            Button("Retry") { perform("retry", fields: ["commandId": fields["commandId"] ?? .null, "revision": fields["revision"] ?? .number(0)]) }
                        }
                    }.padding(.vertical, 4)
                }
            }
            Section {
                TextField("Add a message to the queue", text: $nextMessage, axis: .vertical)
                Button("Queue message") { Task { await send() } }
                    .disabled(nextMessage.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || sending)
            }
            if current.state == "local" {
                Button("Try syncing again") { appModel.cloud.threadQueue.retry() }
            } else if current.fields["acceptedAt"] == .null, current.fields["launch"] != .null {
                Button("Move to another environment") { showMove = true }
            }
            if let errorMessage { Text(errorMessage).foregroundStyle(.red) }
        }
        .navigationTitle(current.title)
        .task(id: "\(current.revision):\(current.state):\(current.fields["updatedAt"]?.intValue ?? 0):\(current.fields["localCount"]?.intValue ?? 0)") { await reload() }
        .refreshable { await reload(); appModel.cloud.threadQueue.retry() }
        .alert("Edit queued message", isPresented: $isEditing) {
            TextField("Message", text: $editText)
            Button("Save") { if let editingCommand { perform("edit", fields: ["commandId": .string(editingCommand), "revision": .number(Double(editingRevision)), "text": .string(editText)]) } }
            Button("Cancel", role: .cancel) {}
        }
        .sheet(isPresented: $showMove) { PathwayQueuedThreadMoveView(thread: current) }
    }

    private func reload() async {
        do {
            let result = try await appModel.cloud.threadQueue.detail(current)
            messages = result.objectValue?["messages"]?.arrayValue ?? []
        } catch { errorMessage = error.localizedDescription }
    }

    private func perform(_ action: String, fields: [String: JSONValue]) {
        Task {
            do {
                try await appModel.cloud.threadQueue.mutate(action, thread: current, fields: fields)
                await reload()
            } catch { errorMessage = error.localizedDescription }
        }
    }

    private func send() async {
        sending = true
        defer { sending = false }
        do {
            guard let source = messages.first?.objectValue?["submission"]?.objectValue?["input"]?.objectValue,
                  let selection = source["modelSelection"] else { throw PathwayThreadConversationError.message("Wait for the saved thread settings to load.") }
            let id = UUID().uuidString.lowercased()
            let text = nextMessage
            try await appModel.cloud.threadQueue.enqueue(companyID: current.companyID, environmentID: current.environmentID,
                                                         threadID: current.threadID, submission: .object(["kind": .string("message"), "input": .object([
                                                             "type": .string("message.dispatch"), "commandId": .string(id), "messageId": .string(id),
                                                             "threadId": .string(current.threadID), "text": .string(text), "attachments": .array([]),
                                                             "modelSelection": selection, "createdBy": .string("user"), "creationSource": .string("mobile"),
                                                             "dispatchMode": .object(["type": .string("queue_after_active")])
                                                         ])]))
            if nextMessage == text { nextMessage = "" }
            await reload()
        } catch { errorMessage = error.localizedDescription }
    }
}

private extension JSONValue {
    var queueCommandID: String { objectValue?["commandId"]?.stringValue ?? "" }
}

private struct PathwayQueuedThreadMoveView: View {
    @Environment(PathwayAppModel.self) private var appModel
    @Environment(\.dismiss) private var dismiss
    let thread: PathwayQueuedThread
    @State private var destination = ""
    @State private var providerID = ""
    @State private var modelID = ""
    @State private var providers: [PathwayServerProvider] = []
    @State private var loadingProviders = false
    @State private var errorMessage: String?
    @State private var moving = false

    private var bindings: [PathwayCompanyEnvironmentBinding] {
        appModel.cloud.environmentBindings.filter {
            $0.companyId == thread.companyID && $0.binding.cloudProjectId == thread.fields["cloudProjectId"]?.stringValue
                && $0.binding.status == "active" && $0.binding.environmentId != thread.environmentID
        }
    }

    private var environments: [PathwayCompanyEnvironment] {
        appModel.cloud.environments.filter { $0.companyId == thread.companyID && $0.environment.state == "active" && $0.environment.environmentId != thread.environmentID }
    }

    var body: some View {
        NavigationStack {
            Form {
                Text("Choose the destination and its provider configuration. Only a thread that has not been accepted can move.")
                Picker("Environment and project directory", selection: $destination) {
                    Text("Choose destination").tag("")
                    if thread.fields["cloudProjectId"]?.stringValue != nil {
                        ForEach(bindings) { binding in
                            Text(binding.binding.localWorkspaceRoot + " · " + (environments.first { $0.environment.environmentId == binding.binding.environmentId }?.environment.label ?? "Environment")).tag(binding.id)
                        }
                    } else {
                        ForEach(environments) { environment in Text(environment.environment.label).tag(environment.environment.environmentId) }
                    }
                }
                Picker("Provider", selection: $providerID) {
                    Text("Choose provider").tag("")
                    ForEach(providers, id: \.id) { provider in Text(provider.name).tag(provider.id) }
                }
                Picker("Model", selection: $modelID) {
                    Text("Choose model").tag("")
                    ForEach(providers.first(where: { $0.id == providerID })?.models ?? [], id: \.id) { model in Text(model.name).tag(model.id) }
                }
                if loadingProviders { ProgressView("Checking destination…") }
                Text("The destination checks provider and model availability before starting. Missing configuration keeps your messages saved.").font(.footnote)
                if let errorMessage { Text(errorMessage).foregroundStyle(.red) }
                Button("Move queued thread") { Task { await move() } }
                    .disabled(destination.isEmpty || providerID.isEmpty || modelID.isEmpty || moving)
            }
            .navigationTitle("Move queued thread")
            .task(id: destination) { await loadProviders() }
            .onChange(of: providerID) { modelID = providers.first(where: { $0.id == providerID })?.models.first?.id ?? "" }
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
        }
    }

    private func loadProviders() async {
        let selected = destination
        providerID = ""; modelID = ""; providers = []
        let id = bindings.first(where: { $0.id == selected })?.binding.environmentId ?? selected
        guard let environment = environments.first(where: { $0.environment.environmentId == id }) else { return }
        loadingProviders = true
        defer { if destination == selected { loadingProviders = false } }
        do {
            let destinations = try await appModel.cloud.threadQueue.destinations(companyID: thread.companyID, threadID: thread.threadID)
            guard !Task.isCancelled, destination == selected else { return }
            let target = destinations.arrayValue?.first { $0.objectValue?["environmentId"]?.stringValue == environment.environment.environmentId }
            providers = (target?.objectValue?["providers"]?.arrayValue ?? []).compactMap { value in
                guard let fields = value.objectValue, fields["enabled"]?.boolValue == true,
                      let id = fields["instanceId"]?.stringValue, let driver = fields["driver"]?.stringValue else { return nil }
                let models = (fields["modelIds"]?.arrayValue ?? []).compactMap { value -> PathwayServerModel? in
                    guard let id = value.stringValue else { return nil }
                    return PathwayServerModel(id: id, name: id, isDefault: false, optionDescriptors: [])
                }
                return PathwayServerProvider(id: id, driver: driver, name: fields["displayName"]?.stringValue ?? driver, models: models, showsInteractionMode: false)
            }
            providerID = providers.first?.id ?? ""
        } catch {
            guard !Task.isCancelled, destination == selected else { return }
            errorMessage = "The destination’s saved provider settings could not be loaded. Your queued thread remains saved."
        }
    }

    private func move() async {
        moving = true
        defer { moving = false }
        do {
            let binding = bindings.first { $0.id == destination }
            try await appModel.cloud.threadQueue.mutate("reassign", thread: thread, fields: [
                "revision": .number(Double(thread.revision)), "environmentId": .string(binding?.binding.environmentId ?? destination),
                "localProjectId": binding.map { .string($0.binding.localProjectId) } ?? .null,
                "modelSelection": .object(["instanceId": .string(providerID), "model": .string(modelID)])
            ])
            dismiss()
        } catch { errorMessage = error.localizedDescription }
    }
}
