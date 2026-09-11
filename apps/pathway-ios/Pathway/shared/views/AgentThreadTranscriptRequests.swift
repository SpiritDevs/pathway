import SwiftUI
import PhotosUI
import UniformTypeIdentifiers
import ImageIO

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
    @State private var dismissalTask: Task<Void, Never>?
    @State private var isPendingDismissal = false
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
            if isPendingDismissal {
                HStack {
                    Label(responding ? "Ignoring question…" : "Ignoring in 5 seconds", systemImage: "xmark.circle")
                        .font(.subheadline).foregroundStyle(.secondary)
                    Spacer()
                    Button("Undo") { cancelUnsentDismissal() }
                        .buttonStyle(.bordered)
                        .disabled(responding)
                        .accessibilityIdentifier("thread-question-undo-\(item.id)")
                }
            } else if !submitted, let question, item.requiresResponse || model.canDismissQuestion(item) {
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
                if model.supportsQuestionAttachments, question.isOther != false, question.isSecret != true,
                   let attachments = model.questionAttachmentStores["\(item.id):\(question.id)"] {
                    AgentQuestionAttachments(item: item, questionID: question.id, model: model, attachments: attachments)
                        .id(question.id)
                        .disabled(!model.canRespond(to: item))
                }
                if let errorMessage { Text(errorMessage).font(.caption).foregroundStyle(.red) }
                HStack {
                    if model.supportsUserInputDismissal {
                        Button(role: .destructive) { stageDismissal() } label: {
                            Label("Ignore", systemImage: "xmark")
                        }
                        .disabled(!model.canDismissQuestion(item))
                        .accessibilityIdentifier("thread-question-ignore-\(item.id)")
                    }
                    if questionIndex > 0 {
                        Button("Back", systemImage: "chevron.left") { questionIndex -= 1; focusedQuestion = nil }
                    }
                    Spacer()
                    Button(isLast ? "Send answer" : "Continue") { advance() }
                        .buttonStyle(.borderedProminent)
                        .disabled(answer(for: question) == nil || responding || !model.canRespond(to: item) || !model.questionAttachmentsReady(item))
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
        .onChange(of: model.supportsQuestionAttachments) { _, _ in model.prepareQuestionDraft(for: item) }
        .onDisappear { cancelUnsentDismissal() }
    }

    private func optionRow(_ option: PathwayThreadQuestion.Option, index: Int, question: PathwayThreadQuestion) -> some View {
        let checked = selectedOptions(for: question).contains(option.label) && custom[question.id, default: ""].trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        return Button {
            selected[question.id] = selectedOptions(for: question)
            model.questionDrafts[item.id]?.implicitSelections.remove(question.id)
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
            selected[id] = model.questionDrafts[item.id]?.selectedOptions(for: id,
                hasAttachments: model.questionAttachmentStores["\(item.id):\(id)"]?.drafts.isEmpty == false) ?? []
            model.questionDrafts[item.id]?.implicitSelections.remove(id)
            custom[id] = value
            if !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { selected[id] = [] }
        })
    }
    private func selectedOptions(for question: PathwayThreadQuestion) -> Set<String> {
        model.questionDrafts[item.id]?.selectedOptions(for: question.id,
            hasAttachments: model.questionAttachmentStores["\(item.id):\(question.id)"]?.drafts.isEmpty == false) ?? []
    }
    private func answer(for question: PathwayThreadQuestion) -> JSONValue? {
        let text = custom[question.id, default: ""].trimmingCharacters(in: .whitespacesAndNewlines)
        if !text.isEmpty { return .string(text) }
        let ordered = question.options.map(\.label).filter { selectedOptions(for: question).contains($0) }
        guard let first = ordered.first else {
            return model.questionAttachmentStores["\(item.id):\(question.id)"]?.drafts.isEmpty == false ? .string("") : nil
        }
        return question.multiSelect == true ? .array(ordered.map(JSONValue.string)) : .string(first)
    }
    private func advance() {
        guard let question, answer(for: question) != nil, model.questionAttachmentsReady(item) else { return }
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
    private func stageDismissal() {
        guard dismissalTask == nil, model.canDismissQuestion(item), let requestID = item.requestID else { return }
        focusedQuestion = nil
        errorMessage = nil
        isPendingDismissal = true
        dismissalTask = Task {
            do { try await Task.sleep(for: .seconds(5)) }
            catch { return }
            guard !Task.isCancelled else { return }
            responding = true
            do {
                try await model.dismissQuestion(requestID: requestID)
            } catch {
                errorMessage = error.localizedDescription
            }
            responding = false
            isPendingDismissal = false
            dismissalTask = nil
        }
    }
    private func cancelUnsentDismissal() {
        guard !responding else { return }
        dismissalTask?.cancel()
        dismissalTask = nil
        isPendingDismissal = false
    }
}

