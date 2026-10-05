import Foundation
@testable import Pathway
import Testing

@MainActor
struct PathwayWorkflowRecordingTests {
    private let prompt = "Create a reusable skill from the workflow I just recorded."

    @Test func appendsTheHandOffOnceAfterTheDraft() {
        #expect(PathwayWorkflowSkillPrompt.append(prompt, to: "Keep this  \n") == "Keep this\n\n\(prompt)")
        #expect(PathwayWorkflowSkillPrompt.append(prompt, to: "") == prompt)
        let once = PathwayWorkflowSkillPrompt.append(prompt, to: "Keep this")
        #expect(PathwayWorkflowSkillPrompt.append(prompt, to: once) == once)
    }

    @Test func removesOnlyTheExactHandOff() {
        #expect(PathwayWorkflowSkillPrompt.remove(prompt, from: "Keep this\n\n\(prompt)") == "Keep this")
        #expect(PathwayWorkflowSkillPrompt.remove(prompt, from: prompt) == "")
        #expect(PathwayWorkflowSkillPrompt.remove(prompt, from: "Edited prompt") == "Edited prompt")
    }

    @Test func readsThePromptOnlyFromCompletedStatuses() throws {
        let completed = try #require(PathwayWorkflowRecordingStatus(.object([
            "supported": .bool(true), "phase": .string("completed"), "eventCount": .number(3),
            "endReason": .string("size-limit"), "targetName": .string("Studio"), "skillPrompt": .string(prompt),
        ])))
        #expect(completed.skillPrompt == prompt && completed.targetName == "Studio" && !completed.isActive)
        let recording = try #require(PathwayWorkflowRecordingStatus(.object([
            "supported": .bool(true), "phase": .string("recording"), "eventCount": .number(1), "skillPrompt": .string(prompt),
        ])))
        #expect(recording.skillPrompt == nil && recording.isActive)
        #expect(PathwayWorkflowRecordingStatus(.object(["supported": .bool(true)])) == nil)
    }

    @Test func startTakesBackTheOldHandOffBeforeRecordingAgain() async {
        var methods: [String] = []
        let model = makeModel { method, _ in
            methods.append(method)
            return method == "computer.recording.start"
                ? .object(["supported": .bool(true), "phase": .string("awaiting-confirmation"), "eventCount": .number(0)])
                : .object(["supported": .bool(true), "phase": .string("completed"), "eventCount": .number(2),
                           "skillPrompt": .string("Create a reusable skill from the workflow I just recorded.")])
        }
        await model.workflowRecording.refresh(model)
        model.draft = "Keep this"
        model.appendWorkflowSkillPrompt()
        #expect(model.workflowSkillPromptAdded)
        await model.startWorkflowRecording()
        #expect(model.draft == "Keep this")
        #expect(model.workflowRecording.status?.phase == "awaiting-confirmation")
        #expect(methods == ["computer.recording.status", "computer.recording.start"])
    }

    private func makeModel(request: @escaping PathwayAgentThreadModel.Request) -> PathwayAgentThreadModel {
        let thread = makeAgentThread()
        let environment = PathwayCompanyEnvironment(companyId: thread.companyId, environment: PathwayEnvironment(id: "environment", environmentId: thread.environmentId,
            descriptor: PathwayEnvironmentDescriptor(environmentId: thread.environmentId, label: "Mac", serverVersion: "test"), relayLinkState: "connected", managedEndpointAvailable: true, lastSeenAt: nil, state: "active"))
        return PathwayAgentThreadModel(thread: thread, environment: environment, request: request)
    }
}
