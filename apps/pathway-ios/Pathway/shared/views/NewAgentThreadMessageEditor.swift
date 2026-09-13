import ImageIO
import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

struct NewAgentThreadMessageEditor: View {
    @Bindable var model: PathwayAgentThreadCreationModel
    @Binding var isFocused: Bool
    @Binding var showsOptions: Bool
    @State private var selection: NSRange?
    @State private var pendingTool: Tool?
    private enum Tool { case photos, files, camera, document, stash }
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
            AgentComposerTextInput(text: $model.prompt, selection: $selection,
                isFocused: $isFocused,
                placeholder: "Ask anything…", pasteImages: pasteImages,
                accessibilityIdentifier: "new-agent-thread-prompt")
                .overlay(alignment: .topLeading) {
                    if model.prompt.isEmpty {
                        Text("Ask anything…").foregroundStyle(.tertiary).allowsHitTesting(false)
                            .accessibilityHidden(true)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .topLeading)
            if model.prompt.count > 120_000 {
                Text("Use 120,000 characters or fewer.").font(.caption).foregroundStyle(.red)
            }
            if let error = errorMessage ?? model.attachments.errorMessage {
                HStack(alignment: .top) {
                    Text(error).font(.caption).foregroundStyle(.red)
                    Spacer(minLength: 0)
                    Button("Dismiss error", systemImage: "xmark") { errorMessage = nil; model.attachments.clearError() }
                        .labelStyle(.iconOnly).frame(minWidth: 44, minHeight: 44)
                }
            }
        }
        .sheet(isPresented: $showsOptions, onDismiss: presentPendingTool) {
            NewAgentThreadSettings(model: model, title: "Composer Options") {
                Section("Attachments") {
                    Group {
                        Button("Photos", systemImage: "photo.on.rectangle") { chooseTool(.photos) }
                        Button("Choose files", systemImage: "folder") { chooseTool(.files) }
                        #if os(iOS)
                        if PathwayCameraCapture.isSupported {
                            Button("Take photo", systemImage: "camera") { chooseTool(.camera) }
                        }
                        if PathwayDocumentCapture.isSupported, model.attachments.maximumFileBytes != nil {
                            Button("Scan document", systemImage: "document.viewfinder") { chooseTool(.document) }
                        }
                        #endif
                        PasteButton(supportedContentTypes: [.image]) { providers in
                            showsOptions = false
                            pasteImages(providers)
                        }
                    }
                    .disabled(!model.attachments.supportsUploads || model.attachments.drafts.count >= 8 || model.isLaunching)
                }
                if model.supportsConversations, !model.usesInternalWorkspace {
                    Section {
                        Toggle("Temporary thread", isOn: $model.temporary)
                            .accessibilityHint("Deletes this thread and its working files when it settles")
                    }
                }
                Section("Prompts") {
                    Button("Save draft", systemImage: "tray.and.arrow.down") { stashDraft() }
                        .disabled(stash == nil || isStashing || model.isLaunching || (model.prompt.isEmpty && model.attachments.drafts.isEmpty))
                    Button("Saved prompts (\(stashCount))", systemImage: "tray.full") { chooseTool(.stash) }
                        .disabled(stash == nil || model.isLaunching)
                }
            }
            .presentationDetents([.medium, .large])
            .presentationDragIndicator(.visible)
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
                    AgentThreadComposerAttachmentChip(attachment: attachment,
                        remove: { Task { await model.attachments.remove(id: attachment.id) } },
                        retry: { Task { await model.attachments.retry(id: attachment.id) } })
                }
            }
        }.scrollIndicators(.hidden).disabled(model.isLaunching)
    }

    private var trigger: AgentThreadComposerTrigger? {
        let cursor: Int
        if let selection {
            guard selection.length == 0 else { return nil }
            cursor = min(selection.location, model.prompt.utf16.count)
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
        selection = NSRange(location: result.cursor, length: 0)
        isFocused = true
    }

    private func chooseTool(_ tool: Tool) {
        pendingTool = tool
        showsOptions = false
    }

    private func presentPendingTool() {
        let tool = pendingTool
        pendingTool = nil
        switch tool {
        case .photos: showsPhotos = true
        case .files: showsFiles = true
        case .stash: showsStash = true
        #if os(iOS)
        case .camera: requestCapture(.camera)
        case .document: requestCapture(.document)
        #else
        case .camera, .document: break
        #endif
        case nil: break
        }
    }

    private func pasteImages(_ providers: [NSItemProvider]) {
        guard !model.isLaunching else { return }
        guard model.attachments.supportsUploads else {
            errorMessage = "This environment does not support uploading images."; return
        }
        let room = max(0, 8 - model.attachments.drafts.count)
        guard room > 0 else { errorMessage = "You can attach up to 8 files."; return }
        Task { @MainActor in
            for provider in providers.filter(PathwayPastedImage.supports).prefix(room) {
                do {
                    let image = try await PathwayPastedImage.load(provider)
                    await model.attachments.add(data: image.data, name: image.name, mimeType: image.mimeType)
                } catch is CancellationError { return }
                catch { errorMessage = error.localizedDescription }
            }
        }
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
