import Foundation
import Observation
import SwiftUI
import UIKit
import UniformTypeIdentifiers

@MainActor final class ShareViewController: UIViewController {
    private let model = PathwayShareModel()
    private var loadTask: Task<Void, Never>?
    override func viewDidLoad() {
        super.viewDidLoad()
        let controller = UIHostingController(rootView: PathwayShareView(model: model, cancel: { [weak self] in
            self?.loadTask?.cancel()
            self?.extensionContext?.cancelRequest(withError: CancellationError())
        }, save: { [weak self] in
            guard let self else { return }
            Task {
                if await self.model.save() { self.extensionContext?.completeRequest(returningItems: nil) }
            }
        }))
        addChild(controller)
        controller.view.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(controller.view)
        NSLayoutConstraint.activate([
            controller.view.leadingAnchor.constraint(equalTo: view.leadingAnchor), controller.view.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            controller.view.topAnchor.constraint(equalTo: view.topAnchor), controller.view.bottomAnchor.constraint(equalTo: view.bottomAnchor)
        ])
        controller.didMove(toParent: self)
        let items = (extensionContext?.inputItems as? [NSExtensionItem]) ?? []
        loadTask = Task { await model.load(items) }
    }
}

@MainActor @Observable private final class PathwayShareModel {
    var prompt = ""
    private(set) var files: [PathwayCaptureFile] = []
    private(set) var loading = true
    private var loadFailed = false
    private(set) var saving = false
    private(set) var errorMessage: String?
    private let store = PathwayCaptureStore.shared()
    private var accountKey: String?
    private let temporaryDirectory = FileManager.default.temporaryDirectory.appending(path: "PathwayShare-\(UUID().uuidString)")

    var canSave: Bool { !loading && !saving && accountKey != nil && !loadFailed && (!prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !files.isEmpty) && prompt.count <= 120_000 }

    func load(_ items: [NSExtensionItem]) async {
        defer { loading = false }
        do {
            guard let store else { throw PathwayCaptureError.unavailable }
            accountKey = try await store.activeAccount()
            try FileManager.default.createDirectory(at: temporaryDirectory, withIntermediateDirectories: true)
            var text: [String] = []
            let providers = items.flatMap { $0.attachments ?? [] }
            guard providers.count <= 16 else { throw PathwayCaptureError.invalidInput }
            for provider in providers {
                try Task.checkCancellation()
                if provider.hasItemConformingToTypeIdentifier(UTType.url.identifier), !provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) {
                    let data = try await loadData(provider, type: UTType.url.identifier)
                    if let url = URL(dataRepresentation: data, relativeTo: nil) { text.append(url.absoluteString) }
                    else if let value = String(data: data, encoding: .utf8) { text.append(value) }
                } else if provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier), !provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) {
                    let data = try await loadData(provider, type: UTType.plainText.identifier)
                    guard data.count <= 480_000, let value = String(data: data, encoding: .utf8) else { throw PathwayCaptureError.invalidInput }
                    text.append(value)
                } else {
                    guard files.count < 8,
                          let identifier = provider.registeredTypeIdentifiers.first(where: { UTType($0)?.conforms(to: .data) == true && $0 != UTType.fileURL.identifier }) ?? provider.registeredTypeIdentifiers.first else { throw PathwayCaptureError.invalidInput }
                    let target = temporaryDirectory.appending(path: UUID().uuidString)
                    let type = UTType(identifier)
                    let result = try await loadFile(provider, type: identifier, target: target)
                    let name = provider.suggestedName ?? result
                    files.append(.init(url: target, name: name, mimeType: type?.preferredMIMEType ?? UTType(filenameExtension: URL(fileURLWithPath: name).pathExtension)?.preferredMIMEType ?? "application/octet-stream"))
                }
            }
            if providers.isEmpty { text = items.compactMap { $0.attributedContentText?.string } }
            prompt = text.joined(separator: "\n\n")
            guard prompt.count <= 120_000 else { throw PathwayCaptureError.invalidInput }
        } catch is CancellationError { cleanup() }
        catch { loadFailed = true; errorMessage = error.localizedDescription }
    }

    func save() async -> Bool {
        guard canSave, let store, let accountKey else { return false }
        saving = true
        defer { saving = false }
        do {
            _ = try await store.save(prompt: prompt, files: files, accountKey: accountKey)
            cleanup()
            return true
        } catch { errorMessage = error.localizedDescription; return false }
    }

    func removeFiles(at indices: IndexSet) {
        for index in indices.sorted(by: >) where files.indices.contains(index) {
            try? FileManager.default.removeItem(at: files[index].url)
            files.remove(at: index)
        }
        errorMessage = nil
    }

    func cleanup() { try? FileManager.default.removeItem(at: temporaryDirectory) }

    private func loadData(_ provider: NSItemProvider, type: String) async throws -> Data {
        let transfer = PathwayShareTransfer<Data>()
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                transfer.begin(continuation)
                let progress = provider.loadDataRepresentation(forTypeIdentifier: type) { data, error in
                    transfer.finish(data.map(Result.success) ?? .failure(error ?? PathwayCaptureError.missingFile))
                }
                transfer.setProgress(progress)
            }
        } onCancel: { transfer.finish(.failure(CancellationError())) }
    }

    private func loadFile(_ provider: NSItemProvider, type: String, target: URL) async throws -> String {
        let transfer = PathwayShareTransfer<String>()
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                transfer.begin(continuation)
                let progress = provider.loadFileRepresentation(forTypeIdentifier: type) { url, error in
                    guard let url else { transfer.finish(.failure(error ?? PathwayCaptureError.missingFile)); return }
                    do {
                        let size = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
                        guard size > 0, size <= 50 * 1024 * 1024 else { throw PathwayCaptureError.invalidInput }
                        // The provider deletes its temporary URL as soon as this callback returns.
                        try FileManager.default.copyItem(at: url, to: target)
                        transfer.finish(.success(url.lastPathComponent))
                    } catch { transfer.finish(.failure(error)) }
                }
                transfer.setProgress(progress)
            }
        } onCancel: { transfer.finish(.failure(CancellationError())) }
    }
}

