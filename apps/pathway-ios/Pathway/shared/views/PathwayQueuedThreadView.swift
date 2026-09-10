import SwiftUI

/// Queued threads open the same conversation screen as environment-backed threads.
struct PathwayQueuedThreadView: View {
    @Environment(PathwayAppModel.self) private var appModel
    let thread: PathwayQueuedThread
    @State private var model: PathwayAgentThreadModel?
    @State private var errorMessage: String?

    private var current: PathwayQueuedThread { appModel.cloud.threadQueue.threads.first { $0.id == thread.id } ?? thread }

    var body: some View {
        Group {
            if let model {
                AgentThreadConversationView(model: model)
                    .id(model.environment.environment.environmentId)
            } else if let errorMessage {
                ContentUnavailableView {
                    Label("Conversation unavailable", systemImage: "bubble.left.and.bubble.right")
                } description: { Text(errorMessage) } actions: {
                    Button("Try again") { Task { await loadConversation() } }
                }
            } else { ProgressView("Opening conversation…") }
        }
        .task(id: current.environmentID) { await loadConversation() }
    }

    private func loadConversation() async {
        let queued = current
        guard let connect = appModel.connect,
              let environment = appModel.cloud.environments.first(where: {
                  $0.companyId == queued.companyID && $0.environment.environmentId == queued.environmentID
              })
        else {
            errorMessage = "The saved environment details are unavailable. Your messages remain saved."
            return
        }
        do {
            let detail = appModel.cloud.threadQueue.cachedDetail(queued)
            guard !Task.isCancelled, current.environmentID == queued.environmentID else { return }
            let thread = try appModel.cloud.threads.first(where: {
                $0.companyId == queued.companyID && $0.threadId == queued.threadID && $0.environmentId == queued.environmentID
            }) ?? queued.conversationThread(detail: detail)
            let next = PathwayAgentThreadModel(thread: thread, environment: environment, connect: connect,
                                               storageDirectory: appModel.localStorageDirectory)
            next.threadQueue = appModel.cloud.threadQueue
            await next.restoreDraft()
            if let model, model.environment.environment.environmentId != queued.environmentID {
                await model.stop()
                next.draft = model.draft
                next.draftAttachments = model.draftAttachments
                next.attachmentData = model.attachmentData
                try await next.changeModelSelection(thread.shell.modelSelection)
                try await next.setRuntimeMode(model.runtimeMode)
                try await next.setInteractionMode(model.interactionMode)
                await next.persistDraftNow()
            }
            next.installCloudQueueDetail(queued, detail: detail, authoritative: false)
            guard !Task.isCancelled, current.environmentID == queued.environmentID else { return }
            model = next
            errorMessage = nil
        } catch { if !Task.isCancelled { errorMessage = error.localizedDescription } }
    }
}

struct PathwayQueuedThreadMoveView: View {
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
