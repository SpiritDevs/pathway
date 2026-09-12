#if DEBUG && !os(visionOS)
import SwiftUI

/// Isolated conversation transport for repeatable simulator interaction tests.
struct PathwayConversationSimulatorScene: View {
    @State private var workspace = ConversationSimulatorWorkspace()
    @State private var chrome = CompactThreadChromeState()
    @State private var path = [ConversationSimulatorRoute.thread]
    var body: some View {
        NavigationStack(path: $path) {
            List { NavigationLink("Bring conversations to mobile", value: ConversationSimulatorRoute.thread) }
                .navigationTitle("Threads")
                .navigationDestination(for: ConversationSimulatorRoute.self) { _ in AgentThreadConversationView(model: workspace.model) }
        }
        .environment(\.compactThreadChrome, chrome)
        .environment(workspace.appModel)
        .preferredColorScheme(.light)
    }
}

private enum ConversationSimulatorRoute: Hashable { case thread }

@MainActor
private final class ConversationSimulatorWorkspace {
    let appModel = PathwayAppModel(authProvider: ConversationSimulatorAuth())
    var model: PathwayAgentThreadModel!
    private var items: [[String: JSONValue]] = []
    private var serverConfig: JSONValue = .object([:])
    private let questions = ProcessInfo.processInfo.arguments.contains("--conversation-questions")
    private var thread: [String: JSONValue] = [
        "id": .string("sim-thread"), "projectId": .string("sim-project"),
        "title": .string("Bring conversations to mobile"), "providerInstanceId": .string("codex"),
        "modelSelection": .object(["instanceId": .string("codex"), "model": .string("gpt-5.4")]),
        "runtimeMode": .string("approval-required"), "interactionMode": .string("default"),
        "status": .string("idle"), "hasActionableProposedPlan": .bool(false),
        "itemCount": .number(8), "visibleItemCount": .number(8),
        "createdAt": .string("2026-09-06T03:00:00Z"), "updatedAt": .string("2026-09-06T03:02:00Z")
    ]
    init() {
        let shell = try! JSONDecoder().decode(PathwayAgentThreadShell.self, from: JSONEncoder().encode(JSONValue.object(thread)))
        let environment = PathwayCompanyEnvironment(companyId: "sim-company", environment: PathwayEnvironment(
            id: "sim-env", environmentId: "sim-env", descriptor: .init(environmentId: "sim-env", label: "Mac 1", serverVersion: "test"),
            relayLinkState: "connected", managedEndpointAvailable: true, lastSeenAt: nil, state: "active"))
        model = PathwayAgentThreadModel(thread: PathwayAgentThread(companyId: "sim-company", environmentId: "sim-env",
            cloudProjectId: "sim-project", shell: shell, cloudUpdatedAt: 0), environment: environment, request: { [weak self] method, payload in
                guard let self else { throw CancellationError() }
                return try self.request(method, payload)
            })
        add("user", "user_message", text: "Bring the mobile conversation in line with desktop.", extra: ["messageId": .string("message-user")])
        add("commentary", "assistant_message", text: "I’ll bring the conversation controls together, then verify the full flow on mobile.")
        add("search", "file_search", extra: ["pattern": .string("AgentThreadConversation"), "results": .array([.object(["fileName": .string("shared/views/AgentThreadsView.swift"), "line": .number(588), "preview": .string("struct AgentThreadConversationView: View")])])])
        add("command", "command_execution", extra: ["input": .string("swift test --filter ThreadConversation"), "output": .string("Executed 12 tests, with 0 failures."), "exitCode": .number(0)])
        add("change", "file_change", extra: ["fileName": .string("shared/views/AgentThreadsView.swift"), "additions": .number(68), "deletions": .number(26), "diffStr": .string("@@ -1,2 +1,3 @@\n-OldTimeline(items: items)\n+AgentThreadTranscript(model: model)\n+    .scrollDismissesKeyboard(.interactively)")])
        add("child", "subagent", extra: ["childThreadId": .string("sim-child"), "title": .string("Review conversation controls"), "prompt": .string("Check the native conversation controls."), "result": .string("Model selection and message actions verified."), "model": .string("gpt-5.4")])
        add("answer", "assistant_message", text: "The conversation now keeps the answer easy to read.\n\nCompleted work folds into a compact summary. Open the tool rows to inspect searches, commands, and file changes.\n\nSubagents have their own conversation, and your draft stays here when you come back.")
        if questions {
            add("question", "user_input_request", extra: ["requestId": .string("request-question"), "status": .string("waiting"), "runId": .string("run-question"), "questions": .array([
                .object(["id": .string("direction"), "header": .string("Direction"), "question": .string("Which conversation layout should we use?"), "options": .array([
                    .object(["label": .string("Compact (Recommended)"), "description": .string("Keep tool activity folded until needed.")]),
                    .object(["label": .string("Expanded"), "description": .string("Show every tool action in the timeline.")])])]),
                .object(["id": .string("notes"), "header": .string("Details"), "question": .string("Anything else to include?"), "options": .array([])])])])
        }
        publish()
        serverConfig = .object(["environment": .object(["capabilities": .object(["attachmentUploads": .bool(true), "fileAttachments": .object(["maxUploadBytes": .number(52428800)])])]), "providers": .array([.object([
            "instanceId": .string("codex"), "driver": .string("codex"), "displayName": .string("Codex"),
            "enabled": .bool(true), "installed": .bool(true), "availability": .string("available"), "showInteractionModeToggle": .bool(true),
            "models": .array(["gpt-5.4", "gpt-5.4-mini"].map { name in .object(["slug": .string(name), "name": .string(name), "isDefault": .bool(name == "gpt-5.4"), "capabilities": .object(["optionDescriptors": .array([
                .object(["id": .string("reasoningEffort"), "label": .string("Reasoning effort"), "type": .string("select"), "options": .array([
                    .object(["id": .string("medium"), "label": .string("Medium"), "isDefault": .bool(true)]),
                    .object(["id": .string("high"), "label": .string("High")])])])])])]) })
        ])])])
        model.installServerConfig(serverConfig)
        if ProcessInfo.processInfo.arguments.contains("--conversation-paste") {
            model.draft = "Please review this screenshot."
            UIPasteboard.general.image = UIGraphicsImageRenderer(size: CGSize(width: 320, height: 180)).image { context in
                UIColor.systemBlue.setFill()
                context.fill(CGRect(x: 0, y: 0, width: 320, height: 180))
                ("Clipboard image" as NSString).draw(at: CGPoint(x: 24, y: 72), withAttributes: [
                    .font: UIFont.systemFont(ofSize: 28, weight: .semibold), .foregroundColor: UIColor.white
                ])
            }
        }
    }
    private func add(_ id: String, _ type: String, text: String? = nil, extra: [String: JSONValue] = [:]) {
        var item: [String: JSONValue] = ["id": .string(id), "type": .string(type), "threadId": .string("sim-thread"),
            "createdBy": .string("user"), "ordinal": .number(Double(items.count)), "runId": .string("run-completed"), "status": .string("completed"),
            "startedAt": .string("2026-09-06T03:00:00Z"), "completedAt": .string("2026-09-06T03:01:14Z"), "updatedAt": .string("2026-09-06T03:01:14Z")]
        if let text { item["text"] = .string(text) }
        item.merge(extra) { _, new in new }; items.append(item)
    }
    private func projection(child: Bool = false, childID: String = "sim-child") -> JSONValue {
        var selectedThread = thread
        if child { selectedThread["id"] = .string(childID); selectedThread["title"] = .string("Review conversation controls"); selectedThread.removeValue(forKey: "status") }
        return .object(["thread": .object(selectedThread), "visibleTurnItems": .array((child ? [items[6]] : items).map { .object(["item": .object($0)]) }),
            "runs": .array([.object(["id": .string("run-completed"), "ordinal": .number(1), "status": .string("completed"), "userMessageId": .string("message-user")]), .object(["id": .string("run-sent"), "ordinal": .number(2), "status": .string("interrupted"), "modelSelection": thread["modelSelection"] ?? .null])]),
            "subagents": child ? .array([]) : .array(extraAgents + [.object(["id": .string("agent-review"), "childThreadId": .string("sim-child"), "title": .string("Review conversation controls"), "status": .string("completed"), "origin": .string("provider_native"), "model": .string("gpt-5.4")])]),
            "runtimeRequests": questions ? .array([.object(["id": .string("request-question"), "status": .string("pending"), "responseCapability": .object(["type": .string("live"), "providerSessionId": .string("session")])])]) : .array([])])
    }
    private var extraAgents: [JSONValue] {
        guard ProcessInfo.processInfo.arguments.contains("--conversation-agents") else { return [] }
        return [
            .object(["id": .string("agent-working"), "childThreadId": .string("sim-working"), "title": .string("Build mobile controls"), "status": .string("running")]),
            .object(["id": .string("agent-failed"), "childThreadId": .string("sim-failed"), "title": .string("Check attachments"), "status": .string("failed")])
        ]
    }
    private func publish() { model.installSnapshot(projection()) }
    private func request(_ method: String, _ payload: JSONValue) throws -> JSONValue {
        if method == "server.getConfig" { return serverConfig }
        if method == "orchestration.getThreadProjection" { return projection(child: true, childID: payload.objectValue?["threadId"]?.stringValue ?? "sim-child") }
        guard method == "orchestration.dispatchCommand", let command = payload.objectValue else { return .object([:]) }
        switch command["type"]?.stringValue {
        case "thread.model-selection.set": thread["modelSelection"] = command["modelSelection"]
        case "thread.runtime-mode.set": thread["runtimeMode"] = command["runtimeMode"]
        case "thread.interaction-mode.set": thread["interactionMode"] = command["interactionMode"]
        case "message.dispatch": add("sent-\(items.count)", "user_message", text: command["text"]?.stringValue, extra: ["messageId": command["messageId"] ?? .null, "runId": .string("run-sent")])
        case "message.edit-and-restart":
            if let index = items.firstIndex(where: { $0["messageId"] == command["messageId"] }) { items[index]["text"] = command["text"] }
        case "runtime-request.respond":
            if let index = items.firstIndex(where: { $0["requestId"] == command["requestId"] }) { items[index]["status"] = .string("completed") }
        default: break
        }
        publish()
        return .object(["accepted": .bool(true)])
    }
}

@MainActor private final class ConversationSimulatorAuth: PathwayAuthenticating {
    var hasActiveSession: Bool { false }
    var onSessionChanged: ((Bool) -> Void)?
    func startHostedSignIn() async throws { throw PathwayAuthError.missingSession }
    func token(template: String?) async throws -> String { throw PathwayAuthError.missingSession }
    func signOut() async throws {}
}
#endif
