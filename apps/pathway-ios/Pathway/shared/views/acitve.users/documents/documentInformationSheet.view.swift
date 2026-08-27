import SafariServices
import SwiftUI

@MainActor
struct DocumentInformationSheet: View {
    private enum DocumentActionRole: Equatable {
        case primary
        case secondary
    }

    @Environment(\.dismiss) private var dismiss

    private let document: DashboardDocument
    private let bootstrap: MobileDashboardBootstrap?
    @State private var model: DocumentInformationSheetModel
    @State private var browserDestination: DocumentBrowserDestination?
    @State private var editorDocument: CreatedDocument?
    @State private var secondaryDestination: DocumentInteractionDestination?

    init(
        document: DashboardDocument,
        service: any DocumentServicing,
        bootstrap: MobileDashboardBootstrap?
    ) {
        self.document = document
        self.bootstrap = bootstrap
        _model = State(
            initialValue: DocumentInformationSheetModel(
                documentID: document.id,
                service: service
            )
        )
    }

    var body: some View {
        NavigationStack {
            Group {
                switch model.loadState {
                case .loading:
                    ProgressView("Loading document…")
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                case let .failed(message):
                    ContentUnavailableView {
                        Label("Document Unavailable", systemImage: "exclamationmark.triangle")
                    } description: {
                        Text(message)
                    } actions: {
                        Button("Try Again") {
                            Task { await model.load() }
                        }
                        .buttonStyle(.borderedProminent)
                    }
                case .loaded:
                    loadedContent
                }
            }
            .navigationTitle("Document Information")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    if !model.savingFields.isEmpty {
                        ProgressView()
                            .accessibilityLabel("Saving document")
                    }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                        .disabled(!model.savingFields.isEmpty)
                }
            }
        }
        .interactiveDismissDisabled(!model.savingFields.isEmpty)
        .task { await model.load() }
        .alert(
            "Couldn’t Save Changes",
            isPresented: Binding(
                get: { model.actionError != nil },
                set: { if !$0 { model.actionError = nil } }
            )
        ) {
            Button("OK", role: .cancel) { model.actionError = nil }
        } message: {
            Text(model.actionError ?? "Pathway could not complete this action.")
        }
        .sheet(item: $browserDestination) { destination in
            DocumentSafariView(url: destination.url)
                .ignoresSafeArea()
        }
        .fullScreenCover(item: $secondaryDestination) { destination in
            DocumentSecondaryDestinationView(destination: destination)
        }
        .fullScreenCover(item: $editorDocument) { createdDocument in
            NativeDocumentEditorView(document: createdDocument) {
                editorDocument = nil
            }
        }
    }

    private var loadedContent: some View {
        VStack(spacing: 0) {
            documentHeader

            Picker(
                "Information section",
                selection: Binding(
                    get: { model.selectedTab },
                    set: { model.selectedTab = $0 }
                )
            ) {
                ForEach(DocumentInformationSheetModel.Tab.allCases) { tab in
                    Text(tab.title).tag(tab)
                }
            }
            .pickerStyle(.segmented)
            .padding(.horizontal, 16)
            .padding(.bottom, 10)

            Divider()

            tabContent
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .safeAreaInset(edge: .bottom) {
            if model.information != nil {
                documentActions
            }
        }
        .task(id: model.selectedTab) {
            await model.select(model.selectedTab)
        }
    }

    @ViewBuilder
    private var tabContent: some View {
        if let message = model.tabErrors[model.selectedTab] {
            ContentUnavailableView {
                Label("Couldn’t Load \(model.selectedTab.title)", systemImage: "wifi.exclamationmark")
            } description: {
                Text(message)
            } actions: {
                Button("Try Again") {
                    Task { await model.retry(model.selectedTab) }
                }
                .buttonStyle(.borderedProminent)
            }
        } else if model.loadingTabs.contains(model.selectedTab) {
            ProgressView("Loading \(model.selectedTab.title.lowercased())…")
        } else if let information = model.information {
            switch model.selectedTab {
            case .general:
                DocumentInformationGeneralTab(
                    information: information,
                    bootstrap: bootstrap,
                    savingFields: model.savingFields,
                    saveTitle: { await model.saveTitle($0) },
                    saveSubtitle: { await model.saveSubtitle($0) },
                    saveStatus: { await model.saveStatus($0) },
                    saveOwner: { await model.transferOwner(to: $0) },
                    saveExpiry: { await model.saveExpiry($0) },
                    saveRenewal: { await model.saveRenewal($0) }
                )
            case .history:
                DocumentInformationHistoryTab(events: model.history ?? [])
            case .versions:
                DocumentInformationVersionsTab(
                    versions: model.versions ?? [],
                    preview: previewVersion,
                    copy: copyVersion
                )
            case .recipients:
                DocumentInformationRecipientsTab(
                    recipients: model.recipients ?? [],
                    canManage: canManageRecipients(information),
                    canSearchPathwayContacts: bootstrap?.createDocumentContext.canSearchContacts ?? false,
                    searchPathwayContacts: model.searchContacts,
                    add: model.addRecipient,
                    update: model.updateRecipient,
                    remove: model.removeRecipient,
                    move: { from, to in await model.moveRecipients(from: from, to: to) }
                )
            }
        }
    }

    private var documentHeader: some View {
        HStack(spacing: 12) {
            Image(systemName: "doc.text.fill")
                .font(.title3)
                .foregroundStyle(.blue)
                .frame(width: 42, height: 42)
                .background(.blue.opacity(0.12), in: RoundedRectangle(cornerRadius: 11))
                .accessibilityHidden(true)

            VStack(alignment: .leading, spacing: 2) {
                Text(model.information?.title ?? document.title)
                    .font(.headline)
                    .lineLimit(1)
                Text(documentIdentifier)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }

            Spacer()

            if let status = model.information?.status {
                Text(status.formattedDocumentStatus)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 6)
                    .background(.quaternary, in: Capsule())
            }
        }
        .padding(16)
    }

    private var documentActions: some View {
        HStack(alignment: .top, spacing: 0) {
            documentActionButton(
                "Share",
                systemImage: "square.and.arrow.up",
                role: .secondary,
                isEnabled: actionCapabilities?.canShare == true
            ) {
                secondaryDestination = .share(document)
            }
            .accessibilityIdentifier("document-information-share")

            documentActionButton(
                "Send",
                systemImage: "paperplane.fill",
                role: .primary,
                isEnabled: actionCapabilities?.canSend == true
            ) {
                secondaryDestination = .send(document)
            }
            .accessibilityIdentifier("document-information-send")

            documentActionButton(
                "Preview",
                systemImage: "eye",
                role: .secondary,
                isEnabled: true,
                action: previewDocument
            )

            documentActionButton(
                "Edit",
                systemImage: "square.and.pencil",
                role: .secondary,
                isEnabled: model.information?.canEdit == true && model.information?.editToken != nil,
                action: editDocument
            )
        }
        .padding(.horizontal, 12)
        .padding(.top, 10)
        .background(.bar)
        .overlay(alignment: .top) { Divider() }
    }

    private func documentActionButton(
        _ title: String,
        systemImage: String,
        role: DocumentActionRole,
        isEnabled: Bool,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            VStack(spacing: 6) {
                Image(systemName: systemImage)
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundStyle(role == .primary ? Color.white : Color.accentColor)
                    .frame(width: 46, height: 46)
                    .background(
                        role == .primary ? Color.accentColor : Color.secondary.opacity(0.12),
                        in: Circle()
                    )
                    .accessibilityHidden(true)

                Text(title)
                    .font(.caption.weight(role == .primary ? .semibold : .regular))
                    .foregroundStyle(.primary)
                    .lineLimit(2)
                    .multilineTextAlignment(.center)
                    .minimumScaleFactor(0.8)
            }
            .frame(maxWidth: .infinity)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!isEnabled)
        .opacity(isEnabled ? 1 : 0.4)
        .accessibilityLabel(title)
    }

    private var actionCapabilities: DocumentActionCapabilities? {
        guard let information = model.information, let bootstrap else { return nil }
        return DocumentActionCapabilities(information: information, bootstrap: bootstrap)
    }

    private var documentIdentifier: String {
        guard let displayID = model.information?.displayId else { return "Document" }
        return "#\(displayID)"
    }

    private func canManageRecipients(_ information: DocumentInformation) -> Bool {
        guard let bootstrap else { return false }
        return DocumentActionCapabilities(
            information: information,
            bootstrap: bootstrap
        ).canManageRecipients
    }

    private func previewDocument() {
        guard let token = model.information?.viewToken else { return }
        browserDestination = DocumentBrowserDestination(
            url: viewerURL(token: token, dashboardPreview: true)
        )
    }

    private func previewVersion(_ version: DocumentVersion) {
        browserDestination = DocumentBrowserDestination(
            url: viewerURL(token: version.viewToken, dashboardPreview: true)
        )
    }

    private func copyVersion(_ version: DocumentVersion) {
        Task {
            if let copiedDocument = await model.copyVersion(version) {
                editorDocument = copiedDocument
            }
        }
    }

    private func editDocument() {
        guard let information = model.information, information.canEdit else { return }
        editorDocument = CreatedDocument(
            id: information.id,
            editToken: information.editToken,
            viewToken: information.viewToken
        )
    }

    private func viewerURL(token: String, dashboardPreview: Bool) -> URL {
        let url = AppConfiguration.pathwaySiteURL
            .appending(path: "viewer")
            .appending(path: token)
        guard dashboardPreview else { return url }
        return url.appending(queryItems: [URLQueryItem(name: "dashboardPreview", value: "true")])
    }
}

private struct DocumentBrowserDestination: Identifiable {
    let id = UUID()
    let url: URL
}

private struct DocumentSafariView: UIViewControllerRepresentable {
    let url: URL

    func makeUIViewController(context: Context) -> SFSafariViewController {
        SFSafariViewController(url: url)
    }

    func updateUIViewController(_ controller: SFSafariViewController, context: Context) {}
}

extension String {
    var formattedDocumentStatus: String {
        replacingOccurrences(of: "_", with: " ")
            .split(separator: " ")
            .map { $0.capitalized }
            .joined(separator: " ")
    }
}
