import SwiftUI

/// Environment work stays explicit: choosing an assignee alone never starts an agent.
struct PathwayIssueWorkView: View {
    let model: PathwayIssuesModel
    let issue: PathwayIssueRecord
    var embedded = false
    var commentBody: String?
    var commentAttachmentIDs: [String] = []
    var onCommentSent: (() -> Void)?
    @Environment(PathwayAppModel.self) private var appModel
    @Environment(\.dismiss) private var dismiss
    @State private var bindingID = ""
    @State private var creation: PathwayAgentThreadCreationModel?
    @State private var showSettings = false
    @State private var workPurpose = "implement"
    @State private var appliedProviderDefaults = false
    @State private var errorMessage: String?
    @State private var runs: [PathwayIssueEntity] = []
    @State private var busy = false
    @State private var launchedThreadID: String?
    @State private var linkID = UUID().uuidString.lowercased()

    private var bindings: [PathwayCompanyEnvironmentBinding] {
        appModel.cloud.environmentBindings.filter {
            $0.companyId == issue.companyId && $0.binding.cloudProjectId == issue.projectId && $0.binding.status == "active"
        }
    }
    private var selectedBinding: PathwayCompanyEnvironmentBinding? { bindings.first { $0.id == bindingID } }
    private var linkedIDs: Set<String> { Set(model.detail(for: issue).threadLinks.compactMap { $0.fields["threadId"]?.stringValue }) }

    var body: some View {
        if embedded { content } else { NavigationStack { content } }
    }

    private var content: some View {
            Form {
                if bindings.isEmpty {
                    ContentUnavailableView("Choose a connected project", systemImage: "externaldrive.badge.wifi",
                                           description: Text("Set this issue’s project in Properties to use an agent in its environment."))
                } else {
                    Section("Environment") {
                        Picker("Run in", selection: $bindingID) {
                            ForEach(bindings) { binding in
                                Text(appModel.cloud.environments.first {
                                    $0.companyId == binding.companyId && $0.environment.environmentId == binding.binding.environmentId
                                }?.environment.label ?? binding.binding.environmentId).tag(binding.id)
                            }
                        }
                    }
                    if let creation { agentSection(creation) }
                    if commentBody == nil {
                    Section("Investigation") {
                        Text("Investigate the repository before starting work. Findings and suggested changes appear below.")
                            .font(.subheadline).foregroundStyle(.secondary)
                        Button("Investigate", systemImage: "sparkle.magnifyingglass") { investigate() }
                            .disabled(busy || runs.contains { ["queued", "running"].contains($0.fields["state"]?.stringValue ?? "") })
                        Button("Refresh findings", systemImage: "arrow.clockwise") { Task { await refreshRuns() } }.disabled(busy)
                    }
                    ForEach(runs) { run in investigationSection(run) }
                    }
                }
                if commentBody == nil {
                Section("Link existing thread") {
                    ForEach(appModel.cloud.threads.filter {
                        $0.companyId == issue.companyId && $0.cloudProjectId == issue.projectId && !linkedIDs.contains($0.threadId)
                    }) { thread in
                        Button(thread.shell.title) {
                            perform {
                                _ = try await model.mutate(companyID: issue.companyId, kind: "issueThreadLink.create", entityID: UUID().uuidString.lowercased(),
                                                           args: ["issueId": .string(issue.id), "environmentId": .string(thread.environmentId),
                                                                  "threadId": .string(thread.threadId), "origin": .string("manual")])
                            }
                        }
                    }
                }
                }
                if let errorMessage { Section { Text(errorMessage).foregroundStyle(.red) } }
            }
            .navigationTitle(commentBody == nil ? "Agent work" : "Ask an agent").navigationBarTitleDisplayMode(.inline)
            .toolbarVisibility(.visible, for: .navigationBar)
            .toolbar { ToolbarItem(placement: .confirmationAction) { if !embedded { Button("Done") { dismiss() } } } }
            .task {
                if bindingID.isEmpty { bindingID = bindings.first?.id ?? "" }
            }
            .task(id: bindingID) { await configure() }
            .task(id: "observe:\(bindingID)") {
                if let selectedBinding { await model.observe(issue, environmentID: selectedBinding.binding.environmentId) }
            }
            .onChange(of: model.enrichmentRuns(for: issue, environmentID: selectedBinding?.binding.environmentId)) { _, newRuns in
                runs = newRuns
            }
            .onDisappear { Task { await creation?.stop() } }
            .sheet(isPresented: $showSettings) { if let creation { NewAgentThreadSettings(model: creation) } }
    }

