import SwiftUI

/// Discuss a selection in one thread, or investigate its issues individually in a chosen project.
struct PathwayIssueBulkAgentView: View {
    let model: PathwayIssuesModel
    let issues: [PathwayIssueRecord]
    @Environment(PathwayAppModel.self) private var appModel
    @Environment(\.dismiss) private var dismiss
    @State private var bindingID = ""
    @State private var creation: PathwayAgentThreadCreationModel?
    @State private var showSettings = false
    @State private var busy = false
    @State private var result: String?
    @State private var errorMessage: String?

    private var companyID: String? { issues.first?.companyId }
    private var bindings: [PathwayCompanyEnvironmentBinding] {
        appModel.cloud.environmentBindings.filter { $0.companyId == companyID && $0.binding.status == "active" }
    }
    private var selectedBinding: PathwayCompanyEnvironmentBinding? { bindings.first { $0.id == bindingID } }

    var body: some View {
        NavigationStack {
            Form {
                if bindings.isEmpty {
                    ContentUnavailableView("No connected project", systemImage: "externaldrive.badge.wifi", description: Text("Connect an environment to a project to discuss or investigate these tasks."))
                } else {
                    Section("Project and environment") {
                        Picker("Use", selection: $bindingID) {
                            ForEach(bindings) { binding in
                                Text(bindingLabel(binding)).tag(binding.id)
                            }
                        }
                        .disabled(busy)
                        Text("\(issues.count) \(issues.count == 1 ? "task" : "tasks") selected")
                            .font(.footnote).foregroundStyle(.secondary)
                    }
                    if let creation { discussionSection(creation) }
                    Section("Investigate") {
                        Text("Investigating assigns the selected tasks to this project and researches each task using the investigation model in Task settings.")
                            .font(.subheadline).foregroundStyle(.secondary)
                        Button("Investigate \(issues.count) \(issues.count == 1 ? "task" : "tasks")", systemImage: "sparkle.magnifyingglass") { investigate() }
                            .disabled(busy || selectedBinding == nil || creation?.connectionState != .live || creation?.storageAllowsLaunch == false)
                    }
                }
                if let result { Section { Text(result).foregroundStyle(.secondary) } }
                if let errorMessage { Section { Text(errorMessage).foregroundStyle(.red) } }
            }
            .navigationTitle("Ask AI or investigate")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() }.disabled(busy) } }
            .interactiveDismissDisabled(busy)
            .task {
                if bindingID.isEmpty {
                    bindingID = bindings.first { $0.binding.cloudProjectId == issues.first?.projectId }?.id ?? bindings.first?.id ?? ""
                }
            }
            .task(id: bindingID) { await configure() }
            .onDisappear { Task { await creation?.stop() } }
            .sheet(isPresented: $showSettings) {
                if let creation { NewAgentThreadSettings(model: creation) }
            }
        }
    }

    private func discussionSection(_ model: PathwayAgentThreadCreationModel) -> some View {
        @Bindable var model = model
        return Section("Discuss together") {
            if let binding = selectedBinding, let connect = appModel.connect,
               let environment = appModel.cloud.environments.first(where: {
                   $0.companyId == binding.companyId && $0.environment.environmentId == binding.binding.environmentId
               }) {
                PathwayConversationStorageNotice(environment: environment, connect: connect,
                    onContinueAnyway: { model.continueDespiteCriticalStorage() },
                    onAvailabilityChanged: { model.storageAllowsLaunch = $0 }).id(binding.id)
            }
            Picker("Provider", selection: $model.selectedProviderID) {
                ForEach(model.providers) { Text($0.name).tag($0.id) }
            }
            Picker("Model", selection: $model.selectedModelID) {
                ForEach(model.selectedProvider?.models ?? []) { Text($0.name).tag($0.id) }
            }
            TextField("Instructions", text: $model.prompt, axis: .vertical).lineLimit(4...12)
            Button("Workspace & model settings", systemImage: "slider.horizontal.3") { showSettings = true }
            if let error = model.errorMessage { Text(error).font(.footnote).foregroundStyle(.red) }
            Button("Start discussion", systemImage: "bubble.left.and.bubble.right") { launch(model) }
                .disabled(busy || !model.canLaunch)
        }
    }

    private func configure() async {
        await creation?.stop()
        creation = nil
        guard let binding = selectedBinding, let connect = appModel.connect,
              let environment = appModel.cloud.environments.first(where: {
                  $0.companyId == binding.companyId && $0.environment.environmentId == binding.binding.environmentId
              }) else { return }
        let model = PathwayAgentThreadCreationModel(binding: binding, environment: environment, connect: connect, storageDirectory: appModel.localStorageDirectory)
        model.threadQueue = appModel.cloud.threadQueue
        model.prompt = "Discuss the following tasks and help me decide the next steps.\n\n" + issues.map {
            "\($0.key): \($0.title)\n\($0.description)"
        }.joined(separator: "\n\n")
        model.runtimeMode = "approval-required"
        creation = model
        model.start()
    }

    private func launch(_ model: PathwayAgentThreadCreationModel) {
        guard let binding = selectedBinding else { return }
        busy = true
        Task {
            defer { busy = false }
            guard let threadID = await model.launch() else { return }
            appModel.pendingThreadRoute = .init(companyId: binding.companyId, environmentId: binding.binding.environmentId, threadId: threadID)
            dismiss()
        }
    }

    private func investigate() {
        guard let binding = selectedBinding, !busy else { return }
        busy = true
        errorMessage = nil
        result = nil
        Task {
            defer { busy = false }
            guard let creation, await creation.checkStorageBeforeLaunch() else { return }
            var started = 0
            var skipped = 0
            var failures: [String] = []
            for selected in issues {
                guard let issue = model.records.first(where: { $0.identity == selected.identity }), !issue.isDeleted else { continue }
                do {
                    if issue.projectId != binding.binding.cloudProjectId {
                        try await model.update(issue, patch: ["projectId": .string(binding.binding.cloudProjectId)])
                    }
                    var fields = issue.fields
                    fields["projectId"] = .string(binding.binding.cloudProjectId)
                    let routed = PathwayIssueRecord(companyId: issue.companyId, fields: fields)
                    let previous = try await model.request(routed, method: "issues.getEnrichmentRuns", payload: ["issueId": .string(issue.id)], environmentID: binding.binding.environmentId)
                    let runs = previous.objectValue?["runs"]?.arrayValue ?? []
                    if runs.contains(where: { ["queued", "running"].contains($0.objectValue?["state"]?.stringValue ?? "") }) {
                        skipped += 1
                        continue
                    }
                    _ = try await model.request(routed, method: "issues.startEnrichment", payload: ["issueId": .string(issue.id)], environmentID: binding.binding.environmentId)
                    started += 1
                } catch { failures.append("\(issue.key): \(error.localizedDescription)") }
            }
            result = "Started \(started) investigations." + (skipped > 0 ? " \(skipped) already running." : "")
            errorMessage = failures.isEmpty ? nil : failures.joined(separator: "\n")
        }
    }

    private func bindingLabel(_ binding: PathwayCompanyEnvironmentBinding) -> String {
        let project = appModel.cloud.projects.first { $0.companyId == binding.companyId && $0.project.id == binding.binding.cloudProjectId }?.project.name ?? "Project"
        let environment = appModel.cloud.environments.first { $0.companyId == binding.companyId && $0.environment.environmentId == binding.binding.environmentId }?.environment.label ?? "Environment"
        return "\(project) · \(environment)"
    }
}
