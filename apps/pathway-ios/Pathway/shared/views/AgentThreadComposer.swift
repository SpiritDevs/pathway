import ImageIO
import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

/// The floating composer shares expansion state with the compact thread screen.
struct AgentThreadComposer: View {
    private static let surfaceID = "agent-thread-composer-surface"

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Bindable var model: PathwayAgentThreadModel
    @Binding var isExpanded: Bool
    @Binding var isFocused: Bool
    let modelName: String
    let usesCompactPresentation: Bool
    let isNavigationExpanded: Bool
    var onOpenThread: ((String) -> Void)? = nil
    var workspaceRoot: String? = nil

    @Namespace private var surfaceNamespace
    @State private var showsFiles = false
    @State private var showsPhotos = false
    #if os(iOS)
    @State private var capture: Capture?
    private enum Capture: String, Identifiable { case camera, document; var id: String { rawValue } }
    #endif
    @State private var showsSettings = false
    @State private var selectedPhotos: [PhotosPickerItem] = []
    @State private var errorMessage: String?
    @State private var isChangingModel = false
    @State private var isInterrupting = false
    @State private var showsBrowser = false
    @State private var showsQuestions = false
    @State private var showsStash = false
    @State private var stashCount = 0
    @State private var stash: AgentThreadPromptStash?
    @State private var isStashing = false
    @State private var isStartingNewThread = false
    @State private var textSelection: NSRange?
    @State private var isApplyingSuggestion = false
    @ScaledMetric(relativeTo: .body) private var controlDiameter: CGFloat = 44

