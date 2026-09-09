import SwiftUI

struct NewAgentThreadSuggestions: View {
    let model: PathwayAgentThreadCreationModel
    let trigger: AgentThreadComposerTrigger
    let select: (AgentThreadComposerSuggestion, AgentThreadComposerTrigger) -> Void
    @State private var paths: [AgentThreadComposerSuggestion] = []
    @State private var loadedTrigger: AgentThreadComposerTrigger?
    @State private var isLoading = false
    @State private var errorMessage: String?
    @State private var scopedCatalog: [String: JSONValue] = [:]
    @State private var loadedCatalogTarget: [String]?
    @State private var catalogError: String?

    private var catalogCwd: String? { model.workspaceRoot }
    private var catalogTarget: [String] {
        [model.selectedProviderID, catalogCwd ?? "", provider["provider"]?.stringValue ?? "",
         trigger.kind == .skill || trigger.kind == .slash ? "open" : "closed"]
    }
    private var needsScopedCatalog: Bool {
        provider["provider"]?.stringValue == "claudeAgent" && (trigger.kind == .skill || trigger.kind == .slash)
    }
    private var composerCatalog: [String: JSONValue] {
        guard needsScopedCatalog else { return provider }
        return loadedCatalogTarget == catalogTarget ? scopedCatalog : [:]
    }
    private var catalogIsLoading: Bool { needsScopedCatalog && loadedCatalogTarget != catalogTarget }

    private func loadComposerCatalog() async {
        guard needsScopedCatalog else { catalogError = nil; loadedCatalogTarget = nil; return }
        let target = catalogTarget
        catalogError = nil
        do {
            let result = try await model.request("server.getComposerCatalog", payload: .object([
                "instanceId": .string(model.selectedProviderID), "cwd": catalogCwd.map(JSONValue.string) ?? .null
            ]))
            try Task.checkCancellation()
            guard target == catalogTarget else { return }
            scopedCatalog = result.objectValue ?? [:]
            loadedCatalogTarget = target
        } catch is CancellationError { return }
        catch {
            guard !Task.isCancelled, target == catalogTarget else { return }
            scopedCatalog = [:]
            loadedCatalogTarget = target
            catalogError = "Could not load this project's commands. Close and reopen the menu to retry."
        }
    }

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                if isLoading { ProgressView("Searching files…").padding(10) }
                if catalogIsLoading { ProgressView("Loading commands…").font(.caption).padding(10) }
                if needsScopedCatalog, loadedCatalogTarget == catalogTarget, let catalogError { Text(catalogError).font(.caption).padding(10) }
                if let errorMessage { Text(errorMessage).font(.caption).padding(10) }
                if suggestions.isEmpty && !isLoading && !catalogIsLoading && catalogError == nil && errorMessage == nil { Text("No matching suggestions").font(.caption).padding(10) }
                ForEach(suggestions) { suggestion in
                    Button { select(suggestion, trigger) } label: {
                        HStack(spacing: 9) {
                            Image(systemName: suggestion.symbol).frame(width: 20)
                            VStack(alignment: .leading) {
                                Text(suggestion.title).font(.subheadline).lineLimit(1)
                                Text(suggestion.detail).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                            }
                            Spacer(minLength: 0)
                        }.padding(.horizontal, 10).frame(minHeight: 44).contentShape(Rectangle())
                    }.buttonStyle(.plain)
                }
            }
        }.frame(maxHeight: 170).background(.quaternary.opacity(0.4), in: .rect(cornerRadius: 12))
            .task(id: trigger) { await searchPaths() }
            .task(id: catalogTarget) { await loadComposerCatalog() }
    }

    private var provider: [String: JSONValue] {
        model.serverConfig["providers"]?.arrayValue?.compactMap(\.objectValue)
            .first { $0["instanceId"]?.stringValue == model.selectedProviderID } ?? [:]
    }

    private var suggestions: [AgentThreadComposerSuggestion] {
        if trigger.kind == .path { return loadedTrigger == trigger ? paths : [] }
        var candidates: [AgentThreadComposerSuggestion] = []
        switch trigger.kind {
        case .model:
            candidates = model.providers.flatMap { provider in provider.models.map { value in
                .init(id: "model:\(provider.id):\(value.id)", title: value.name, detail: provider.name, symbol: "sparkles",
                    action: .model(.init(instanceId: provider.id, model: value.id, options: nil)))
            } }
        case .skill:
            candidates = (composerCatalog["skills"]?.arrayValue ?? []).compactMap { value in
                guard let fields = value.objectValue, fields["enabled"]?.boolValue == true, fields["userInvocable"]?.boolValue != false, let name = fields["name"]?.stringValue else { return nil }
                return .init(id: "skill:\(name)", title: fields["displayName"]?.stringValue ?? name,
                    detail: fields["shortDescription"]?.stringValue ?? fields["description"]?.stringValue ?? "$\(name)", symbol: "sparkles", action: .insert("$\(name) "))
            }
        case .slash:
            candidates = [.init(id: "builtin:model", title: "/model", detail: "Choose a response model", symbol: "sparkles", action: .insert("/model "))]
            if model.selectedProvider?.showsInteractionMode == true {
                candidates += [.init(id: "builtin:plan", title: "/plan", detail: "Plan the work", symbol: "list.bullet.clipboard", action: .mode("plan")),
                    .init(id: "builtin:default", title: "/default", detail: "Work mode", symbol: "text.bubble", action: .mode("default"))]
            }
            candidates += (trigger.range.location == 0 ? composerCatalog["slashCommands"]?.arrayValue ?? [] : []).compactMap { value in
                guard let fields = value.objectValue, let name = fields["name"]?.stringValue else { return nil }
                return .init(id: "command:\(name)", title: "/\(name)", detail: fields["description"]?.stringValue ?? "Provider command",
                    symbol: "terminal", action: .insert("/\(name) "))
            }
        case .path: break
        }
        return Array(candidates.filter { trigger.query.isEmpty || ($0.title + " " + $0.detail).localizedStandardContains(trigger.query) }
            .sorted { $0.title.localizedStandardCompare($1.title) == .orderedAscending }.prefix(20))
    }

    private func searchPaths() async {
        paths = []; errorMessage = nil; isLoading = false; loadedTrigger = nil
        guard trigger.kind == .path else { return }
        guard trigger.query.utf16.count <= 256 else { errorMessage = "Use a shorter file search."; return }
        isLoading = true
        do {
            try await Task.sleep(for: .milliseconds(200))
            let value = try await model.request("projects.searchEntries", payload: .object([
                "cwd": .string(model.workspaceRoot), "query": .string(trigger.query), "limit": .number(20)]))
            try Task.checkCancellation()
            paths = (value.objectValue?["entries"]?.arrayValue ?? []).prefix(20).compactMap { value in
                guard let fields = value.objectValue, let path = fields["path"]?.stringValue else { return nil }
                return .init(id: path, title: path.split(separator: "/").last.map(String.init) ?? path, detail: path,
                    symbol: fields["kind"]?.stringValue == "directory" ? "folder" : "doc", action: .insert(AgentThreadComposerTrigger.fileLink(path) + " "))
            }
            loadedTrigger = trigger; isLoading = false
        } catch is CancellationError {} catch { errorMessage = error.localizedDescription; isLoading = false }
    }
}
