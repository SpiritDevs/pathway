import Foundation
import Observation

@MainActor
@Observable
final class DocumentInformationSheetModel {
    enum LoadState: Equatable {
        case loading
        case loaded
        case failed(String)
    }

    enum Tab: String, CaseIterable, Identifiable {
        case general
        case history
        case versions
        case recipients

        var id: String { rawValue }

        var title: String {
            switch self {
            case .general: "General"
            case .history: "History"
            case .versions: "Versions"
            case .recipients: "Recipients"
            }
        }

        var systemImage: String {
            switch self {
            case .general: "doc.text"
            case .history: "clock.arrow.circlepath"
            case .versions: "doc.on.doc"
            case .recipients: "person.2"
            }
        }
    }

    private let documentID: String
    private let service: any DocumentServicing
    @ObservationIgnored private var statusMutationTail: Task<Void, Never>?
    @ObservationIgnored private var statusMutationGeneration = 0
    @ObservationIgnored private var confirmedStatus: String?
    @ObservationIgnored private var confirmedExpiry: Double?

    var loadState: LoadState = .loading
    var information: DocumentInformation?
    var selectedTab: Tab = .general
    var history: [DocumentHistoryEvent]?
    var versions: [DocumentVersion]?
    var recipients: [DocumentRecipient]?
    var loadingTabs: Set<Tab> = []
    var tabErrors: [Tab: String] = [:]
    var savingFields: Set<String> = []
    var actionError: String?

    init(documentID: String, service: any DocumentServicing) {
        self.documentID = documentID
        self.service = service
    }

    func load() async {
        loadState = .loading
        do {
            let loadedInformation = try await service.information(documentID: documentID)
            information = loadedInformation
            confirmedStatus = loadedInformation.status
            confirmedExpiry = loadedInformation.expiredAt
            loadState = .loaded
        } catch is CancellationError {
            return
        } catch {
            loadState = .failed(error.localizedDescription)
        }
    }

    func select(_ tab: Tab) async {
        selectedTab = tab
        await loadTabIfNeeded(tab)
    }

    func retry(_ tab: Tab) async {
        tabErrors[tab] = nil
        switch tab {
        case .general:
            await load()
        case .history:
            history = nil
            await loadTabIfNeeded(tab)
        case .versions:
            versions = nil
            await loadTabIfNeeded(tab)
        case .recipients:
            recipients = nil
            await loadTabIfNeeded(tab)
        }
    }

    func saveTitle(_ title: String) async {
        guard var current = information else { return }
        let value = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty, value != current.title else { return }
        let previous = current.title
        current.title = value
        information = current
        await performSave(field: "title", rollback: { [weak self] in
            self?.information?.title = previous
        }) {
            try await self.service.updateInformation(
                documentID: self.documentID,
                title: value,
                subtitle: nil,
                renewalAt: nil
            )
        }
    }

    func saveSubtitle(_ subtitle: String) async {
        guard var current = information else { return }
        let trimmed = subtitle.trimmingCharacters(in: .whitespacesAndNewlines)
        let value: String? = trimmed.isEmpty ? nil : trimmed
        guard value != current.subtitle else { return }
        let previous = current.subtitle
        current.subtitle = value
        information = current
        await performSave(field: "subtitle", rollback: { [weak self] in
            self?.information?.subtitle = previous
        }) {
            // The service omits nil values, so use an empty string to clear the subtitle.
            try await self.service.updateInformation(
                documentID: self.documentID,
                title: nil,
                subtitle: value ?? "",
                renewalAt: nil
            )
        }
    }

    func saveStatus(_ status: String) async {
        guard var current = information, status != current.status else { return }
        current.status = status
        information = current
        await queueStatusSave()
    }

    func saveExpiry(_ date: Date?) async {
        guard var current = information else { return }
        let value = date.map(Self.milliseconds)
        guard value != current.expiredAt else { return }
        current.expiredAt = value
        information = current
        await queueStatusSave()
    }

    func saveRenewal(_ date: Date?) async {
        guard var current = information else { return }
        let value = date.map(Self.milliseconds)
        guard value != current.renewalAt else { return }
        let previous = current.renewalAt
        current.renewalAt = value
        information = current
        await performSave(field: "renewal", rollback: { [weak self] in
            self?.information?.renewalAt = previous
        }) {
            try await self.service.updateInformation(
                documentID: self.documentID,
                title: nil,
                subtitle: nil,
                renewalAt: .some(value)
            )
        }
    }

