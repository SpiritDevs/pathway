import PhotosUI
import SwiftUI
import UIKit
import UniformTypeIdentifiers

struct CreateDocumentFlowView: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass

    @Bindable var model: CreateDocumentFlowModel
    let onCompleted: (CreatedDocument) -> Void

    @State private var route: CreateDocumentRoute?
    @State private var isFileImporterPresented = false
    @State private var selectedPhoto: PhotosPickerItem?
    @State private var importError: String?

    init(
        model: CreateDocumentFlowModel,
        onCompleted: @escaping (CreatedDocument) -> Void = { _ in }
    ) {
        self.model = model
        self.onCompleted = onCompleted
    }

    var body: some View {
        Group {
            if let document = model.createdDocument {
                NativeDocumentEditorView(document: document) {
                    removeTemporaryImport()
                    onCompleted(document)
                    dismiss()
                }
                .onAppear { removeTemporaryImport() }
            } else {
                flow
            }
        }
        .interactiveDismissDisabled(model.hasUnsavedChanges || model.operation.isRunning)
    }

    private var flow: some View {
        NavigationStack {
            GeometryReader { proxy in
                Group {
                    if horizontalSizeClass == .regular, proxy.size.width >= 760 {
                        HStack(spacing: 0) {
                            CreateDocumentStepSidebar(
                                steps: visibleSteps,
                                currentStep: model.step
                            )
                            .frame(width: 220)

                            Divider()

                            VStack(spacing: 0) {
                                stageStatus
                                stageContent
                                    .disabled(model.operation.isRunning)
                            }
                            .frame(maxWidth: 900)
                            .frame(maxWidth: .infinity)
                        }
                    } else {
                        VStack(spacing: 0) {
                            CreateDocumentStageHeader(
                                steps: visibleSteps,
                                currentStep: model.step
                            )
                            stageStatus
                            stageContent
                                .disabled(model.operation.isRunning)
                        }
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
            .navigationTitle(model.step.title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(leadingActionTitle, action: performLeadingAction)
                }

                ToolbarItem(placement: .confirmationAction) {
                    if model.step != .choose {
                        toolbarPrimaryAction
                    }
                }
            }
            .navigationDestination(item: $route) { route in
                switch route {
                case let .recipient(id):
                    if let binding = recipientBinding(id: id) {
                        RecipientEditorView(
                            recipient: binding,
                            model: model,
                            isPrimary: isPrimaryRecipient(id),
                            canDelete: canDeleteRecipient(id)
                        )
                    } else {
                        ContentUnavailableView(
                            "Recipient unavailable",
                            systemImage: "person.crop.circle.badge.exclamationmark"
                        )
                    }
                }
            }
            .fileImporter(
                isPresented: $isFileImporterPresented,
                allowedContentTypes: [.pdf, .image],
                allowsMultipleSelection: false,
                onCompletion: handleFileImport
            )
            .onChange(of: selectedPhoto) { _, item in
                guard let item else { return }
                Task { await handlePhotoImport(item) }
            }
            .task {
                await model.load(forceRefresh: false)
            }
        }
    }

    @ViewBuilder
    private var stageContent: some View {
        switch model.step {
        case .choose:
            CreateDocumentChooseView(
                model: model,
                selectedPhoto: $selectedPhoto,
                importError: importError,
                onChooseFile: { isFileImporterPresented = true }
            )
        case .details:
            CreateDocumentDetailsView(
                model: model,
                onEditRecipient: { route = .recipient($0) },
                onAddRecipient: addRecipient
            )
        case .fields:
            CreateDocumentFieldsView(model: model)
        case .review:
            CreateDocumentReviewView(model: model) { step in
                model.step = step
            }
        }
    }

    private var visibleSteps: [CreateDocumentStep] {
        model.hasTemplateFields
            ? [.choose, .details, .fields, .review]
            : [.choose, .details, .review]
    }

    private var canContinue: Bool {
        guard !model.operation.isRunning else { return false }
        if model.step == .choose { return model.selection != nil }
        return true
    }

    private var operationError: String? {
        guard case let .failed(message) = model.operation else { return nil }
        return message
    }

    @ViewBuilder
    private var stageStatus: some View {
        let message = operationError ?? model.validationError?.errorDescription ?? importError
        if let message {
            CreateDocumentStatusBanner(message: message)
        }
    }

    private var leadingActionTitle: String {
        if model.operation.isRunning { return "Stop" }
        return model.step == .choose ? "Cancel" : "Back"
    }

    private func performLeadingAction() {
        if model.operation.isRunning {
            model.cancelCreation()
        } else if model.step == .choose {
            cancelFlow()
        } else {
            model.goBack()
        }
    }

    @ViewBuilder
    private var toolbarPrimaryAction: some View {
        if model.operation.isRunning {
            HStack(spacing: 6) {
                ProgressView()
                Text("Creating…")
                    .font(.subheadline.weight(.semibold))
            }
                .accessibilityLabel(model.operation.label)
        } else if case .failed = model.operation {
            Button("Try Again", action: retry)
                .fontWeight(.semibold)
        } else {
            Button(model.step == .review ? "Create" : "Continue", action: continueFlow)
                .fontWeight(.semibold)
                .disabled(!canContinue)
        }
    }

    private func cancelFlow() {
        removeTemporaryImport()
        model.reset()
        dismiss()
    }

    private func continueFlow() {
        importError = nil
        if model.step == .review {
            model.startCreation()
        } else {
            _ = model.goForward()
        }
    }

    private func retry() {
        if case .failed = model.operation {
            model.retryCreation()
        } else if case .failed = model.loadState {
            Task { await model.load(forceRefresh: true) }
        }
    }

    private func addRecipient() {
        model.addRecipient()
        if let id = model.recipients.last?.id {
            route = .recipient(id)
        }
    }

    private func recipientBinding(id: UUID) -> Binding<CreateDocumentRecipient>? {
        guard model.recipients.contains(where: { $0.id == id }) else { return nil }
        return Binding(
            get: {
                model.recipients.first(where: { $0.id == id }) ?? CreateDocumentRecipient(id: id)
            },
            set: { value in
                guard let index = model.recipients.firstIndex(where: { $0.id == id }) else { return }
                model.recipients[index] = value
            }
        )
    }

    private func isPrimaryRecipient(_ id: UUID) -> Bool {
        guard let index = model.recipients.firstIndex(where: { $0.id == id }) else { return false }
        return index < model.requiredPrimaryRecipientCount
    }

    private func canDeleteRecipient(_ id: UUID) -> Bool {
        guard let index = model.recipients.firstIndex(where: { $0.id == id }) else { return false }
        return index >= model.requiredPrimaryRecipientCount
    }

    private func handleFileImport(_ result: Result<[URL], Error>) {
        do {
            guard let sourceURL = try result.get().first else { return }
            Task { await importFile(at: sourceURL) }
        } catch {
            importError = "That file could not be imported. Choose another PDF or image."
        }
    }

    private func importFile(at sourceURL: URL) async {
        do {
            let kind: CreateDocumentImportKind = sourceURL.pathExtension.lowercased() == "pdf"
                ? .pdf
                : .image
            let result = try await Task.detached(priority: .userInitiated) {
                try Self.copyImportedFile(sourceURL, kind: kind)
            }.value
            removeTemporaryImport(clearDerivedTitle: true)
            model.selectImport(
                CreateDocumentImport(
                    fileURL: result.fileURL,
                    fileName: result.fileName,
                    kind: kind,
                    size: result.size
                )
            )
            importError = nil
            _ = model.goForward()
        } catch {
            importError = "That file could not be imported. Choose another PDF or image."
        }
    }

    private func handlePhotoImport(_ item: PhotosPickerItem) async {
        do {
            guard let sourceData = try await item.loadTransferable(type: Data.self) else {
                throw CocoaError(.fileReadUnknown)
            }
            let result = try await Task.detached(priority: .userInitiated) {
                guard let data = Self.normalizedJPEGData(from: sourceData) else {
                    throw CocoaError(.fileReadUnknown)
                }
                let destination = FileManager.default.temporaryDirectory
                    .appending(path: "pathway-import-\(UUID().uuidString).jpg")
                try data.write(to: destination, options: .atomic)
                return (fileURL: destination, size: data.count)
            }.value
            removeTemporaryImport(clearDerivedTitle: true)
            model.selectImport(
                CreateDocumentImport(
                    fileURL: result.fileURL,
                    fileName: "Photo.jpg",
                    kind: .image,
                    size: result.size
                )
            )
            importError = nil
            _ = model.goForward()
        } catch {
            importError = "That photo could not be imported. Choose another image."
        }
        selectedPhoto = nil
    }

    nonisolated private static func copyImportedFile(
        _ sourceURL: URL,
        kind: CreateDocumentImportKind
    ) throws -> (fileURL: URL, fileName: String, size: Int) {
        let hasAccess = sourceURL.startAccessingSecurityScopedResource()
        defer {
            if hasAccess { sourceURL.stopAccessingSecurityScopedResource() }
        }

        let destination = FileManager.default.temporaryDirectory
            .appending(path: "pathway-import-\(UUID().uuidString)-\(sourceURL.lastPathComponent)")
        let acceptedImageExtensions = ["jpg", "jpeg", "png", "gif", "svg", "webp"]
        if kind == .image,
           !acceptedImageExtensions.contains(sourceURL.pathExtension.lowercased()) {
            let sourceData = try Data(contentsOf: sourceURL)
            guard let jpeg = normalizedJPEGData(from: sourceData) else {
                throw CocoaError(.fileReadCorruptFile)
            }
            let jpegDestination = destination.deletingPathExtension().appendingPathExtension("jpg")
            try jpeg.write(to: jpegDestination, options: .atomic)
            return (
                jpegDestination,
                sourceURL.deletingPathExtension().lastPathComponent + ".jpg",
                jpeg.count
            )
        }

        try FileManager.default.copyItem(at: sourceURL, to: destination)
        let size = try destination.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
        return (destination, sourceURL.lastPathComponent, size)
    }

    nonisolated private static func normalizedJPEGData(from sourceData: Data) -> Data? {
        autoreleasepool {
            UIImage(data: sourceData)?.jpegData(compressionQuality: 0.9)
        }
    }

    private func removeTemporaryImport(clearDerivedTitle: Bool = false) {
        guard case let .imported(file) = model.selection else { return }
        let originalTitle = (file.fileName as NSString).deletingPathExtension
        let temporaryTitle = file.fileURL.deletingPathExtension().lastPathComponent
        if clearDerivedTitle,
           model.title == originalTitle || model.title == temporaryTitle {
            model.title = ""
        }
        try? FileManager.default.removeItem(at: file.fileURL)
    }
}

private enum CreateDocumentRoute: Hashable, Identifiable {
    case recipient(UUID)

    var id: String {
        switch self {
        case let .recipient(id): "recipient-\(id.uuidString)"
        }
    }
}

private struct CreateDocumentStageHeader: View {
    let steps: [CreateDocumentStep]
    let currentStep: CreateDocumentStep

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                ForEach(steps) { step in
                    Capsule()
                        .fill(step.rawValue <= currentStep.rawValue ? Color.accentColor : Color.secondary.opacity(0.18))
                        .frame(height: 4)
                }
            }

            Text(accessibilityProgress)
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .background(Color(uiColor: .systemBackground))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilityProgress)
    }

    private var accessibilityProgress: String {
        let index = (steps.firstIndex(of: currentStep) ?? 0) + 1
        return "\(currentStep.title), step \(index) of \(steps.count)"
    }
}