    var body: some View {
        VStack(spacing: 8) {
            if !model.pendingAsyncQuestions.isEmpty {
                HStack {
                    Button {
                        showsQuestions = true
                    } label: {
                        Label("Questions \(model.pendingAsyncQuestions.reduce(0) { $0 + $1.questions.count })", systemImage: "questionmark.bubble")
                            .font(.subheadline)
                    }
                    .buttonStyle(.bordered)
                    .accessibilityIdentifier("thread-async-questions")
                    Spacer()
                }
                .padding(.horizontal, 20)
            }
            if usesCompactPresentation && !isExpanded {
                collapsedComposer
                    .transition(.opacity)
            } else {
                expandedComposer
                    .task {
                        guard usesCompactPresentation else { return }
                        await Task.yield()
                        guard isExpanded else { return }
                        isFocused = true
                    }
                    .transition(.opacity)
            }
        }
        .fileImporter(isPresented: $showsFiles, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
            switch result {
            case .success(let urls):
                Task { for url in urls { await model.addAttachment(fileURL: url) } }
            case .failure(let error): errorMessage = error.localizedDescription
            }
        }
        .photosPicker(isPresented: $showsPhotos, selection: $selectedPhotos,
                      maxSelectionCount: max(1, 8 - model.draftAttachments.count), matching: .images,
                      preferredItemEncoding: .compatible)
        .onChange(of: selectedPhotos) { _, photos in
            guard !photos.isEmpty else { return }
            selectedPhotos = []
            Task {
                for (index, photo) in photos.enumerated() {
                    do {
                        guard let data = try await photo.loadTransferable(type: Data.self) else { continue }
                        let type = Self.imageType(data) ?? photo.supportedContentTypes.first(where: { $0.conforms(to: .image) }) ?? .jpeg
                        await model.addAttachment(data: data, name: "Photo \(index + 1).\(type.preferredFilenameExtension ?? "jpg")",
                                                  mimeType: type.preferredMIMEType ?? "image/jpeg")
                    } catch { errorMessage = error.localizedDescription }
                }
            }
        }
        .sheet(isPresented: $showsBrowser) {
            AgentThreadRemoteBrowser(model: model)
        }
        .sheet(isPresented: $showsQuestions) {
            NavigationStack {
                ScrollView {
                    LazyVStack(spacing: 12) {
                        ForEach(model.pendingAsyncQuestions) { item in
                            AgentTranscriptQuestions(item: item, model: model)
                        }
                        if model.pendingAsyncQuestions.isEmpty {
                            Text("No unanswered questions").foregroundStyle(.secondary)
                        }
                    }.padding()
                }
                .navigationTitle("Questions")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Close", role: .cancel) { showsQuestions = false }
                    }
                }
            }
            .presentationDetents([.medium, .large])
            .presentationDragIndicator(.visible)
        }
        .onChange(of: model.pendingAsyncQuestions.isEmpty) { _, empty in
            if empty { showsQuestions = false }
        }
        #if os(iOS)
        .sheet(item: $capture) { kind in
            switch kind {
            case .camera: PathwayCameraCapture { captureResult($0, name: "Camera Photo.jpg", mimeType: "image/jpeg") }.ignoresSafeArea()
            case .document: PathwayDocumentCapture { captureResult($0, name: "Scanned Document.pdf", mimeType: "application/pdf") }.ignoresSafeArea()
            }
        }
        #endif
        .sheet(isPresented: $showsSettings) {
            AgentThreadComposerSettings(model: model)
                .presentationDetents([.medium, .large])
                .presentationDragIndicator(.visible)
        }
        .sheet(isPresented: $showsStash, onDismiss: {
            Task { await reloadStashCount() }
        }) {
            if let stash {
                AgentThreadPromptStashSheet(store: stash, restore: restoreStash)
                    .presentationDetents([.medium, .large])
            }
        }
        .task(id: model.storageDirectory) {
            stash = model.storageDirectory.map { AgentThreadPromptStash(directory: $0.appending(path: "PromptStash")) }
            await reloadStashCount()
        }
        .alert("Couldn't complete action", isPresented: Binding(get: { errorMessage != nil || model.actionError != nil }, set: { if !$0 { clearError() } })) {
            Button("OK", role: .cancel) { clearError() }
        } message: { Text(errorMessage ?? model.actionError ?? "") }
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
        case let .success(data): Task { await model.addAttachment(data: data, name: name, mimeType: mimeType) }
        case let .failure(error): errorMessage = error.localizedDescription
        }
    }
    #endif

    private var collapsedComposer: some View {
        HStack(spacing: 6) {
            Button {
                withAnimation(reduceMotion ? nil : CompactAppShellMetrics.navigationChromeAnimation) { isExpanded = true }
            } label: {
                HStack(spacing: 14) {
                    Image(systemName: "plus").font(.title3)
                    Text(model.draft.isEmpty ? promptPlaceholder : model.draft)
                        .foregroundStyle(model.draft.isEmpty ? Color.secondary : .primary)
                        .lineLimit(1)
                    Spacer(minLength: 0)
                    if !model.draftAttachments.isEmpty {
                        Label("\(model.draftAttachments.count)", systemImage: "paperclip")
                            .font(.subheadline)
                    }
                }
                .padding(.leading, 18)
                .frame(maxWidth: .infinity, minHeight: CompactAppShellMetrics.tabBarHeight)
                .contentShape(Capsule())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Message agent")
            .accessibilityHint("Expands the message composer")
            if model.activeRunID != nil && hasContent { stopButton }
            sendButton
        }
        .padding(.trailing, 8)
        .foregroundStyle(.primary)
        .background {
            Capsule().fill(.regularMaterial)
                .overlay { Capsule().strokeBorder(.primary.opacity(0.10), lineWidth: 0.5) }
                .matchedGeometryEffect(id: Self.surfaceID, in: surfaceNamespace, isSource: !isExpanded)
        }
        .padding(.horizontal, 20)
        .padding(.vertical, CompactAppShellMetrics.tabBarBottomPadding)
        .opacity(isNavigationExpanded ? 0 : 1)
        .allowsHitTesting(!isNavigationExpanded)
        .accessibilityHidden(isNavigationExpanded)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("agent-thread-composer-collapsed")
    }

    private var expandedComposer: some View {
        VStack(alignment: .leading, spacing: 10) {
            if isFocused, let trigger = composerTrigger {
                AgentThreadComposerSuggestions(model: model, trigger: trigger, workspaceRoot: workspaceRoot, select: selectSuggestion)
                    .disabled(isApplyingSuggestion)
            }
            if !model.draftAttachments.isEmpty {
                AgentThreadComposerAttachments(model: model)
            }
            AgentComposerTextInput(text: $model.draft, selection: $textSelection,
                isFocused: $isFocused,
                placeholder: promptPlaceholder, pasteImages: pasteImages)
                .overlay(alignment: .topLeading) {
                    if model.draft.isEmpty {
                        Text(promptPlaceholder).foregroundStyle(.tertiary).allowsHitTesting(false)
                            .accessibilityHidden(true)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .topLeading)
            if model.draft.count > 120_000 {
                Text("Message is too long. Use 120,000 characters or fewer.")
                    .font(.caption).foregroundStyle(.red)
            }
            composerToolbar
        }
        .padding(14)
        .background {
            RoundedRectangle(cornerRadius: 26).fill(.regularMaterial)
                .overlay { RoundedRectangle(cornerRadius: 26).strokeBorder(.primary.opacity(0.10), lineWidth: 0.5) }
                .matchedGeometryEffect(id: Self.surfaceID, in: surfaceNamespace, isSource: isExpanded)
        }
        .padding(.horizontal, 12)
        .padding(.top, 8)
        .padding(.bottom, CompactAppShellMetrics.tabBarBottomPadding)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("agent-thread-composer-expanded")
    }

    private var composerToolbar: some View {
        HStack(spacing: 6) {
            attachmentMenu
            modelMenu
            Button { showsSettings = true } label: {
                Image(systemName: model.interactionMode == "plan" ? "list.bullet.clipboard" : "slider.horizontal.3")
                    .frame(width: controlDiameter, height: controlDiameter)
                    .contentShape(Circle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Composer options")
            .accessibilityIdentifier("agent-thread-composer-options")
            Button { showsBrowser = true } label: {
                Image(systemName: "globe")
                    .frame(width: controlDiameter, height: controlDiameter)
                    .contentShape(Circle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Environment browser")
            .accessibilityIdentifier("agent-thread-browser")
            Spacer(minLength: 0)
            if model.activeRunID != nil && hasContent { stopButton }
            sendButton
        }
        .foregroundStyle(.primary)
    }

    private var attachmentMenu: some View {
        Menu {
            Group {
                Button("Photos", systemImage: "photo.on.rectangle") { showsPhotos = true }
                Button("Choose files", systemImage: "folder") { showsFiles = true }
                #if os(iOS)
                if PathwayCameraCapture.isSupported {
                    Button("Take photo", systemImage: "camera") { requestCapture(.camera) }
                }
                if PathwayDocumentCapture.isSupported, model.maximumFileAttachmentBytes != nil {
                    Button("Scan document", systemImage: "document.viewfinder") { requestCapture(.document) }
                }
                #endif
                PasteButton(supportedContentTypes: [.image]) { providers in pasteImages(providers) }
            }
            .disabled(!model.supportsAttachmentUploads || model.draftAttachments.count >= 8)
            Divider()
            Button("Stash draft", systemImage: "tray.and.arrow.down") { stashDraft() }
                .disabled(stash == nil || !hasContent || model.draftAttachments.contains(where: { $0.state != .ready }))
            Button("Saved prompts (\(stashCount))", systemImage: "tray.full") { showsStash = true }
                .disabled(stash == nil)
        } label: {
            Image(systemName: "plus").font(.title3)
                .frame(width: controlDiameter, height: controlDiameter)
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .disabled(model.isSending || isStashing || isStartingNewThread)
        .accessibilityLabel("Add attachment")
        .accessibilityIdentifier("agent-thread-add-attachment")
    }

    private var selectedModelName: String {
        model.providers.first { $0.id == model.currentModelSelection.instanceId }?.models
            .first { $0.id == model.currentModelSelection.model }?.name ?? model.currentModelSelection.model
    }

    private var modelMenu: some View {
        Menu {
            AgentThreadModelMenuContent(
                providers: model.modelCatalog.isEmpty ? model.providers : model.modelCatalog,
                selection: model.currentModelSelection,
                environmentID: model.thread.environmentId,
                onSelect: changeModel
            )
        } label: {
            HStack(spacing: 4) {
                Text(selectedModelName.isEmpty ? modelName : selectedModelName).lineLimit(1)
                if isChangingModel || (model.providers.isEmpty && model.connectionState == .connecting) { ProgressView().controlSize(.mini) }
                else { Image(systemName: "chevron.down").font(.caption2.weight(.semibold)) }
            }
            .font(.subheadline)
            .frame(minHeight: controlDiameter)
            .contentShape(Rectangle())
        }
        .menuOrder(.fixed)
        .buttonStyle(.plain)
        .disabled((model.providers.isEmpty && model.modelCatalog.isEmpty) || isChangingModel || model.isSending || model.isConfigurationLocked)
        .accessibilityLabel("Thread model")
        .accessibilityValue(selectedModelName)
        .accessibilityIdentifier("agent-thread-model-picker")
    }

    private var stopButton: some View {
        Button(action: interrupt) {
            Group {
                if isInterrupting { ProgressView().tint(Color(.systemBackground)) }
                else { Image(systemName: "stop.fill").font(.subheadline) }
            }
            .frame(width: controlDiameter, height: controlDiameter)
            .foregroundStyle(Color(.systemBackground))
            .background(Color.primary, in: Circle())
        }
        .buttonStyle(.plain)
        .disabled(isInterrupting || !model.isSubscriptionReady)
        .accessibilityLabel("Stop response")
        .accessibilityIdentifier("agent-thread-stop")
    }

    private var sendButton: some View {
        let stopsResponse = model.activeRunID != nil && !hasContent
        let showsProgress = !hasContent && (model.isSending || isStartingNewThread || isInterrupting
            || model.activity == .preparing || model.activity == .starting || model.activity == .working)
        let prominent = model.canSend || showsProgress || stopsResponse
        let foreground = prominent ? Color(.systemBackground) : Color.secondary
        return Button {
            if stopsResponse { interrupt() } else { send() }
        } label: {
            Group {
                if showsProgress {
                    if reduceMotion {
                        Image(systemName: "arrow.triangle.2.circlepath")
                    } else {
                        ProgressView().tint(foreground)
                    }
                }
                else if stopsResponse { Image(systemName: "stop.fill").font(.subheadline) }
                else { Image(systemName: model.activeRunID == nil ? "arrow.up" : PathwayGeneralPreferences.shared.activeTurnSendMode == "steer" ? "arrow.turn.up.right" : "text.line.last.and.arrowtriangle.forward").font(.body.weight(.bold)) }
            }
            .frame(width: controlDiameter, height: controlDiameter)
            .foregroundStyle(foreground)
            .background(prominent ? Color.primary : Color(.tertiarySystemFill), in: Circle())
        }
        .buttonStyle(.plain)
        .disabled(isInterrupting || isStartingNewThread || isStashing || (stopsResponse ? !model.isSubscriptionReady : !model.canSend))
        .contextMenu {
            if model.activeRunID != nil && model.canSend {
                Button("Queue message", systemImage: "text.line.last.and.arrowtriangle.forward") { send(mode: "queue") }
                Button("Steer now", systemImage: "arrow.turn.up.right") { send(mode: "steer") }
            }
            if onOpenThread != nil && model.canSend {
                Button("Start in new chat", systemImage: "square.and.pencil") { startNewThread(sideChat: false) }
                    .disabled(model.thread.shell.isTemporary)
                Button("Start in side chat", systemImage: "rectangle.split.2x1") { startNewThread(sideChat: true) }
                    .disabled(model.thread.shell.isTemporary || !model.canStartSideChat)
                if model.thread.shell.isTemporary { Text("Keep conversation before starting another chat from this workspace.") }
            }
        }
        .accessibilityLabel(stopsResponse ? "Stop response" : model.activeRunID == nil ? "Send message" : PathwayGeneralPreferences.shared.activeTurnSendMode == "steer" ? "Steer now" : "Queue message")
        .accessibilityValue(isInterrupting ? "Stopping…" : model.activity?.rawValue ?? "")
        .accessibilityIdentifier(stopsResponse ? "agent-thread-stop" : "agent-thread-send")
    }

    private func interrupt() {
        guard !isInterrupting, model.isSubscriptionReady else { return }
        isInterrupting = true
        Task {
            defer { isInterrupting = false }
            do { try await model.interrupt() }
            catch { errorMessage = error.localizedDescription }
        }
    }

    private var hasContent: Bool { !model.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !model.draftAttachments.isEmpty }
    private var promptPlaceholder: String { model.environmentLabel.isEmpty ? "Message agent" : "Work on \(model.environmentLabel)" }
    private var composerTrigger: AgentThreadComposerTrigger? {
        guard !model.draft.isEmpty else { return nil }
        let cursor: Int
        if let textSelection {
            guard textSelection.length == 0 else { return nil }
            cursor = min(textSelection.location, model.draft.utf16.count)
        } else { cursor = model.draft.utf16.count }
        return AgentThreadComposerTrigger.detect(in: model.draft, cursor: cursor)
    }

    private func selectSuggestion(_ suggestion: AgentThreadComposerSuggestion, trigger: AgentThreadComposerTrigger) {
        guard composerTrigger == trigger, !isApplyingSuggestion else { return }
        switch suggestion.action {
        case .insert(let text): applySuggestion(trigger, replacement: text)
        case .model(let selection):
            isApplyingSuggestion = true
            Task {
                defer { isApplyingSuggestion = false }
                do {
                    if selection.instanceId != model.currentModelSelection.instanceId || selection.model != model.currentModelSelection.model {
                        try await model.changeModelSelection(selection)
                    }
                    applySuggestion(trigger, replacement: "")
                } catch { errorMessage = error.localizedDescription }
            }
        case .mode(let mode):
            isApplyingSuggestion = true
            Task {
                defer { isApplyingSuggestion = false }
                do { try await model.setInteractionMode(mode); applySuggestion(trigger, replacement: "") }
                catch { errorMessage = error.localizedDescription }
            }
        }
    }

    private func applySuggestion(_ trigger: AgentThreadComposerTrigger, replacement: String) {
        guard composerTrigger == trigger, let result = trigger.replacing(in: model.draft, with: replacement) else { return }
        model.draft = result.text
        textSelection = NSRange(location: result.cursor, length: 0)
        isFocused = true
    }

    private func clearError() {
        errorMessage = nil
        model.clearActionError()
    }

    private func reloadStashCount() async {
        guard let stash else { stashCount = 0; return }
        stashCount = (try? await stash.entries().count) ?? 0
    }

    private func stashDraft() {
        guard let stash else { errorMessage = "Sign in to save prompts on this device."; return }
        guard !isStashing else { return }
        isStashing = true
        let prompt = model.draft
        let selected = model.draftAttachments
        Task {
            defer { isStashing = false }
            do {
                let attachments = try selected.map { attachment -> AgentThreadStashAttachment in
                    guard let data = model.attachmentData[attachment.id] else {
                        throw PathwayThreadConversationError.message("Reattach \(attachment.name) before stashing this draft.")
                    }
                    return .init(name: attachment.name, mimeType: attachment.mimeType, data: data)
                }
                try await stash.save(prompt: prompt, attachments: attachments)
                if model.draft == prompt { model.draft = "" }
                for attachment in selected { await model.removeAttachment(id: attachment.id) }
                stashCount = try await stash.entries().count
            } catch { errorMessage = error.localizedDescription }
        }
    }

    private func restoreStash(_ entry: AgentThreadPromptStashEntry) async throws {
        guard let stash else { throw PathwayThreadConversationError.message("Sign in to restore saved prompts.") }
        let attachments = try await stash.attachments(for: entry.id)
        let missing = attachments.filter { attachment in
            !model.draftAttachments.contains { $0.name == attachment.name && $0.mimeType == attachment.mimeType && $0.sizeBytes == attachment.data.count }
        }
        guard model.draftAttachments.count + missing.count <= 8 else {
            throw PathwayThreadConversationError.message("Remove an attachment first. Restoring this prompt would exceed the 8-file limit.")
        }
        for attachment in missing {
            await model.addAttachment(data: attachment.data, name: attachment.name, mimeType: attachment.mimeType)
        }
        guard attachments.allSatisfy({ attachment in
            model.draftAttachments.contains { $0.name == attachment.name && $0.mimeType == attachment.mimeType && $0.sizeBytes == attachment.data.count && $0.state == .ready }
        }) else {
            throw PathwayThreadConversationError.message("Some attachments couldn't upload. The saved prompt is still in your stash; retry its files, then restore it again.")
        }
        try await stash.remove(id: entry.id)
        model.draft = AgentThreadPromptStash.appending(entry.prompt, to: model.draft)
        if !entry.prompt.isEmpty {
            textSelection = NSRange(location: model.draft.utf16.count, length: 0)
        }
        stashCount = try await stash.entries().count
        isFocused = true
    }

    private func startNewThread(sideChat: Bool) {
        guard !isStartingNewThread else { return }
        isStartingNewThread = true
        Task {
            defer { isStartingNewThread = false }
            do {
                let id = try await model.startDraftInNewThread(sideChat: sideChat)
                isFocused = false
                onOpenThread?(id)
            } catch { errorMessage = error.localizedDescription }
        }
    }

    private nonisolated static func imageType(_ data: Data) -> UTType? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil),
              let identifier = CGImageSourceGetType(source) else { return nil }
        return UTType(identifier as String)
    }

    private func pasteImages(_ providers: [NSItemProvider]) {
        guard model.supportsAttachmentUploads else {
            errorMessage = "This environment does not support uploading images."; return
        }
        let room = max(0, 8 - model.draftAttachments.count)
        guard room > 0 else { errorMessage = "You can attach up to 8 files."; return }
        Task { @MainActor in
            for provider in providers.filter(PathwayPastedImage.supports).prefix(room) {
                do {
                    let image = try await PathwayPastedImage.load(provider)
                    await model.addAttachment(data: image.data, name: image.name, mimeType: image.mimeType)
                } catch is CancellationError { return }
                catch { errorMessage = error.localizedDescription }
            }
        }
    }

    private func changeModel(providerID: String, modelID: String) {
        guard providerID != model.currentModelSelection.instanceId || modelID != model.currentModelSelection.model else { return }
        isChangingModel = true
        Task {
            defer { isChangingModel = false }
            do { try await model.changeModelSelection(.init(instanceId: providerID, model: modelID, options: nil)) }
            catch { errorMessage = error.localizedDescription }
        }
    }

    private func send() {
        send(mode: PathwayGeneralPreferences.shared.activeTurnSendMode)
    }

    private func send(mode: String) {
        Task {
            await model.send(mode: mode)
            guard usesCompactPresentation, model.draft.isEmpty, model.draftAttachments.isEmpty else { return }
            withAnimation(reduceMotion ? nil : CompactAppShellMetrics.navigationChromeAnimation) { isExpanded = false }
            isFocused = false
        }
    }
}