    func transferOwner(to user: MobileDashboardBootstrap.CompanyUser) async {
        guard var current = information, user.id != current.ownerUserId else { return }
        let previousID = current.ownerUserId
        let previousName = current.ownerName
        current.ownerUserId = user.id
        current.ownerName = user.displayName
        information = current
        await performSave(field: "owner", rollback: { [weak self] in
            self?.information?.ownerUserId = previousID
            self?.information?.ownerName = previousName
        }) {
            try await self.service.transfer(documentID: self.documentID, ownerUserID: user.id)
        }
    }

    func addRecipient(_ draft: DocumentRecipientDraft) async throws {
        try await service.addRecipient(documentID: documentID, draft: draft)
        await reloadRecipients()
    }

    func updateRecipient(_ recipientID: String, draft: DocumentRecipientDraft) async throws {
        try await service.updateRecipient(
            documentID: documentID,
            recipientID: recipientID,
            draft: draft
        )
        await reloadRecipients()
    }

    func removeRecipient(_ recipientID: String) async throws {
        try await service.removeRecipient(documentID: documentID, recipientID: recipientID)
        await reloadRecipients()
    }

    func moveRecipients(from offsets: IndexSet, to destination: Int) async {
        guard var reordered = recipients else { return }
        let previous = reordered
        reordered.move(fromOffsets: offsets, toOffset: destination)
        recipients = reordered
        do {
            try await service.reorderRecipients(
                documentID: documentID,
                recipientIDs: reordered.map(\.id)
            )
        } catch {
            recipients = previous
            actionError = error.localizedDescription
        }
    }

    func copyVersion(_ version: DocumentVersion) async -> CreatedDocument? {
        do {
            return try await service.copyVersion(documentID: version.id)
        } catch {
            actionError = error.localizedDescription
            return nil
        }
    }

    func searchContacts(_ query: String) async throws -> [CreateDocumentContact] {
        try await service.searchContacts(query: query)
    }

    private func loadTabIfNeeded(_ tab: Tab) async {
        guard tab != .general, !loadingTabs.contains(tab), tabErrors[tab] == nil else { return }
        switch tab {
        case .general:
            return
        case .history where history != nil:
            return
        case .versions where versions != nil:
            return
        case .recipients where recipients != nil:
            return
        default:
            break
        }

        loadingTabs.insert(tab)
        defer { loadingTabs.remove(tab) }
        do {
            switch tab {
            case .general:
                break
            case .history:
                history = try await service.history(documentID: documentID).history
            case .versions:
                versions = try await service.versions(documentID: documentID).versions
            case .recipients:
                recipients = try await service.recipients(documentID: documentID).recipients
            }
        } catch is CancellationError {
            return
        } catch {
            tabErrors[tab] = error.localizedDescription
        }
    }

    private func reloadRecipients() async {
        recipients = nil
        tabErrors[.recipients] = nil
        await loadTabIfNeeded(.recipients)
    }

    private func performSave(
        field: String,
        rollback: @escaping @MainActor () -> Void,
        operation: @escaping @MainActor () async throws -> Void
    ) async {
        savingFields.insert(field)
        defer { savingFields.remove(field) }
        do {
            try await operation()
        } catch {
            rollback()
            actionError = error.localizedDescription
        }
    }

    /// Status and expiry share one backend mutation. Queue snapshots so rapid edits cannot
    /// complete out of order and overwrite a newer value with an older captured pair.
    private func queueStatusSave() async {
        guard let information else { return }
        let desiredStatus = information.status
        let desiredExpiry = information.expiredAt
        let precedingMutation = statusMutationTail
        statusMutationGeneration += 1
        let generation = statusMutationGeneration
        savingFields.formUnion(["status", "expiry"])

        let mutation = Task { @MainActor [weak self] in
            await precedingMutation?.value
            guard let self else { return }
            do {
                try await self.service.updateStatus(
                    documentID: self.documentID,
                    status: desiredStatus,
                    expiredAt: .some(desiredExpiry)
                )
                self.confirmedStatus = desiredStatus
                self.confirmedExpiry = desiredExpiry
            } catch {
                guard generation == self.statusMutationGeneration else { return }
                self.information?.status = self.confirmedStatus ?? self.information?.status ?? desiredStatus
                self.information?.expiredAt = self.confirmedExpiry
                self.actionError = error.localizedDescription
            }

            guard generation == self.statusMutationGeneration else { return }
            self.savingFields.remove("status")
            self.savingFields.remove("expiry")
            self.statusMutationTail = nil
        }
        statusMutationTail = mutation
        await mutation.value
    }

    static func milliseconds(_ date: Date) -> Double {
        date.timeIntervalSince1970 * 1_000
    }

    static func date(_ milliseconds: Double?) -> Date? {
        milliseconds.map { Date(timeIntervalSince1970: $0 / 1_000) }
    }
}
