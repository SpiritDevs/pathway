import SwiftUI

struct PathwayWorkerControls: View {
    let chatID: String
    let work: PathwayOrchestratorRecord
    @Environment(PathwayAppModel.self) private var appModel
    @State private var expanded = false
    @State private var messages: [PathwayOrchestratorRecord] = []
    @State private var questions: [PathwayOrchestratorRecord] = []
    @State private var text = ""
    @State private var mode = "queue"
    @State private var busy = false
    @State private var editing: PathwayOrchestratorRecord?
    @State private var pendingID = UUID().uuidString
    private var model: PathwayOrchestratorsModel { appModel.cloud.orchestrators }
    private var canControl: Bool {
        model.contacts.contains { $0.id == work.string("orchestratorId") && $0.flag("canDirect") && $0.strings("capabilities").contains("threads.control") }
    }
    var body: some View {
        DisclosureGroup("Worker conversation", isExpanded: $expanded) {
            VStack(alignment: .leading, spacing: 12) {
                Text("Follow-ups target this worker. Native subagents cannot be steered independently.").font(.caption).foregroundStyle(.secondary)
                ForEach(questions.filter { ["open", "escalated", "answering"].contains($0.string("state")) }) { question in
                    PathwayWorkerQuestion(question: question, disabled: !canControl || busy || question.string("state") == "answering") { id, answers in
                        await perform(["kind": .string("answerWorkQuestion"), "id": .string(id), "questionId": .string(question.id), "answers": .object(answers.mapValues { .string($0) })])
                    }
                }
                ForEach(messages.filter { $0.string("state") != "removed" }) { message in
                    VStack(alignment: .leading, spacing: 6) {
                        Text(message.string("mode") == "answer" ? "Question reply" : message.string("text")).font(.subheadline)
                        Text("\(message.string("state")) · \(message.string("detail"))").font(.caption).foregroundStyle(.secondary)
                        if canControl && message.string("state") == "pending" {
                            HStack {
                                if message.string("mode") != "answer" {
                                    Button("Edit") { editing = message; text = message.string("text") }
                                }
                                Button("Remove") { Task { await perform(["kind": .string("removeWorkMessage"), "id": .string(message.id), "revision": .number(Double(message.number("revision")))]) } }
                                Button("Move up") {
                                    let pending = messages.filter { $0.string("state") == "pending" }
                                    guard let index = pending.firstIndex(where: { $0.id == message.id }), index > 0 else { return }
                                    var ids = pending.map(\.id); ids.swapAt(index, index - 1)
                                    Task { await perform(["kind": .string("reorderWorkMessages"), "ids": .array(ids.map { .string($0) })]) }
                                }
                            }.buttonStyle(.borderless).disabled(busy)
                        }
                    }
                }
                if canControl {
                    TextField("Worker follow-up", text: $text, axis: .vertical).lineLimit(2...6)
                    Picker("Delivery", selection: $mode) {
                        Text("After current turn").tag("queue")
                        Text("Steer running turn").tag("steer")
                    }
                    HStack {
                        Button(editing == nil ? "Send follow-up" : "Save edit") {
                            var action: [String: JSONValue] = ["kind": .string(editing == nil ? "sendWork" : "editWorkMessage"), "id": .string(editing?.id ?? pendingID), "text": .string(text)]
                            if let editing { action["revision"] = .number(Double(editing.number("revision"))) } else { action["mode"] = .string(mode) }
                            Task { if await perform(action) { text = ""; editing = nil; pendingID = UUID().uuidString } }
                        }.disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || busy)
                        if editing != nil { Button("Cancel edit") { editing = nil; text = "" } }
                        if ["queued", "working", "unknown"].contains(work.string("status")) {
                            Button("Request stop", role: .destructive) {
                                Task {
                                    busy = true; defer { busy = false }
                                    do { try await model.controlWorker("stop", ["chatId": .string(chatID), "workId": .string(work.id)]) }
                                    catch { model.errorMessage = error.localizedDescription }
                                }
                            }.disabled(busy)
                        }
                    }
                }
            }.padding(.vertical, 8)
        }
        .onChange(of: text) { _, _ in pendingID = UUID().uuidString }
        .onChange(of: mode) { _, _ in pendingID = UUID().uuidString }
        .task(id: expanded) {
            guard expanded else { return }
            do {
                for try await value in model.workerUpdates(chatID: chatID, workID: work.id) {
                    guard !Task.isCancelled else { return }
                    messages = PathwayOrchestratorRecord.records(value.objectValue?["messages"] ?? .array([]))
                    questions = PathwayOrchestratorRecord.records(value.objectValue?["questions"] ?? .array([]))
                }
            } catch { if !Task.isCancelled { model.errorMessage = error.localizedDescription } }
        }
    }
    @discardableResult private func perform(_ action: [String: JSONValue]) async -> Bool {
        guard !busy else { return false }
        busy = true; defer { busy = false }
        var fields = action; fields["workId"] = .string(work.id)
        do { try await model.controlWorker("control", ["chatId": .string(chatID), "action": .object(fields)]); return true }
        catch { model.errorMessage = error.localizedDescription; return false }
    }
}

private struct PathwayWorkerQuestion: View {
    let question: PathwayOrchestratorRecord
    let disabled: Bool
    let answer: (String, [String: String]) async -> Bool
    @State private var answers: [String: String] = [:]
    @State private var requestID = UUID().uuidString
    private var fields: [PathwayOrchestratorRecord] { PathwayOrchestratorRecord.records(question.fields["questions"] ?? .array([])) }
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(question.string("state") == "escalated" ? "Your answer is needed" : "Worker question").font(.headline)
            ForEach(fields) { field in
                TextField(field.string("question"), text: Binding(get: { answers[field.id] ?? "" }, set: { answers[field.id] = $0 }), axis: .vertical)
            }
            Button("Reply to worker") { Task { _ = await answer(requestID, answers) } }
                .disabled(disabled || fields.contains { (answers[$0.id] ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty })
        }.disabled(disabled)
        .onChange(of: answers) { _, _ in requestID = UUID().uuidString }
    }
}