private struct CreateDocumentStepSidebar: View {
    let steps: [CreateDocumentStep]
    let currentStep: CreateDocumentStep

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Create document")
                .font(.title2.bold())
                .padding(.bottom, 16)

            ForEach(Array(steps.enumerated()), id: \.element.id) { index, step in
                HStack(spacing: 12) {
                    Image(systemName: step.rawValue < currentStep.rawValue ? "checkmark.circle.fill" : "\(index + 1).circle.fill")
                        .foregroundStyle(step.rawValue <= currentStep.rawValue ? Color.accentColor : Color.secondary)
                        .font(.title3)
                    Text(step.title)
                        .font(.body.weight(step == currentStep ? .semibold : .regular))
                        .foregroundStyle(step.rawValue <= currentStep.rawValue ? .primary : .secondary)
                }
                .frame(minHeight: 44)
                .accessibilityLabel("\(step.title), step \(index + 1) of \(steps.count)")
                .accessibilityAddTraits(step == currentStep ? .isSelected : [])
            }

            Spacer()
        }
        .padding(24)
        .background(Color(uiColor: .secondarySystemBackground))
    }
}

private struct CreateDocumentStatusBanner: View {
    let message: String

    var body: some View {
        Label(message, systemImage: "exclamationmark.circle.fill")
            .font(.footnote)
            .foregroundStyle(.red)
            .accessibilityLabel("Error: \(message)")
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(uiColor: .secondarySystemBackground))
    }
}

extension CreateDocumentStep {
    var title: String {
        switch self {
        case .choose: "Get Started"
        case .details: "Details"
        case .fields: "Template Fields"
        case .review: "Review"
        }
    }
}

extension CreateDocumentOperation {
    var label: String {
        switch self {
        case .idle: "Ready"
        case .preparing: "Creating document…"
        case let .uploading(value): "Uploading… \(Int(value * 100))%"
        case .processing: "Preparing document pages…"
        case .openingEditor: "Opening editor…"
        case .failed: "Creation failed"
        }
    }
}
