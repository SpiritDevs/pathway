import SwiftUI

struct AgentTranscriptApproval: View {
    let item: PathwayTimelineItem
    let model: PathwayAgentThreadModel
    @State private var responding = false
    @State private var submitted = false
    @State private var errorMessage: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Label(item.requiresResponse && !submitted ? "Approval needed" : "Approval", systemImage: "checkmark.shield")
                .font(.headline)
            if let text = item.text, !text.isEmpty { AgentTranscriptMarkdown(markdown: text).equatable() }
            if let errorMessage { Text(errorMessage).font(.caption).foregroundStyle(.red) }
            if item.requiresResponse && !submitted {
                if let reason = model.responseUnavailableReason(for: item) {
                    Text(reason).font(.footnote).foregroundStyle(.secondary)
                }
                HStack(spacing: 12) {
                    Button("Decline", role: .destructive) { respond("decline") }.buttonStyle(.bordered)
                    Spacer()
                    Menu {
                        Button("Allow for this session") { respond("acceptForSession") }
                        Button("Cancel turn", role: .destructive) { respond("cancel") }
                    } label: { Image(systemName: "ellipsis").padding(10) }
                    Button("Allow") { respond("accept") }.buttonStyle(.borderedProminent)
                        .accessibilityIdentifier("thread-approval-allow-\(item.id)")
                }.disabled(responding || !model.canRespond(to: item))
            } else {
                Label(submitted ? "Response sent" : item.status.capitalized, systemImage: "checkmark")
                    .font(.subheadline).foregroundStyle(.secondary)
            }
        }
        .padding(16)
        .background(Color(uiColor: .secondarySystemBackground), in: .rect(cornerRadius: 22))
        .overlay { RoundedRectangle(cornerRadius: 22).strokeBorder(.quaternary) }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("thread-approval-\(item.id)")
    }
    private func respond(_ decision: String) {
        guard let requestID = item.requestID, !responding else { return }
        responding = true
        model.actionError = nil
        Task {
            await model.respondToApproval(requestID: requestID, decision: decision)
            responding = false
            errorMessage = model.actionError
            submitted = errorMessage == nil
        }
    }
}

struct AgentTranscriptQuestions: View {
    let item: PathwayTimelineItem
    let model: PathwayAgentThreadModel
    private var selected: [String: Set<String>] {
        get { model.questionDrafts[item.id]?.selected ?? [:] }
        nonmutating set { model.questionDrafts[item.id, default: PathwayQuestionDraft()].selected = newValue }
    }
    private var custom: [String: String] {
        get { model.questionDrafts[item.id]?.custom ?? [:] }
        nonmutating set { model.questionDrafts[item.id, default: PathwayQuestionDraft()].custom = newValue }
    }
    private var questionIndex: Int {
        get { model.questionDrafts[item.id]?.questionIndex ?? 0 }
        nonmutating set { model.questionDrafts[item.id, default: PathwayQuestionDraft()].questionIndex = newValue }
    }
    @State private var responding = false
    @State private var submitted = false
    @State private var errorMessage: String?
    @FocusState private var focusedQuestion: String?

    private var question: PathwayThreadQuestion? {
        item.questions.indices.contains(questionIndex) ? item.questions[questionIndex] : item.questions.first
    }
    private var isLast: Bool { questionIndex >= item.questions.count - 1 }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack {
                Label("The agent has a question", systemImage: "questionmark.bubble")
                    .font(.headline)
                Spacer()
                if item.questions.count > 1 {
                    Text("\(min(questionIndex + 1, item.questions.count))/\(item.questions.count)")
                        .font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                }
            }
            if item.requiresResponse && !submitted, let question {
                VStack(alignment: .leading, spacing: 6) {
                    Text(question.header).font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                    Text(question.question).font(.body.weight(.medium))
                    if question.multiSelect == true { Text("Choose all that apply").font(.caption).foregroundStyle(.secondary) }
                }
                if let reason = model.responseUnavailableReason(for: item) {
                    Text(reason).font(.footnote).foregroundStyle(.secondary)
                }
                VStack(spacing: 8) {
                    ForEach(Array(question.options.enumerated()), id: \.offset) { index, option in
                        optionRow(option, index: index, question: question)
                    }
                }
                VStack(alignment: .leading, spacing: 7) {
                    Text(question.options.isEmpty ? "Your answer" : "Or write your own answer").font(.caption).foregroundStyle(.secondary)
                    if question.isSecret == true {
                        SecureField("Your answer", text: customBinding(question.id))
                            .focused($focusedQuestion, equals: question.id)
                            .accessibilityIdentifier("thread-question-custom-\(question.id)")
                    } else {
                        TextField("Your answer", text: customBinding(question.id), axis: .vertical)
                            .lineLimit(1...5).focused($focusedQuestion, equals: question.id)
                            .accessibilityIdentifier("thread-question-custom-\(question.id)")
                    }
                }
                .padding(12).background(Color(uiColor: .systemBackground), in: .rect(cornerRadius: 12))
                if let errorMessage { Text(errorMessage).font(.caption).foregroundStyle(.red) }
                HStack {
                    if questionIndex > 0 {
                        Button("Back", systemImage: "chevron.left") { questionIndex -= 1; focusedQuestion = nil }
                    }
                    Spacer()
                    Button(isLast ? "Send answer" : "Continue") { advance() }
                        .buttonStyle(.borderedProminent)
                        .disabled(answer(for: question) == nil || responding || !model.canRespond(to: item))
                        .accessibilityIdentifier(isLast ? "thread-question-submit-\(item.id)" : "thread-question-next-\(item.id)")
                }
            } else {
                ForEach(item.questions) { question in
                    VStack(alignment: .leading, spacing: 5) {
                        Text(question.question).font(.subheadline)
                        if let answer = answer(for: question) {
                            Text(answer.stringValue ?? answer.arrayValue?.compactMap(\.stringValue).joined(separator: ", ") ?? "")
                                .font(.subheadline).foregroundStyle(.secondary)
                        }
                    }
                }
                Label(submitted ? "Answer sent" : item.status.capitalized, systemImage: "checkmark")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
        .padding(16)
        .background(Color(uiColor: .secondarySystemBackground), in: .rect(cornerRadius: 22))
        .overlay { RoundedRectangle(cornerRadius: 22).strokeBorder(.quaternary) }
        .disabled(responding)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("thread-questions-\(item.id)")
        .onAppear { model.prepareQuestionDraft(for: item) }
    }