    private func agentSection(_ creation: PathwayAgentThreadCreationModel) -> some View {
        @Bindable var creation = creation
        return Section(commentBody == nil ? "Start work" : "Ask an agent") {
            Picker("Provider", selection: $creation.selectedProviderID) {
                ForEach(creation.providers) { Text($0.name).tag($0.id) }
            }
            .onChange(of: creation.providers, initial: true) { _, providers in
                guard !appliedProviderDefaults, !providers.isEmpty else { return }
                appliedProviderDefaults = true
                let pinned = issue.fields["workModelSelection"]?.objectValue
                let driver = issue.assignee?.objectValue?["provider"]?.stringValue
                if let provider = providers.first(where: { $0.id == pinned?["instanceId"]?.stringValue })
                    ?? providers.first(where: { $0.driver == driver }) {
                    creation.selectedProviderID = provider.id
                    if let modelID = pinned?["model"]?.stringValue, provider.models.contains(where: { $0.id == modelID }) {
                        creation.selectedModelID = modelID
                    }
                    for option in pinned?["options"]?.arrayValue ?? [] {
                        if let fields = option.objectValue, let id = fields["id"]?.stringValue, let value = fields["value"] {
                            creation.optionValues[id] = value
                        }
                    }
                }
            }
            Picker("Model", selection: $creation.selectedModelID) {
                ForEach(creation.selectedProvider?.models ?? []) { Text($0.name).tag($0.id) }
            }
            if commentBody == nil {
                Picker("Purpose", selection: $workPurpose) {
                    Text("Implement issue").tag("implement")
                    Text("Discuss first").tag("discuss")
                }.onChange(of: workPurpose) { creation.prompt = workPrompt() }
            }
            if commentBody == nil { Button("Workspace & model settings", systemImage: "slider.horizontal.3") { showSettings = true } }
            TextField("Instructions", text: $creation.prompt, axis: .vertical).lineLimit(3...10)
            if let message = creation.errorMessage { Text(message).font(.caption).foregroundStyle(.red) }
            Button(commentBody != nil ? "Send to agent" : (launchedThreadID == nil ? "Start work" : "Link created thread"), systemImage: "play.fill") {
                if commentBody != nil { sendToAgent(creation) } else { launch(creation) }
            }
                .disabled(busy || (launchedThreadID == nil && !creation.canLaunch))
        }
    }

    @ViewBuilder
    private func investigationSection(_ run: PathwayIssueEntity) -> some View {
        Section("Investigation · \(run.fields["state"]?.stringValue ?? "")") {
            if let result = run.fields["result"]?.objectValue {
                Text(.init(result["summary"]?.stringValue ?? "")).textSelection(.enabled)
                if let title = result["suggestedTitle"]?.stringValue {
                    Button("Use title: \(title)") { apply(["title": .string(title)]) }
                }
                if let description = result["suggestedDescription"]?.stringValue {
                    DisclosureGroup("Suggested description") {
                        Text(.init(description)).textSelection(.enabled)
                        Button("Apply description") { apply(["description": .string(description)]) }
                    }
                }
                if let priority = result["suggestedPriority"]?.stringValue {
                    Button("Set priority to \(priority)") { apply(["priority": .string(priority)]) }
                }
                ForEach(result["suggestedLabels"]?.arrayValue?.compactMap(\.stringValue) ?? [], id: \.self) { name in
                    Button("Apply label: \(name)") { applyLabel(name) }
                }
                ForEach(result["likelyFiles"]?.arrayValue?.compactMap { value -> PathwayIssueFinding? in
                    guard let fields = value.objectValue, let path = fields["path"]?.stringValue else { return nil }
                    return PathwayIssueFinding(id: path, explanation: fields["reason"]?.stringValue ?? "")
                } ?? []) { file in
                    VStack(alignment: .leading) { Text(file.id).font(.caption.monospaced()); Text(file.explanation).font(.subheadline).foregroundStyle(.secondary) }
                }
                ForEach(result["relatedIssueKeys"]?.arrayValue?.compactMap(\.stringValue) ?? [], id: \.self) { key in
                    if let related = model.records.first(where: { $0.companyId == issue.companyId && $0.key == key }) {
                        NavigationLink(key) { PathwayIssueDetailView(model: model, companyID: issue.companyId, issueID: related.id) }
                    }
                }
            }
            if let error = run.fields["error"]?.stringValue { Text(error).foregroundStyle(.red) }
            if let transcript = run.fields["transcript"]?.stringValue, !transcript.isEmpty {
                DisclosureGroup("Investigation log") { Text(transcript).font(.caption.monospaced()).textSelection(.enabled) }
            }
            if ["queued", "running"].contains(run.fields["state"]?.stringValue ?? "") {
                Button("Stop investigation", role: .destructive) {
                    perform {
                        _ = try await model.request(issue, method: "issues.cancelEnrichment", payload: ["runId": .string(run.id)],
                                                    environmentID: selectedBinding?.binding.environmentId)
                        await refreshRuns()
                    }
                }
            }
        }
    }

