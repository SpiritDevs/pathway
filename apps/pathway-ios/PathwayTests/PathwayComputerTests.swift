import Foundation
@testable import Pathway
import Testing

@MainActor
struct PathwayComputerTests {
    /// Pinned to the server's `computerApprovalCardText` and its tests.
    @Test func readsEveryPromptTheServerWrites() {
        #expect(PathwayComputerApprovalPrompt(requestKind: "computer", detail: "Allow Computer for this task") == .task)
        #expect(PathwayComputerApprovalPrompt(requestKind: "computer", detail: "Allow Computer to use Safari in this task") == .app("Safari"))
        #expect(PathwayComputerApprovalPrompt(requestKind: "computer", detail: "Allow Computer to use another app in this task") == .app("another app"))
        #expect(PathwayComputerApprovalPrompt(requestKind: "computer", detail: "Computer action needs approval: computer_click")
            == .call(toolName: "computer_click", args: nil))
        #expect(PathwayComputerApprovalPrompt(requestKind: "computer", detail: #"Computer action needs approval: computer_click {"x":812,"y":344,"label":"Save"}"#)
            == .call(toolName: "computer_click", args: ["x": .number(812), "y": .number(344), "label": .string("Save")]))
    }

    @Test func keepsTheToolWhenArgumentsAreNotAnObject() {
        #expect(PathwayComputerApprovalPrompt(requestKind: "computer", detail: "Computer action needs approval: computer_run [1,2]")
            == .call(toolName: "computer_run", args: nil))
        #expect(PathwayComputerApprovalPrompt(requestKind: "computer", detail: "Computer action needs approval: computer_run {oops")
            == .call(toolName: "computer_run", args: nil))
    }

    @Test func ignoresOtherKindsAndUnknownPrompts() {
        #expect(PathwayComputerApprovalPrompt(requestKind: "command", detail: "Allow Computer for this task") == nil)
        #expect(PathwayComputerApprovalPrompt(requestKind: "computer", detail: nil) == nil)
        #expect(PathwayComputerApprovalPrompt(requestKind: "computer", detail: "  ") == nil)
        #expect(PathwayComputerApprovalPrompt(requestKind: "computer", detail: "Something else") == nil)
        #expect(PathwayComputerApprovalPrompt(requestKind: "computer", detail: "Computer action needs approval:   ") == nil)
        #expect(PathwayComputerApprovalPrompt(requestKind: "computer", detail: "Allow Computer to use  in this task") == nil)
    }

    @Test func readsThePromptFromAnApprovalItem() throws {
        let item = try #require(PathwayTimelineItem(json: .object([
            "id": .string("item"), "type": .string("approval_request"), "status": .string("waiting"),
            "requestId": .string("request"), "requestKind": .string("computer"), "prompt": .string("Allow Computer to use Notes in this task")
        ])))
        #expect(PathwayComputerApprovalPrompt(item) == .app("Notes"))
    }

    @Test func readsSetupAndDeniedNotices() throws {
        let setup = try #require(PathwayTimelineItem(json: notice("computer_setup_required", input: [
            "missing": .array([.string("screenRecording"), .string("accessibility")]), "bundleId": .string("com.spiritdevs.pathway")
        ])))
        #expect(PathwayComputerNotice(setup) == .setupRequired(missing: ["screenRecording", "accessibility"]))
        #expect(PathwayComputerNotice.permissionList(["screenRecording", "accessibility"]) == "Accessibility and Screen Recording")
        #expect(PathwayComputerNotice.permissionList(["inputMonitoring", "accessibility", "screenRecording"]) == "Accessibility, Screen Recording and Input Monitoring")
        let undecodable = try #require(PathwayTimelineItem(json: notice("computer_setup_required", input: nil)))
        #expect(PathwayComputerNotice(undecodable) == .setupRequired(missing: []))
        let denied = try #require(PathwayTimelineItem(json: notice("computer_capability_denied", input: ["toolName": .string(" computer_click ")])))
        #expect(PathwayComputerNotice(denied) == .controlDenied(toolName: "computer_click"))
        let other = try #require(PathwayTimelineItem(json: notice("computer_click", input: [:])))
        #expect(PathwayComputerNotice(other) == nil)
    }

    @Test func noticesStayOutOfWorkFolds() throws {
        let denied = try #require(PathwayTimelineItem(json: notice("computer_capability_denied", input: [:])))
        let tool = try #require(PathwayTimelineItem(json: .object([
            "id": .string("tool"), "type": .string("dynamic_tool"), "runId": .string("run"), "toolName": .string("computer_click")
        ])))
        let rows = AgentThreadTranscriptLayout.rows([tool, denied], activeRunID: nil)
        #expect(rows.contains { $0.content == .item(denied) })
    }

    @Test func readsOnlyALeadingSlashCommand() {
        #expect(PathwayComputerInvocation.prompt(in: "/computer-use") == "")
        #expect(PathwayComputerInvocation.prompt(in: "/computer-use open Safari ") == "open Safari")
        #expect(PathwayComputerInvocation.prompt(in: "   /Computer-Use\nfile the report") == "file the report")
        #expect(PathwayComputerInvocation.prompt(in: "    /computer-use code") == nil)
        #expect(PathwayComputerInvocation.prompt(in: "\t/computer-use") == nil)
        #expect(PathwayComputerInvocation.prompt(in: "/computer-used") == nil)
        #expect(PathwayComputerInvocation.prompt(in: "please /computer-use") == nil)
        #expect(PathwayComputerInvocation.prompt(in: "> /computer-use") == nil)
    }

    @Test func sendCarriesIntentOnlyWhenAsked() {
        #expect(PathwayComputerInvocation.fields(text: "hello", controlEnabled: false, generation: 4).isEmpty)
        #expect(PathwayComputerInvocation.fields(text: "/computer-use open Notes", controlEnabled: false, generation: 4)
            == ["computerControlGeneration": .number(4)])
        #expect(PathwayComputerInvocation.fields(text: "hello", controlEnabled: true, generation: 0)
            == ["computerControlGeneration": .number(0), "enableComputerControl": .bool(true)])
        #expect(PathwayComputerInvocation(text: "/computer-use", controlEnabled: true) == .chat)
    }

    @Test func accessPolicyFollowsTheServerRule() {
        let operate: Set = ["orchestration:read", "orchestration:operate"]
        #expect(PathwayComputerAccess.canUse(policy: "any-operator", scopes: operate))
        #expect(!PathwayComputerAccess.canUse(policy: "scoped", scopes: operate))
        #expect(PathwayComputerAccess.canUse(policy: "scoped", scopes: operate.union(["computer:operate"])))
        #expect(!PathwayComputerAccess.canUse(policy: "admins-only", scopes: operate.union(["computer:operate"])))
        #expect(PathwayComputerAccess.canUse(policy: "admins-only", scopes: operate.union(["access:write"])))
    }

    @Test func asksForComputerOnlyWhereTheServerAcceptsIt() {
        let standard = PathwayConnectClient.environmentScopes(computerOperateScope: false)
        #expect(!standard.contains("computer:operate"))
        let computer = PathwayConnectClient.environmentScopes(computerOperateScope: true)
        #expect(computer == standard + ["computer:operate"])
        #expect(PathwayConnectClient.acceptsGrantedScopes(computer.joined(separator: " "), requested: computer))
        #expect(PathwayConnectClient.acceptsGrantedScopes(standard.joined(separator: " "), requested: computer))
        #expect(!PathwayConnectClient.acceptsGrantedScopes(computer.joined(separator: " "), requested: standard))
        #expect(!PathwayConnectClient.acceptsGrantedScopes(standard.dropLast().joined(separator: " "), requested: computer))
        #expect(!PathwayConnectClient.acceptsGrantedScopes((standard + ["access:write"]).joined(separator: " "), requested: standard))
    }

    @Test func onlyDesktopHostsSupportComputer() {
        func config(_ os: String) -> [String: JSONValue] { ["environment": .object(["platform": .object(["os": .string(os)])])] }
        #expect(PathwayComputerAccess.supportsComputer(serverConfig: config("darwin")))
        #expect(PathwayComputerAccess.supportsComputer(serverConfig: config("linux")))
        #expect(!PathwayComputerAccess.supportsComputer(serverConfig: config("win32")))
        #expect(!PathwayComputerAccess.supportsComputer(serverConfig: [:]))
    }

    @Test func anApprovalIsAnsweredOncePerResponseAttempt() async throws {
        var failing = true
        var sent: [JSONValue] = []
        let model = makeModel { _, payload in
            if failing { throw URLError(.networkConnectionLost) }
            sent.append(payload); return .object([:])
        }
        installApproval(in: model, session: "session-1")
        let item = try #require(model.items.first)
        await model.respondToApproval(requestID: "request-1", decision: "accept")
        #expect(!model.hasAnsweredApproval(item))
        #expect(model.actionError == URLError(.networkConnectionLost).localizedDescription)
        failing = false
        await model.respondToApproval(requestID: "request-1", decision: "accept")
        await model.respondToApproval(requestID: "request-1", decision: "decline")
        #expect(model.hasAnsweredApproval(item))
        #expect(sent.map { $0.objectValue?["decision"] } == [.string("accept")])
        installApproval(in: model, session: "session-2")
        #expect(!model.hasAnsweredApproval(item))
        await model.respondToApproval(requestID: "request-1", decision: "decline")
        #expect(sent.map { $0.objectValue?["decision"] } == [.string("accept"), .string("decline")])
    }

    @Test func enableArmsTheDraftOnce() {
        let model = makeModel { _, _ in .object([:]) }
        model.draft = "open Notes"
        model.armComputerUse()
        model.armComputerUse()
        #expect(model.draft == "/computer-use open Notes")
    }

    @Test func accessIsDeniedOnlyOnEvidence() {
        let model = makeModel { _, _ in .object([:]) }
        #expect(!model.computerAccessDenied)
        model.computerAccessPolicy = "scoped"
        #expect(!model.computerAccessDenied)
        model.computerSessionScopes = ["orchestration:read", "orchestration:operate"]
        #expect(model.computerAccessDenied)
        model.computerSessionScopes?.insert("computer:operate")
        #expect(!model.computerAccessDenied)
    }

    @Test func everySendCarriesTheComputerRule() async throws {
        let model = makeModel { _, _ in .object(["controlGeneration": .number(0)]) }
        model.serverConfig = ["environment": .object(["platform": .object(["os": .string("darwin")])])]
        #expect(try await model.computerFields(for: "hello", setting: false).isEmpty)
        #expect(try await model.computerFields(for: "/computer-use open Notes", setting: false) == ["computerControlGeneration": .number(0)])
        model.computerControlGeneration = 5
        #expect(try await model.computerFields(for: "hello", setting: true).isEmpty)
        model.computerAccessPolicy = "scoped"
        model.computerSessionScopes = ["orchestration:operate", "computer:operate"]
        #expect(try await model.computerFields(for: "hello", setting: true)
            == ["computerControlGeneration": .number(5), "enableComputerControl": .bool(true)])
        model.computerAccessPolicy = "admins-only"
        model.computerSessionScopes = ["orchestration:operate"]
        #expect(try await model.computerFields(for: "hello", setting: true).isEmpty)
    }

    @Test func aNewChatCarriesIntentOnlyToServersThatReadIt() {
        let request = "/computer-use open Notes"
        #expect(PathwayComputerInvocation.newChatFields(text: request, controlEnabled: false, launches: false, serverConfig: [:])
            == ["computerControlGeneration": .number(0)])
        #expect(PathwayComputerInvocation.newChatFields(text: request, controlEnabled: false, launches: true, serverConfig: [:]).isEmpty)
        let policy: [String: JSONValue] = ["environment": .object(["capabilities": .object(["computerPolicy": .bool(true)])])]
        #expect(PathwayComputerInvocation.newChatFields(text: "hello", controlEnabled: true, launches: true, serverConfig: policy)
            == ["computerControlGeneration": .number(0), "enableComputerControl": .bool(true)])
    }

    @Test func aBareCommandKeepsTheDraft() async {
        var sent = 0
        let model = makeModel { _, _ in sent += 1; return .object([:]) }
        model.draft = "/computer-use  "
        await model.send()
        #expect(sent == 0)
        #expect(model.draft == "/computer-use  ")
        #expect(model.actionError == PathwayComputerInvocation.bareCommandMessage)
        #expect(!PathwayComputerInvocation.isBare("/computer-use open Notes"))
        #expect(!PathwayComputerInvocation.isBare("hello"))
    }

    @Test func effortHintOffersMediumOnlyWhileEffortIsAtItsDefault() {
        func provider(driver: String = "claudeAgent", defaultEffort: String = "high", choices: [String] = ["low", "medium", "high"]) -> [PathwayServerProvider] {
            let effort = PathwayProviderOptionDescriptor(id: "effort", label: "Effort", type: "select",
                choices: choices.map { .init(id: $0, label: $0, isDefault: $0 == defaultEffort) }, currentValue: nil)
            return [.init(id: "claude", driver: driver, name: "Claude", models: [.init(id: "opus", name: "Opus", isDefault: true, optionDescriptors: [effort])], showsInteractionMode: true)]
        }
        let untouched = PathwayModelSelection(instanceId: "claude", model: "opus", options: nil)
        #expect(PathwayComputerEffortHint.mediumSelection(for: untouched, providers: provider())?.options == [.init(id: "effort", value: .string("medium"))])
        let chosen = PathwayModelSelection(instanceId: "claude", model: "opus", options: [.init(id: "effort", value: .string("low"))])
        #expect(PathwayComputerEffortHint.mediumSelection(for: chosen, providers: provider()) == nil)
        #expect(PathwayComputerEffortHint.mediumSelection(for: untouched, providers: provider(driver: "codex")) == nil)
        #expect(PathwayComputerEffortHint.mediumSelection(for: untouched, providers: provider(defaultEffort: "medium")) == nil)
        #expect(PathwayComputerEffortHint.mediumSelection(for: untouched, providers: provider(choices: ["low", "high"])) == nil)
    }

    @Test func statusReadsTheHostsDesktop() {
        func status(_ availability: [String: JSONValue], health: String = "connected", stopped: Bool = false) -> String {
            PathwayComputerPolicy.summary(.object(["availability": .object(availability), "health": .object(["status": .string(health)]),
                                                   "inputStopped": .bool(stopped)]))
        }
        #expect(status(["kind": .string("available")]) == "Ready")
        #expect(status(["kind": .string("available")], health: "reconnecting") == "Reconnecting to the desktop")
        #expect(status(["kind": .string("available")], stopped: true) == "Stopped via Escape on the host")
        #expect(status(["kind": .string("permission-required"), "missing": .array([.string("screenRecording"), .string("accessibility")])])
            == "Needs Accessibility and Screen Recording on the host")
        #expect(status(["kind": .string("backend-unavailable"), "message": .string("No Wayland session")]) == "No Wayland session")
        #expect(status([:]) == "Unavailable")
    }

    private func makeModel(request: @escaping PathwayAgentThreadModel.Request) -> PathwayAgentThreadModel {
        let thread = makeAgentThread()
        let environment = PathwayCompanyEnvironment(companyId: thread.companyId, environment: PathwayEnvironment(id: "environment", environmentId: thread.environmentId,
            descriptor: PathwayEnvironmentDescriptor(environmentId: thread.environmentId, label: "Mac", serverVersion: "test"), relayLinkState: "connected", managedEndpointAvailable: true, lastSeenAt: nil, state: "active"))
        return PathwayAgentThreadModel(thread: thread, environment: environment, request: request)
    }

    private func installApproval(in model: PathwayAgentThreadModel, session: String) {
        let approval: JSONValue = .object(["id": .string("approval"), "type": .string("approval_request"), "status": .string("waiting"),
            "requestId": .string("request-1"), "requestKind": .string("computer"), "prompt": .string("Allow Computer for this task")])
        let runtime: JSONValue = .object(["id": .string("request-1"), "status": .string("pending"),
            "responseCapability": .object(["type": .string("live"), "providerSessionId": .string(session)])])
        model.installSnapshot(.object(["visibleTurnItems": .array([.object(["item": approval])]), "runtimeRequests": .array([runtime])]))
    }

    private func notice(_ toolName: String, input: [String: JSONValue]?) -> JSONValue {
        var fields: [String: JSONValue] = ["id": .string(toolName), "type": .string("dynamic_tool"), "runId": .string("run"), "toolName": .string(toolName)]
        if let input { fields["input"] = .object(input) }
        return .object(fields)
    }
}
