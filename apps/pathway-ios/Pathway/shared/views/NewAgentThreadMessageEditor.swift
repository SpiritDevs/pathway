import ImageIO
import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

struct NewAgentThreadMessageEditor: View {
    @Bindable var model: PathwayAgentThreadCreationModel
    @FocusState.Binding var isFocused: Bool
    @State private var selection: TextSelection?
    @State private var showsFiles = false
    @State private var showsPhotos = false
    #if os(iOS)
    @State private var capture: Capture?
    private enum Capture: String, Identifiable { case camera, document; var id: String { rawValue } }
    #endif
    @State private var photos: [PhotosPickerItem] = []
    @State private var showsStash = false
    @State private var stash: AgentThreadPromptStash?
    @State private var stashCount = 0
    @State private var isStashing = false
    @State private var errorMessage: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if isFocused, let trigger {
                NewAgentThreadSuggestions(model: model, trigger: trigger, select: selectSuggestion)
            }
            if !model.attachments.drafts.isEmpty { attachmentStrip }
            TextField("Ask anything…", text: $model.prompt, selection: $selection, axis: .vertical)
                .lineLimit(3...8).focused($isFocused).textFieldStyle(.plain)
                .accessibilityIdentifier("new-agent-thread-prompt")
            if model.prompt.count > 120_000 {
                Text("Use 120,000 characters or fewer.").font(.caption).foregroundStyle(.red)
            }
            HStack(spacing: 8) {
                Menu {
                    Button("Photos", systemImage: "photo.on.rectangle") { showsPhotos = true }
                    Button("Choose files", systemImage: "folder") { showsFiles = true }
                    #if os(iOS)
                    if PathwayCameraCapture.isSupported {
                        Button("Take photo", systemImage: "camera") { requestCapture(.camera) }
                    }
                    if PathwayDocumentCapture.isSupported, model.attachments.maximumFileBytes != nil {
                        Button("Scan document", systemImage: "document.viewfinder") { requestCapture(.document) }
                    }
                    #endif
                } label: {
                    Label("Attach", systemImage: "paperclip").frame(minHeight: 44)
                }
                .disabled(!model.attachments.supportsUploads || model.attachments.drafts.count >= 8 || model.isLaunching)
                Button("Save draft", systemImage: "tray.and.arrow.down") { stashDraft() }
                    .labelStyle(.iconOnly).frame(minWidth: 44, minHeight: 44)
                    .disabled(stash == nil || isStashing || model.isLaunching || (model.prompt.isEmpty && model.attachments.drafts.isEmpty))
                Button("Saved prompts (\(stashCount))", systemImage: "tray.full") { showsStash = true }
                    .frame(minHeight: 44).disabled(stash == nil || model.isLaunching)
                Spacer(minLength: 0)
            }
            .font(.subheadline)
            if let error = errorMessage ?? model.attachments.errorMessage {
                HStack(alignment: .top) {
                    Text(error).font(.caption).foregroundStyle(.red)
                    Spacer(minLength: 0)
                    Button("Dismiss error", systemImage: "xmark") { errorMessage = nil; model.attachments.clearError() }
                        .labelStyle(.iconOnly).frame(minWidth: 44, minHeight: 44)
                }
            }
        }
        .fileImporter(isPresented: $showsFiles, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
            switch result {
            case let .success(urls): Task { for url in urls { await model.attachments.add(fileURL: url) } }
            case let .failure(error): errorMessage = error.localizedDescription
            }
        }
        .photosPicker(isPresented: $showsPhotos, selection: $photos, maxSelectionCount: max(1, 8 - model.attachments.drafts.count),
            matching: .images, preferredItemEncoding: .compatible)
        .onChange(of: photos) { _, selected in
            guard !selected.isEmpty else { return }
            photos = []
            Task {
                for (index, photo) in selected.enumerated() {
                    do {
                        guard let data = try await photo.loadTransferable(type: Data.self) else { continue }
                        let identifier = CGImageSourceCreateWithData(data as CFData, nil).flatMap(CGImageSourceGetType)
                        let type = identifier.flatMap { UTType($0 as String) } ?? .jpeg
                        await model.attachments.add(data: data, name: "Photo \(index + 1).\(type.preferredFilenameExtension ?? "jpg")",
                            mimeType: type.preferredMIMEType ?? "image/jpeg")
                    } catch { errorMessage = error.localizedDescription }
                }
            }
        }
        #if os(iOS)
        .sheet(item: $capture) { kind in
            switch kind {
            case .camera: PathwayCameraCapture { captureResult($0, name: "Camera Photo.jpg", mimeType: "image/jpeg") }.ignoresSafeArea()
            case .document: PathwayDocumentCapture { captureResult($0, name: "Scanned Document.pdf", mimeType: "application/pdf") }.ignoresSafeArea()
            }
        }
        #endif
        .sheet(isPresented: $showsStash, onDismiss: { Task { await loadStashCount() } }) {
            if let stash { AgentThreadPromptStashSheet(store: stash, restore: restoreStash).presentationDetents([.medium, .large]) }
        }
        .task(id: model.storageDirectory) {
            stash = model.storageDirectory.map { AgentThreadPromptStash(directory: $0.appending(path: "PromptStash")) }
            await loadStashCount()
        }
    }

    #if os(iOS)
    private func requestCapture(_ kind: Capture) {
        Task {
            if await PathwayCameraPermission.request() { capture = kind }
            else { errorMessage = "Allow Camera access in Settings to take photos or scan documents." }
        }
    }

    private func captureResult(_ result: Result<Data, any Error>, name: String, mimeType: String) {
        switch result {
        case let .success(data): Task { await model.attachments.add(data: data, name: name, mimeType: mimeType) }
        case let .failure(error): errorMessage = error.localizedDescription
        }
    }
    #endif

    private var attachmentStrip: some View {
        ScrollView(.horizontal) {
            HStack(spacing: 8) {
                ForEach(model.attachments.drafts) { attachment in
                    HStack(spacing: 5) {
                        Label(attachment.name, systemImage: attachment.type == "image" ? "photo" : "doc")
                            .font(.caption).lineLimit(1).frame(maxWidth: 140)
                        switch attachment.state {
                        case .uploading: ProgressView().controlSize(.small)
                        case .failed:
                            Button("Retry \(attachment.name)", systemImage: "arrow.clockwise") { Task { await model.attachments.retry(id: attachment.id) } }
                                .labelStyle(.iconOnly).frame(width: 44, height: 44)
                        case .ready: EmptyView()
                        }
                        Button("Remove \(attachment.name)", systemImage: "xmark.circle.fill") { Task { await model.attachments.remove(id: attachment.id) } }
                            .labelStyle(.iconOnly).frame(width: 44, height: 44)
                    }.padding(.leading, 10).background(.quaternary, in: Capsule())
                }
            }
        }.scrollIndicators(.hidden).disabled(model.isLaunching)
    }

    private var trigger: AgentThreadComposerTrigger? {
        let cursor: Int
        if let selection {
            switch selection.indices {
            case let .selection(range):
                guard range.isEmpty else { return nil }
                cursor = range.lowerBound <= model.prompt.endIndex ? range.lowerBound.utf16Offset(in: model.prompt) : model.prompt.utf16.count
            case .multiSelection: return nil
            @unknown default: return nil
            }
        } else { cursor = model.prompt.utf16.count }
        return AgentThreadComposerTrigger.detect(in: model.prompt, cursor: cursor)
    }

    private func selectSuggestion(_ suggestion: AgentThreadComposerSuggestion, trigger original: AgentThreadComposerTrigger) {
        guard trigger == original, !model.isLaunching else { return }
        let replacement: String
        switch suggestion.action {
        case let .insert(text): replacement = text
        case let .model(value): model.selectedProviderID = value.instanceId; model.selectedModelID = value.model; replacement = ""
        case let .mode(mode): model.interactionMode = mode; replacement = ""
        }
        guard let result = original.replacing(in: model.prompt, with: replacement) else { return }
        model.prompt = result.text
        if let range = Range(NSRange(location: result.cursor, length: 0), in: result.text) {
            selection = TextSelection(insertionPoint: range.lowerBound)
        }
        isFocused = true
    }

    private func loadStashCount() async { stashCount = (try? await stash?.entries().count) ?? 0 }

    private func stashDraft() {
        guard let stash, !isStashing else { return }
        isStashing = true
        let text = model.prompt
        let selected = model.attachments.drafts
        Task {
            defer { isStashing = false }
            do {
                let attachments = try selected.map { draft -> AgentThreadStashAttachment in
                    guard let bytes = model.attachments.bytes[draft.id] else { throw PathwayThreadConversationError.message("Reattach \(draft.name) before saving this draft.") }
                    return .init(name: draft.name, mimeType: draft.mimeType, data: bytes)
                }
                try await stash.save(prompt: text, attachments: attachments)
                if model.prompt == text { model.prompt = "" }
                for draft in selected { await model.attachments.remove(id: draft.id) }
                await model.persistDraftNow()
                await loadStashCount()
            } catch { errorMessage = error.localizedDescription }
        }
    }

    private func restoreStash(_ entry: AgentThreadPromptStashEntry) async throws {
        guard let stash else { throw PathwayThreadConversationError.message("Sign in to restore saved prompts.") }
        let attachments = try await stash.attachments(for: entry.id)
        func matching(_ attachment: AgentThreadStashAttachment) -> PathwayThreadAttachmentDraft? {
            model.attachments.drafts.first { $0.name == attachment.name && $0.mimeType == attachment.mimeType && model.attachments.bytes[$0.id] == attachment.data }
        }
        let missing = attachments.filter { matching($0) == nil }
        guard model.attachments.drafts.count + missing.count <= 8 else { throw PathwayThreadConversationError.message("Remove a file before restoring more attachments.") }
        for attachment in missing { await model.attachments.add(data: attachment.data, name: attachment.name, mimeType: attachment.mimeType) }
        guard attachments.allSatisfy({ matching($0)?.state == .ready }) else {
            throw PathwayThreadConversationError.message("Retry the draft's unfinished uploads, then restore this prompt again. Your saved prompt is still available.")
        }
        model.prompt = AgentThreadPromptStash.appending(entry.prompt, to: model.prompt)
        await model.persistDraftNow()
        try await stash.remove(id: entry.id)
        await loadStashCount()
        isFocused = true
    }
}
