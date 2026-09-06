import Foundation
import SwiftUI

struct AgentThreadComposerTrigger: Equatable, Hashable, Sendable {
    enum Kind: String, Sendable { case path, skill, slash, model }
    let kind: Kind
    let query: String
    let range: NSRange
    let expectedText: String

    static func detect(in text: String, cursor: Int) -> Self? {
        let source = text as NSString
        let end = min(max(0, cursor), source.length)
        guard let prefixRange = Range(NSRange(location: 0, length: end), in: text) else { return nil }
        let prefix = String(text[prefixRange])
        let line = prefix.split(separator: "\n", omittingEmptySubsequences: false).last.map(String.init) ?? ""
        let lineStart = end - line.utf16.count
        if line.hasPrefix("/") {
            let command = String(line.dropFirst())
            if command.lowercased() == "model" || command.hasPrefix("model ") || command.hasPrefix("model\t") {
                return .init(kind: .model, query: String(command.dropFirst(5)).trimmingCharacters(in: .whitespaces),
                             range: NSRange(location: lineStart, length: line.utf16.count), expectedText: line)
            }
            if !command.contains(where: \.isWhitespace) {
                return .init(kind: .slash, query: command, range: NSRange(location: lineStart, length: line.utf16.count), expectedText: line)
            }
        }
        let token = prefix.split(whereSeparator: \.isWhitespace).last.map(String.init) ?? ""
        guard let marker = token.first, marker == "@" || marker == "$", !prefix.hasSuffix(" "),
              prefix.last?.isWhitespace != true else { return nil }
        return .init(kind: marker == "@" ? .path : .skill, query: String(token.dropFirst()),
                     range: NSRange(location: end - token.utf16.count, length: token.utf16.count), expectedText: token)
    }

    func replacing(in text: String, with replacement: String) -> (text: String, cursor: Int)? {
        guard let swiftRange = Range(range, in: text), String(text[swiftRange]) == expectedText else { return nil }
        var end = swiftRange.upperBound
        if replacement.hasSuffix(" "), end < text.endIndex, text[end] == " " { end = text.index(after: end) }
        let next = String(text[..<swiftRange.lowerBound]) + replacement + String(text[end...])
        return (next, range.location + replacement.utf16.count)
    }

    static func fileLink(_ path: String) -> String {
        let basename = path.split(whereSeparator: { $0 == "/" || $0 == "\\" }).last.map(String.init) ?? path
        let label = basename.replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "[", with: "\\[").replacingOccurrences(of: "]", with: "\\]")
        let allowed = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.!~*';,/:@&=+$")
        let destination = path.addingPercentEncoding(withAllowedCharacters: allowed) ?? path
        return "[\(label)](\(destination))"
    }
}

struct AgentThreadComposerSuggestion: Identifiable {
    enum Action { case insert(String), model(PathwayModelSelection), mode(String) }
    let id: String
    let title: String
    let detail: String
    let symbol: String
    let action: Action
}

struct AgentThreadComposerSuggestions: View {
    let model: PathwayAgentThreadModel
    let trigger: AgentThreadComposerTrigger
    let workspaceRoot: String?
    let select: (AgentThreadComposerSuggestion, AgentThreadComposerTrigger) -> Void
    @State private var pathItems: [AgentThreadComposerSuggestion] = []
    @State private var loadedTrigger: AgentThreadComposerTrigger?
    @State private var isSearching = false
    @State private var errorMessage: String?