private struct AgentQuestionAttachments: View {
    let item: PathwayTimelineItem
    let questionID: String
    let model: PathwayAgentThreadModel
    let attachments: PathwayNewThreadAttachments
    @State private var showsPhotos = false
    @State private var showsFiles = false
    @State private var photos: [PhotosPickerItem] = []
    @State private var errorMessage: String?

    private var room: Int { max(0, 8 - model.questionAttachmentCount(item)) }
    private var importing: Bool { model.preparingQuestionAttachments.contains(item.id) || model.restoringQuestionAttachments.contains(item.id) }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ScrollView(.horizontal) {
                HStack {
                    ForEach(attachments.drafts) { draft in
                        AgentThreadComposerAttachmentChip(attachment: draft,
                            remove: { Task { await attachments.remove(id: draft.id) } },
                            retry: { Task { await model.questionAttachments(item: item, questionID: questionID).retry(id: draft.id) } })
                    }
                }
            }.scrollIndicators(.hidden)
            Menu {
                Button("Photos", systemImage: "photo") { showsPhotos = true }
                Button("Choose files", systemImage: "folder") { showsFiles = true }
                PasteButton(supportedContentTypes: [.image]) { providers in paste(providers) }
            } label: { Label("Attach to answer", systemImage: "paperclip") }
                .disabled(importing || room == 0)
                .accessibilityIdentifier("thread-question-attach-\(questionID)")
            if importing { Text("Preparing attachments…").font(.caption).foregroundStyle(.secondary) }
            if let error = errorMessage ?? attachments.errorMessage { Text(error).font(.caption).foregroundStyle(.red) }
        }
        .fileImporter(isPresented: $showsFiles, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
            switch result {
            case .success(let urls):
                prepare {
                    for url in urls.prefix(room) { await attachments.add(fileURL: url) }
                }
            case .failure(let error): errorMessage = error.localizedDescription
            }
        }
        .photosPicker(isPresented: $showsPhotos, selection: $photos, maxSelectionCount: max(1, room), matching: .images, preferredItemEncoding: .compatible)
        .onChange(of: photos) { _, selected in
            guard !selected.isEmpty else { return }
            photos = []
            prepare {
                for photo in selected.prefix(room) {
                    do {
                        guard let data = try await photo.loadTransferable(type: Data.self) else { continue }
                        await addImage(data)
                    } catch { errorMessage = error.localizedDescription }
                }
            }
        }
    }

    private func prepare(_ operation: @escaping @MainActor () async -> Void) {
        guard !importing else { return }
        _ = model.questionAttachments(item: item, questionID: questionID)
        model.preparingQuestionAttachments.insert(item.id)
        Task { @MainActor in
            defer { model.preparingQuestionAttachments.remove(item.id) }
            await operation()
        }
    }

    private func addImage(_ data: Data) async {
        guard model.questionAttachmentCount(item) < 8 else { return }
        let type = CGImageSourceCreateWithData(data as CFData, nil).flatMap(CGImageSourceGetType).flatMap { UTType($0 as String) }
        await attachments.add(data: data, name: "Image.\(type?.preferredFilenameExtension ?? "png")", mimeType: type?.preferredMIMEType ?? "image/png")
    }

    private func paste(_ providers: [NSItemProvider]) {
        prepare {
            for provider in providers.prefix(room) {
                guard let type = provider.registeredTypeIdentifiers.compactMap(UTType.init).first(where: { $0.conforms(to: .image) }) else { continue }
                do {
                    let data: Data = try await withCheckedThrowingContinuation { continuation in
                        provider.loadDataRepresentation(forTypeIdentifier: type.identifier) { data, error in
                            if let data { continuation.resume(returning: data) }
                            else { continuation.resume(throwing: error ?? PathwayThreadConversationError.message("The image could not be pasted.")) }
                        }
                    }
                    await addImage(data)
                } catch { errorMessage = error.localizedDescription }
            }
        }
    }
}

struct AgentTranscriptQueueActions: View {
    let run: PathwayThreadRun
    let model: PathwayAgentThreadModel
    let canEdit: Bool
    let edit: () -> Void
    @State private var busy = false
    @State private var errorMessage: String?

    var body: some View {
        HStack {
            Spacer()
            if let errorMessage { Text(errorMessage).font(.caption).foregroundStyle(.red) }
            Menu {
                if canEdit { Button("Edit queued message", systemImage: "pencil", action: edit) }
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
