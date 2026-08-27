import SwiftUI

enum DocumentInteractionDestination: Identifiable {
    case information(DashboardDocument)
    case share(DashboardDocument)
    case transfer(DashboardDocument)
    case send(DashboardDocument)

    var id: String {
        switch self {
        case .information(let document): "information-\(document.id)"
        case .share(let document): "share-\(document.id)"
        case .transfer(let document): "transfer-\(document.id)"
        case .send(let document): "send-\(document.id)"
        }
    }

    var document: DashboardDocument {
        switch self {
        case .information(let document),
             .share(let document),
             .transfer(let document),
             .send(let document):
            document
        }
    }
}

struct DocumentInteractiveList: View {
    @Environment(PathwayAppModel.self) private var appModel

    let documents: [DashboardDocument]

    @State private var presentedDestination: DocumentInteractionDestination?
    @State private var archivedDocument: ArchivedDocumentUndo?
    @State private var undoExpirationTask: Task<Void, Never>?
    @State private var presentedError: DocumentInteractionError?

    var body: some View {
        List(documents) { document in
            InteractiveDocumentRow(
                document: document,
                open: { presentedDestination = $0 },
                didArchive: showUndo,
                reportError: showError
            )
            .listRowInsets(.init(top: 6, leading: 16, bottom: 6, trailing: 16))
        }
        .listStyle(.plain)
        .environment(\.defaultMinListRowHeight, 1)
        .refreshable {
            // Convex subscriptions remain live; yielding lets pending updates render.
            await Task.yield()
        }
        .overlay(alignment: .bottom) {
            if let archivedDocument {
                DocumentArchiveUndoBanner(
                    document: archivedDocument.document,
                    undo: restoreArchivedDocument
                )
                .padding(.horizontal, 16)
                .padding(.bottom, 12)
                .transition(.move(edge: .bottom).combined(with: .opacity))
            }
        }
        .animation(.snappy, value: archivedDocument?.id)
        .sheet(item: $presentedDestination) { destination in
            DocumentInteractionDestinationSheet(destination: destination)
                .presentationDetents([.large])
                .presentationDragIndicator(.visible)
        }
        .alert(item: $presentedError) { error in
            Alert(
                title: Text("Document Action Failed"),
                message: Text(error.message),
                dismissButton: .default(Text("OK"))
            )
        }
        .onDisappear {
            undoExpirationTask?.cancel()
        }
    }

    private func showUndo(_ undo: ArchivedDocumentUndo) {
        undoExpirationTask?.cancel()
        withAnimation {
            archivedDocument = undo
        }
        undoExpirationTask = Task {
            try? await Task.sleep(for: .seconds(5))
            guard !Task.isCancelled else { return }
            await MainActor.run {
                withAnimation {
                    if archivedDocument?.id == undo.id {
                        archivedDocument = nil
                    }
                }
            }
        }
    }

    private func restoreArchivedDocument() {
        guard let undo = archivedDocument else { return }
        undoExpirationTask?.cancel()
        withAnimation {
            archivedDocument = nil
        }
        Task {
            do {
                try await appModel.restoreArchivedDocument(undo)
            } catch {
                showError(error)
            }
        }
    }

    private func showError(_ error: Error) {
        presentedError = DocumentInteractionError(message: error.localizedDescription)
    }
}

private struct InteractiveDocumentRow: View {
    @Environment(PathwayAppModel.self) private var appModel

    let document: DashboardDocument
    let open: (DocumentInteractionDestination) -> Void
    let didArchive: (ArchivedDocumentUndo) -> Void
    let reportError: (Error) -> Void

    @State private var isPerformingAction = false

    private var isPinned: Bool {
        appModel.isDocumentPinned(document.id)
    }

    private var isAccountActive: Bool {
        appModel.dashboardBootstrap?.userData.isActive != false
    }

    private var isCompanyOwner: Bool {
        appModel.dashboardBootstrap?.companyData.isOwner == true
    }

    private var canDelete: Bool {
        isAccountActive &&
            (isCompanyOwner || appModel.dashboardBootstrap?.permissions?.canDeleteDocuments == true)
    }

    private var canShare: Bool {
        isAccountActive &&
            appModel.dashboardBootstrap?.userData.isEmailVerified == true &&
            (isCompanyOwner || appModel.dashboardBootstrap?.permissions?.canShareDocumentAccess == true)
    }