    private var provider: [String: JSONValue] {
        model.serverConfig["providers"]?.arrayValue?.compactMap(\.objectValue)
            .first { $0["instanceId"]?.stringValue == model.currentModelSelection.instanceId } ?? [:]
    }
    private var items: [AgentThreadComposerSuggestion] {
        if trigger.kind == .path { return loadedTrigger == trigger ? pathItems : [] }
        let candidates: [AgentThreadComposerSuggestion]
        switch trigger.kind {
        case .model:
            if model.isConfigurationLocked { return [] }
            candidates = model.providers.flatMap { provider in
                provider.models.map { available in
                    .init(id: "model:\(provider.id):\(available.id)", title: available.name, detail: provider.name, symbol: "sparkles",
                          action: .model(.init(instanceId: provider.id, model: available.id, options: nil)))
                }
            }
        case .skill:
            candidates = (provider["skills"]?.arrayValue ?? []).compactMap { value in
                guard let fields = value.objectValue, fields["enabled"]?.boolValue == true,
                      let name = fields["name"]?.stringValue else { return nil }
                return .init(id: "skill:\(name)", title: fields["displayName"]?.stringValue ?? name,
                             detail: fields["shortDescription"]?.stringValue ?? fields["description"]?.stringValue ?? "$\(name)",
                             symbol: "sparkles", action: .insert("$\(name) "))
            }
        case .slash:
            var commands: [AgentThreadComposerSuggestion] = []
            if !model.isConfigurationLocked {
                commands.append(.init(id: "builtin:model", title: "/model", detail: "Choose a response model", symbol: "sparkles", action: .insert("/model ")))
                if model.providers.first(where: { $0.id == model.currentModelSelection.instanceId })?.showsInteractionMode == true {
                    commands += [
                        .init(id: "builtin:plan", title: "/plan", detail: "Switch to plan mode", symbol: "list.bullet.clipboard", action: .mode("plan")),
                        .init(id: "builtin:default", title: "/default", detail: "Switch to chat mode", symbol: "text.bubble", action: .mode("default")),
                    ]
                }
            }
            commands += (provider["slashCommands"]?.arrayValue ?? []).compactMap { value in
                guard let fields = value.objectValue, let name = fields["name"]?.stringValue else { return nil }
                return .init(id: "command:\(name)", title: "/\(name)",
                             detail: fields["description"]?.stringValue ?? fields["input"]?.objectValue?["hint"]?.stringValue ?? "Provider command",
                             symbol: "terminal", action: .insert("/\(name) "))
            }
            candidates = commands
        case .path: candidates = []
        }
        let query = trigger.query.lowercased()
        return Array(candidates.filter { query.isEmpty || ($0.title + " " + $0.detail).localizedStandardContains(query) }
            .sorted { ($0.title.lowercased().hasPrefix(query) ? 0 : 1, $0.title) < ($1.title.lowercased().hasPrefix(query) ? 0 : 1, $1.title) }.prefix(20))
    }

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                if isSearching { ProgressView("Searching files…").font(.caption).padding(10) }
                if let errorMessage { Text(errorMessage).font(.caption).foregroundStyle(.secondary).padding(10) }
                if items.isEmpty && !isSearching && errorMessage == nil {
                    Text(model.isConfigurationLocked && trigger.kind == .model ? model.configurationLockReason ?? "Model is managed by the parent thread" : "No matching suggestions")
                        .font(.caption).foregroundStyle(.secondary).padding(10)
                }
                ForEach(items) { item in
                    Button { select(item, trigger) } label: {
                        HStack(spacing: 9) {
                            Image(systemName: item.symbol).frame(width: 20).foregroundStyle(.secondary)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(item.title).font(.subheadline).lineLimit(1)
                                if !item.detail.isEmpty { Text(item.detail).font(.caption).foregroundStyle(.secondary).lineLimit(1) }
                            }
                            Spacer(minLength: 0)
                        }.frame(minHeight: 44).padding(.horizontal, 10).contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("agent-thread-suggestion-\(item.id)")
                }
            }
        }
        .frame(maxHeight: 170)
        .background(.quaternary.opacity(0.4), in: .rect(cornerRadius: 12))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("agent-thread-composer-suggestions")
        .task(id: trigger) { await searchPaths() }
        .task(id: model.currentModelSelection.instanceId) {
            if trigger.kind != .path && provider.isEmpty { await model.refreshServerConfig() }
        }
    }

    private func searchPaths() async {
        guard trigger.kind == .path else { pathItems = []; errorMessage = nil; isSearching = false; return }
        let snapshot = trigger
        errorMessage = nil
        loadedTrigger = nil
        pathItems = []
        guard let cwd = model.thread.shell.worktreePath ?? workspaceRoot, !cwd.isEmpty else {
            errorMessage = "The thread's project folder is unavailable. Reconnect its project to search files."
            isSearching = false
            return
        }
        guard snapshot.query.utf16.count <= 256 else { errorMessage = "Use a shorter file search."; isSearching = false; return }
        isSearching = true
        do {
            try await Task.sleep(for: .milliseconds(200))
            let result = try await model.request("projects.searchEntries", payload: .object([
                "cwd": .string(cwd), "query": .string(snapshot.query), "limit": .number(20)
            ]), reportsErrors: false)
            try Task.checkCancellation()
            pathItems = (result.objectValue?["entries"]?.arrayValue ?? []).prefix(20).compactMap { value in
                guard let entry = value.objectValue, let path = entry["path"]?.stringValue else { return nil }
                return .init(id: "path:\(path)", title: path.split(separator: "/").last.map(String.init) ?? path,
                             detail: path, symbol: entry["kind"]?.stringValue == "directory" ? "folder" : "doc",
                             action: .insert(AgentThreadComposerTrigger.fileLink(path) + " "))
            }
            loadedTrigger = snapshot
            isSearching = false
        } catch is CancellationError { return }
        catch {
            guard !Task.isCancelled else { return }
            errorMessage = error.localizedDescription
            isSearching = false
        }
    }
}
