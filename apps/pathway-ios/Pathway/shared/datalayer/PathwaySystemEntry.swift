import AppIntents
import Foundation
import Observation

struct PathwaySystemRequest: Identifiable, Equatable {
    enum Destination { case compose, running, attention }
    let id = UUID()
    let destination: Destination
    let prompt: String
}

@MainActor @Observable final class PathwaySystemEntry {
    static let shared = PathwaySystemEntry()
    var request: PathwaySystemRequest?
}

struct PathwayComposeIntent: AppIntent {
    static let title: LocalizedStringResource = "Draft an Agent Prompt"
    static let description = IntentDescription("Open Pathway to choose a project and review your prompt before sending.")
    static var supportedModes: IntentModes { .foreground }
    @Parameter(title: "Prompt", inputConnectionBehavior: .connectToPreviousIntentResult) var prompt: String?
    func perform() async throws -> some IntentResult {
        guard (prompt?.count ?? 0) <= 120_000 else { throw PathwayCaptureError.invalidInput }
        await MainActor.run { PathwaySystemEntry.shared.request = .init(destination: .compose, prompt: prompt ?? "") }
        return .result()
    }
}

struct PathwayRunningAgentsIntent: AppIntent {
    static let title: LocalizedStringResource = "Open Running Agents"
    static let description = IntentDescription("See agent threads that are currently running in Pathway.")
    static var supportedModes: IntentModes { .foreground }
    func perform() async throws -> some IntentResult {
        await MainActor.run { PathwaySystemEntry.shared.request = .init(destination: .running, prompt: "") }
        return .result()
    }
}

struct PathwayAttentionIntent: AppIntent {
    static let title: LocalizedStringResource = "Review Agent Requests"
    static let description = IntentDescription("Open threads waiting for your approval or input in Pathway.")
    static var supportedModes: IntentModes { .foreground }
    func perform() async throws -> some IntentResult {
        await MainActor.run { PathwaySystemEntry.shared.request = .init(destination: .attention, prompt: "") }
        return .result()
    }
}

struct PathwayAppShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(intent: PathwayComposeIntent(), phrases: ["Draft a prompt in \(.applicationName)"], shortTitle: "Draft Prompt", systemImageName: "square.and.pencil")
        AppShortcut(intent: PathwayRunningAgentsIntent(), phrases: ["Show running agents in \(.applicationName)"], shortTitle: "Running Agents", systemImageName: "sparkles")
        AppShortcut(intent: PathwayAttentionIntent(), phrases: ["Review agent requests in \(.applicationName)"], shortTitle: "Agent Requests", systemImageName: "hand.raised")
    }
}

@MainActor @Observable final class PathwayCaptureInbox {
    static let shared = PathwayCaptureInbox()
    private(set) var drafts: [PathwayCapturedDraft] = []
    private(set) var errorMessage: String?
    private(set) var accountKey: String?
    let store = PathwayCaptureStore.shared()
    private var generation = 0

    func configure(accountDirectory: URL?) async {
        generation += 1
        let epoch = generation
        accountKey = accountDirectory?.lastPathComponent
        drafts = []; errorMessage = nil
        guard let store else { errorMessage = PathwayCaptureError.unavailable.localizedDescription; return }
        do { try await store.setActiveAccount(accountKey) }
        catch { if generation == epoch { errorMessage = error.localizedDescription }; return }
        guard generation == epoch else { return }
        await refresh()
    }
    func refresh() async {
        guard let accountKey, let store else { drafts = []; return }
        let epoch = generation
        do {
            let loaded = try await store.drafts(accountKey: accountKey)
            guard generation == epoch else { return }
            drafts = loaded; errorMessage = nil
        } catch { if generation == epoch { errorMessage = error.localizedDescription } }
    }
    func remove(_ draft: PathwayCapturedDraft) async {
        guard draft.accountKey == accountKey, let store else { return }
        do { try await store.remove(draft); await refresh() }
        catch { errorMessage = error.localizedDescription }
    }
}

extension PathwaySystemRequest {
    init?(workURL url: URL) {
        guard url.scheme == "pathway", url.host == "work", url.user == nil, url.password == nil,
              url.port == nil, url.query == nil, url.fragment == nil else { return nil }
        let destination: Destination
        switch url.path {
        case "/running": destination = .running
        case "/attention": destination = .attention
        case "/draft": destination = .compose
        default: return nil
        }
        self.init(destination: destination, prompt: "")
    }
}