    private var canSend: Bool {
        isAccountActive &&
            appModel.dashboardBootstrap?.userData.isEmailVerified == true &&
            (isCompanyOwner || appModel.dashboardBootstrap?.permissions?.canSendDocuments == true)
    }

    private var canTransfer: Bool {
        !(appModel.dashboardBootstrap?.assignableCompanyUsers ?? []).isEmpty
    }

    var body: some View {
        DocumentRow(document: document)
            .contentShape(Rectangle())
            .onTapGesture {
                open(.information(document))
            }
            .swipeActions(edge: .leading, allowsFullSwipe: true) {
                Button {
                    setPinned(!isPinned)
                } label: {
                    Label(isPinned ? "Unpin" : "Pin", systemImage: isPinned ? "pin.slash" : "pin.fill")
                }
                .tint(.orange)
                .disabled(isPerformingAction || !canDelete)
                .accessibilityIdentifier("document-\(document.id)-pin-action")
            }
            .swipeActions(edge: .trailing, allowsFullSwipe: true) {
                Button(role: .destructive) {
                    archive()
                } label: {
                    Label("Move to Trash", systemImage: "trash")
                }
                .disabled(isPerformingAction)
                .accessibilityIdentifier("document-\(document.id)-trash-action")
            }
            .contextMenu {
                Button {
                    open(.share(document))
                } label: {
                    Label("Share Document", systemImage: "square.and.arrow.up")
                }
                .disabled(!canShare)

                Button {
                    open(.transfer(document))
                } label: {
                    Label("Transfer Document", systemImage: "person.crop.circle.badge.arrow.right")
                }
                .disabled(!canTransfer)

                Button {
                    open(.send(document))
                } label: {
                    Label("Send Document", systemImage: "paperplane")
                }
                .disabled(!canSend)
            }
            .accessibilityIdentifier("document-row-\(document.id)")
            .accessibilityAddTraits(.isButton)
            .accessibilityAction {
                open(.information(document))
            }
            .accessibilityAction(named: isPinned ? "Unpin document" : "Pin document") {
                setPinned(!isPinned)
            }
            .accessibilityAction(named: "Move document to Trash") {
                if canDelete { archive() }
            }
            .accessibilityAction(named: "Share document") {
                if canShare { open(.share(document)) }
            }
            .accessibilityAction(named: "Transfer document") {
                if canTransfer { open(.transfer(document)) }
            }
            .accessibilityAction(named: "Send document") {
                if canSend { open(.send(document)) }
            }
    }

    private func setPinned(_ pinned: Bool) {
        guard !isPerformingAction else { return }
        isPerformingAction = true
        Task {
            defer { isPerformingAction = false }
            do {
                try await appModel.setDocumentPinned(document, pinned: pinned)
            } catch {
                reportError(error)
            }
        }
    }

    private func archive() {
        guard !isPerformingAction else { return }
        isPerformingAction = true
        Task {
            defer { isPerformingAction = false }
            do {
                didArchive(try await appModel.archiveDocument(document))
            } catch {
                reportError(error)
            }
        }
    }
}

private struct DocumentArchiveUndoBanner: View {
    let document: DashboardDocument
    let undo: () -> Void

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: "trash")
                .accessibilityHidden(true)

            Text("\(document.title) moved to Trash")
                .font(.subheadline)
                .lineLimit(2)

            Spacer(minLength: 4)

            Button("Undo", action: undo)
                .font(.subheadline.weight(.bold))
                .foregroundStyle(.yellow)
                .accessibilityIdentifier("undo-document-archive")
        }
        .foregroundStyle(.white)
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .background(.black.opacity(0.88), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .shadow(color: .black.opacity(0.2), radius: 12, y: 5)
        .accessibilityElement(children: .contain)
    }
}

private struct DocumentInteractionError: Identifiable {
    let id = UUID()
    let message: String
}

private struct DocumentInteractionDestinationSheet: View {
    @Environment(PathwayAppModel.self) private var appModel

    let destination: DocumentInteractionDestination

    @ViewBuilder
    var body: some View {
        switch destination {
        case .information(let document):
            DocumentInformationSheet(
                document: document,
                service: appModel.documentService,
                bootstrap: appModel.dashboardBootstrap
            )
        case .share, .transfer, .send:
            DocumentSecondaryDestinationView(destination: destination)
        }
    }
}