    private func configure() async {
        await creation?.stop()
        creation = nil
        appliedProviderDefaults = false
        guard let binding = selectedBinding, let connect = appModel.connect,
              let environment = appModel.cloud.environments.first(where: {
                  $0.companyId == binding.companyId && $0.environment.environmentId == binding.binding.environmentId
              }) else { return }
        // Issue instructions belong to this sheet, not the binding's ordinary new-thread draft.
        let next = PathwayAgentThreadCreationModel(binding: binding, environment: environment, connect: connect, storageDirectory: nil)
        next.prompt = commentBody ?? workPrompt()
        next.runtimeMode = "approval-required"
        creation = next
        next.start()
        if commentBody == nil { await refreshRuns() }
    }

    private func sendToAgent(_ creation: PathwayAgentThreadCreationModel) {
        guard let provider = creation.selectedProvider, let selectedModel = creation.selectedModel else { return }
        perform {
            var selection: [String: JSONValue] = ["instanceId": .string(provider.id), "model": .string(selectedModel.id)]
            let options = creation.optionValues.sorted { $0.key < $1.key }.map { JSONValue.object(["id": .string($0.key), "value": $0.value]) }
            if !options.isEmpty { selection["options"] = .array(options) }
            _ = try await model.request(issue, method: "issues.commentCreate", payload: [
                "issueId": .string(issue.id), "body": .string(creation.prompt),
                "attachmentIds": .array(commentAttachmentIDs.map(JSONValue.string)),
                "agentMention": .object(["modelSelection": .object(selection)])
            ], environmentID: selectedBinding?.binding.environmentId)
            onCommentSent?()
            dismiss()
        }
    }

    private func launch(_ creation: PathwayAgentThreadCreationModel) {
        guard let binding = selectedBinding else { return }
        perform {
            let threadID: String
            if let existing = launchedThreadID { threadID = existing }
            else {
                creation.initialImageUploads = await prepareImages()
                guard let created = await creation.launch() else { return }
                launchedThreadID = created
                threadID = created
            }
            _ = try await model.mutate(companyID: issue.companyId, kind: "issueThreadLink.create", entityID: linkID,
                                       args: ["issueId": .string(issue.id), "environmentId": .string(binding.binding.environmentId),
                                              "threadId": .string(threadID), "origin": .string(workPurpose == "implement" ? "start-work" : "manual")])
            var patch: [String: JSONValue] = [:]
            if workPurpose == "implement", let provider = creation.selectedProvider {
                patch["assignee"] = .object(["kind": .string("agent"), "provider": .string(provider.driver)])
            }
            if workPurpose == "implement", let status = model.statuses.first(where: { $0.companyId == issue.companyId && $0.category == "started" }) {
                patch["statusId"] = .string(status.id)
            }
            if !patch.isEmpty { try await model.update(issue, patch: patch) }
            appModel.pendingThreadRoute = PathwayPendingThreadRoute(companyId: issue.companyId, environmentId: binding.binding.environmentId, threadId: threadID)
            dismiss()
        }
    }