// NSItemProvider callbacks can outlive cancellation. Resolve each continuation once and cancel its transfer.
private final class PathwayShareTransfer<Value: Sendable>: @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: CheckedContinuation<Value, any Error>?
    private var result: Result<Value, any Error>?
    private var progress: Progress?
    private var timeout: DispatchWorkItem?
    func begin(_ continuation: CheckedContinuation<Value, any Error>) {
        lock.lock()
        if let result { lock.unlock(); continuation.resume(with: result); return }
        self.continuation = continuation
        let deadline = DispatchWorkItem { [weak self] in self?.finish(.failure(URLError(.timedOut))) }
        timeout = deadline
        lock.unlock()
        DispatchQueue.global().asyncAfter(deadline: .now() + 30, execute: deadline)
    }
    func setProgress(_ progress: Progress) {
        lock.lock(); self.progress = progress; let finished = result != nil; lock.unlock()
        if finished { progress.cancel() }
    }
    func finish(_ value: Result<Value, any Error>) {
        lock.lock()
        guard result == nil else { lock.unlock(); return }
        result = value
        let continuation = continuation; self.continuation = nil
        let progress = progress; self.progress = nil
        let timeout = timeout; self.timeout = nil
        lock.unlock()
        timeout?.cancel(); progress?.cancel(); continuation?.resume(with: value)
    }
}

private struct PathwayShareView: View {
    @Bindable var model: PathwayShareModel
    let cancel: () -> Void
    let save: () -> Void
    var body: some View {
        NavigationStack {
            Form {
                Section("Prompt") { TextEditor(text: $model.prompt).frame(minHeight: 120) }
                if !model.files.isEmpty {
                    Section("Attachments") {
                        ForEach(Array(model.files.enumerated()), id: \.offset) { _, file in Label(file.name, systemImage: "doc") }
                            .onDelete(perform: model.removeFiles)
                    }
                }
                Section {
                    Text("Saved drafts stay in the signed-in Pathway account. Open Pathway to choose a project and review before sending.").font(.footnote).foregroundStyle(.secondary)
                    if model.loading { ProgressView("Loading shared content…") }
                    if let error = model.errorMessage { Text(error).foregroundStyle(.red) }
                }
            }
            .navigationTitle("Save to Pathway")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { model.cleanup(); cancel() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button(model.saving ? "Saving…" : "Save Draft", action: save).disabled(!model.canSave)
                }
            }
        }
    }
}