    private func optionRow(_ option: PathwayThreadQuestion.Option, index: Int, question: PathwayThreadQuestion) -> some View {
        let checked = selected[question.id]?.contains(option.label) == true && custom[question.id, default: ""].trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        return Button {
            custom[question.id] = ""
            if question.multiSelect == true {
                if selected[question.id, default: []].contains(option.label) { selected[question.id]?.remove(option.label) }
                else { selected[question.id, default: []].insert(option.label) }
            } else { selected[question.id] = [option.label] }
            focusedQuestion = nil
        } label: {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: checked ? "checkmark.circle.fill" : "circle")
                    .foregroundStyle(checked ? Color.accentColor : Color.secondary)
                VStack(alignment: .leading, spacing: 4) {
                    Text(option.label).font(.subheadline.weight(.medium)).foregroundStyle(.primary)
                    if !option.description.isEmpty { Text(option.description).font(.caption).foregroundStyle(.secondary) }
                }
                Spacer(minLength: 0)
            }.frame(maxWidth: .infinity, alignment: .leading).padding(12)
                .background(Color(uiColor: .systemBackground), in: .rect(cornerRadius: 13))
                .overlay { RoundedRectangle(cornerRadius: 13).strokeBorder(checked ? Color.accentColor.opacity(0.5) : Color.clear) }
        }
        .buttonStyle(.plain).disabled(!model.canRespond(to: item))
        .accessibilityAddTraits(checked ? .isSelected : [])
        .accessibilityIdentifier("thread-question-option-\(question.id)-\(index)")
    }

    private func customBinding(_ id: String) -> Binding<String> {
        Binding(get: { custom[id, default: ""] }, set: { value in
            custom[id] = value
            if !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { selected[id] = [] }
        })
    }
    private func answer(for question: PathwayThreadQuestion) -> JSONValue? {
        let text = custom[question.id, default: ""].trimmingCharacters(in: .whitespacesAndNewlines)
        if !text.isEmpty { return .string(text) }
        let ordered = question.options.map(\.label).filter { selected[question.id]?.contains($0) == true }
        guard let first = ordered.first else { return nil }
        return question.multiSelect == true ? .array(ordered.map(JSONValue.string)) : .string(first)
    }
    private func advance() {
        guard let question, answer(for: question) != nil else { return }
        focusedQuestion = nil
        if !isLast { questionIndex += 1; return }
        guard let requestID = item.requestID, !responding else { return }
        var answers: [String: JSONValue] = [:]
        for question in item.questions {
            guard let value = answer(for: question) else { return }
            answers[question.id] = value
        }
        responding = true
        Task {
            defer { responding = false }
            do { try await model.respondToQuestions(requestID: requestID, answers: answers); submitted = true }
            catch { errorMessage = error.localizedDescription }
        }
    }
}

struct AgentTranscriptQueueActions: View {
    let run: PathwayThreadRun
    let model: PathwayAgentThreadModel
    let edit: () -> Void
    @State private var busy = false
    @State private var errorMessage: String?

    var body: some View {
        HStack {
            Spacer()
            if let errorMessage { Text(errorMessage).font(.caption).foregroundStyle(.red) }
            Menu {
                Button("Edit queued message", systemImage: "pencil", action: edit)
                Button("Steer current turn", systemImage: "arrow.turn.up.right") { perform { try await model.steerQueuedRun(run.id) } }
                    .disabled(model.activeRunID == nil)
                Button("Move up", systemImage: "arrow.up") { move(-1) }.disabled(model.queuedRuns.first?.id == run.id)
                Button("Move down", systemImage: "arrow.down") { move(1) }.disabled(model.queuedRuns.last?.id == run.id)
                Button("Cancel queued message", systemImage: "xmark.circle", role: .destructive) { perform { try await model.cancelQueuedRun(run.id) } }
            } label: {
                Label("Queued", systemImage: "clock").font(.caption).foregroundStyle(.secondary)
            }.disabled(busy).accessibilityIdentifier("thread-queued-\(run.id)")
        }
    }
    private func move(_ offset: Int) {
        var queue = model.queuedRuns
        guard let current = queue.firstIndex(where: { $0.id == run.id }), queue.indices.contains(current + offset) else { return }
        queue.swapAt(current, current + offset)
        let after = current + offset + 1
        let beforeID = queue.indices.contains(after) ? queue[after].id : nil
        perform { try await model.reorderQueuedRun(run.id, beforeRunID: beforeID) }
    }
    private func perform(_ action: @escaping @MainActor () async throws -> Void) {
        guard !busy else { return }
        busy = true
        Task { defer { busy = false }; do { try await action() } catch { errorMessage = error.localizedDescription } }
    }
}