    private func workPrompt() -> String {
        let detail = model.detail(for: issue)
        var blocks = ["\(issue.key): \(issue.title)", issue.description]
        if !detail.todos.isEmpty {
            blocks.append("Checklist:\n" + detail.todos.map {
                "- [\($0.fields["done"]?.boolValue == true ? "x" : " ")] \($0.fields["text"]?.stringValue ?? "")"
            }.joined(separator: "\n"))
        }
        if let parent = model.records.first(where: { $0.companyId == issue.companyId && $0.id == issue.parentId }) {
            blocks.append("Parent: \(parent.key) — \(parent.title)")
        }
        for relation in detail.relations {
            let outgoing = relation.fields["issueId"]?.stringValue == issue.id
            let id = relation.fields[outgoing ? "relatedIssueId" : "issueId"]?.stringValue
            if let other = model.records.first(where: { $0.companyId == issue.companyId && $0.id == id }) {
                let kind = relation.fields["kind"]?.stringValue ?? "relates"
                blocks.append("\(kind == "blocks" && !outgoing ? "Blocked by" : kind.capitalized): \(other.key) — \(other.title)")
            }
        }
        if let source = issue.fields["slackSource"]?.objectValue?["permalink"]?.stringValue { blocks.append("Source: \(source)") }
        if let pr = issue.fields["pullRequest"]?.objectValue?["url"]?.stringValue { blocks.append("Pull request: \(pr)") }
        if workPurpose == "discuss" {
            blocks.append("Discuss this issue before implementing. Read it with Pathway MCP's issues_get and help clarify the problem, scope, and next steps. Do not begin implementation unless I explicitly ask.")
        } else {
            blocks.append("Read this issue with Pathway MCP's issues_get, inspect the relevant code, implement and verify it. Keep the issue current with issues_update and issues_comment, and attach useful visual evidence with issues_comment_evidence when verifying visible behavior. Use Pathway issue tools for this issue.")
        }
        return blocks.filter { !$0.isEmpty }.joined(separator: "\n\n")
    }

    private func prepareImages() async -> [JSONValue] {
        let detail = model.detail(for: issue)
        var seen: Set<String> = []
        let ids = detail.comments.flatMap { $0.fields["attachmentIds"]?.arrayValue?.compactMap(\.stringValue) ?? [] }
            .filter { seen.insert($0).inserted }.prefix(8)
        var uploads: [JSONValue] = []
        for id in ids {
            do {
                let url = try await model.attachmentURL(issue, attachmentID: id)
                let (data, response) = try await URLSession.shared.data(from: url)
                guard (response as? HTTPURLResponse)?.statusCode == 200,
                      let mimeType = response.mimeType, mimeType.hasPrefix("image/"),
                      !data.isEmpty, data.count <= 10 * 1_024 * 1_024 else { continue }
                let name = detail.attachments.first { $0.id == id }?.fields["fileName"]?.stringValue ?? "\(issue.key)-image"
                uploads.append(.object(["type": .string("image"), "name": .string(name), "mimeType": .string(mimeType),
                                        "sizeBytes": .number(Double(data.count)),
                                        "dataUrl": .string("data:\(mimeType);base64,\(data.base64EncodedString())")]))
            } catch { continue }
        }
        return uploads
    }

    private func investigate() {
        perform {
            _ = try await model.request(issue, method: "issues.startEnrichment", payload: ["issueId": .string(issue.id)], environmentID: selectedBinding?.binding.environmentId)
            await refreshRuns()
        }
    }

    private func refreshRuns() async {
        guard selectedBinding != nil else { return }
        do {
            let result = try await model.request(issue, method: "issues.getEnrichmentRuns", payload: ["issueId": .string(issue.id)], environmentID: selectedBinding?.binding.environmentId)
            runs = (result.objectValue?["runs"]?.arrayValue ?? []).compactMap {
                guard let fields = $0.objectValue else { return nil }
                return PathwayIssueEntity(companyId: issue.companyId, kind: "issueEnrichmentRun", fields: fields)
            }
        } catch { errorMessage = error.localizedDescription }
    }
    private func apply(_ patch: [String: JSONValue]) { perform { try await model.update(issue, patch: patch) } }
    private func applyLabel(_ name: String) {
        perform {
            let existing = model.labels.first { $0.companyId == issue.companyId && $0.name.localizedCaseInsensitiveCompare(name) == .orderedSame }
            let id = existing?.id ?? UUID().uuidString.lowercased()
            if existing == nil {
                _ = try await model.mutate(companyID: issue.companyId, kind: "issueLabel.create", entityID: id,
                                           args: ["name": .string(name), "color": .string("#8E8E93")])
            }
            let current = model.records.first { $0.companyId == issue.companyId && $0.id == issue.id } ?? issue
            try await model.update(current, patch: ["labelIds": .array(Array(Set(current.labelIds + [id])).sorted().map(JSONValue.string))])
        }
    }
    private func perform(_ action: @escaping @MainActor () async throws -> Void) {
        guard !busy else { return }
        busy = true
        Task { defer { busy = false }; do { try await action() } catch { errorMessage = error.localizedDescription } }
    }
}

private struct PathwayIssueFinding: Identifiable {
    let id: String
    let explanation: String
}
