import Foundation
import Observation

@MainActor
@Observable
final class CreateDocumentFlowModel {
    let context: CreateDocumentContext

    var step: CreateDocumentStep = .choose
    var selection: CreateDocumentSelection?
    var selectedCollection: CreateDocumentTemplateCollection = .suggested
    var selectedCategoryID: String?
    var templateSearch = ""
    var title = ""
    var ownerUserID: String?
    var recipients: [CreateDocumentRecipient] = [CreateDocumentRecipient()]
    var dataItems: [CreateDocumentDataItemValue] = []

    private(set) var quickAccessData: CreateDocumentModalData?
    private(set) var categoryData: CreateDocumentModalData?
    private(set) var loadState: CreateDocumentLoadState = .idle
    private(set) var operation: CreateDocumentOperation = .idle
    private(set) var validationError: CreateDocumentValidationError?
    private(set) var createdDocument: CreatedDocument?

    @ObservationIgnored private let service: any CreateDocumentServicing
    @ObservationIgnored private let companyAssetSignature: CompanyAssetCloudFrontSignature?
    @ObservationIgnored private var pendingImportDraft: CreateDocumentActionResult?
    @ObservationIgnored private var categoryLoadTask: Task<Void, Never>?
    @ObservationIgnored private var creationTask: Task<Void, Never>?
    @ObservationIgnored private var creationTaskID: UUID?

    init(
        service: any CreateDocumentServicing,
        context: CreateDocumentContext,
        companyAssetSignature: CompanyAssetCloudFrontSignature?
    ) {
        self.service = service
        self.context = context
        self.companyAssetSignature = companyAssetSignature
    }

    var categories: [CreateDocumentTemplateCategory] {
        quickAccessData?.templateCategories ?? []
    }

    var displayedTemplates: [CreateDocumentTemplate] {
        let source: [CreateDocumentTemplate]
        switch selectedCollection {
        case .suggested:
            source = quickAccessData?.systemTemplates ?? []
        case .myTemplates:
            source = quickAccessData?.templates ?? []
        case .gallery:
            source = categoryData?.systemTemplates ?? []
        }

        let query = templateSearch.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty else { return source }
        return source.filter { template in
            template.displayName.localizedCaseInsensitiveContains(query) ||
                template.templateDescription?.localizedCaseInsensitiveContains(query) == true ||
                template.tags?.contains(where: { $0.localizedCaseInsensitiveContains(query) }) == true
        }
    }

    var requiredPrimaryRecipientCount: Int {
        guard case let .template(template) = selection else { return 0 }
        return template.primaryRecipientCount
    }

    var hasTemplateFields: Bool {
        !dataItems.isEmpty
    }

    var hasEnteredRecipients: Bool {
        recipients.contains(where: { !$0.isBlank })
    }

    var hasUnsavedChanges: Bool {
        selection != nil ||
            !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ||
            ownerUserID != nil ||
            recipients.contains(where: { !$0.isBlank }) ||
            dataItems.contains(where: { !$0.value.isEmpty })
    }

    var canCreate: Bool {
        selection != nil && !operation.isRunning
    }

    func load(forceRefresh: Bool = false) async {
        guard loadState != .loading else { return }
        loadState = .loading
        do {
            let data = try await service.loadModalData(
                companyID: context.companyID,
                request: .quickAccess,
                forceRefresh: forceRefresh
            )
            quickAccessData = data
            updateDataItems()
            loadState = .loaded
        } catch is CancellationError {
            return
        } catch {
            loadState = .failed(error.localizedDescription)
        }
    }

    func loadCategory(_ categoryID: String, forceRefresh: Bool = false) async {
        selectedCollection = .gallery
        if selectedCategoryID != categoryID {
            categoryData = nil
        }
        selectedCategoryID = categoryID
        loadState = .loading
        do {
            let data = try await service.loadModalData(
                companyID: context.companyID,
                request: .category(categoryID),
                forceRefresh: forceRefresh
            )
            guard selectedCategoryID == categoryID else { return }
            categoryData = data
            loadState = .loaded
        } catch is CancellationError {
            return
        } catch {
            guard selectedCategoryID == categoryID else { return }
            loadState = .failed(error.localizedDescription)
        }
    }

    func selectCategory(_ categoryID: String, forceRefresh: Bool = false) {
        categoryLoadTask?.cancel()
        categoryLoadTask = Task { [weak self] in
            await self?.loadCategory(categoryID, forceRefresh: forceRefresh)
        }
    }

    func selectBlank() {
        cancelCategoryLoad()
        abandonFailedCreation()
        selection = .blank
        pendingImportDraft = nil
        validationError = nil
        updateDataItems()
        ensureRequiredRecipientSlots()
    }

    func selectTemplate(_ template: CreateDocumentTemplate) {
        cancelCategoryLoad()
        abandonFailedCreation()
        selection = .template(template)
        pendingImportDraft = nil
        validationError = nil
        if title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            title = template.displayName
        }
        updateDataItems()
        ensureRequiredRecipientSlots()
    }

    func selectImport(_ importedFile: CreateDocumentImport) {
        cancelCategoryLoad()
        abandonFailedCreation()
        selection = .imported(importedFile)
        pendingImportDraft = nil
        validationError = nil
        if title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            title = (importedFile.fileName as NSString).deletingPathExtension
        }
        updateDataItems()
        ensureRequiredRecipientSlots()
    }

    func addRecipient() {
        recipients.append(CreateDocumentRecipient())
    }

    func removeRecipient(id: UUID) {
        guard let index = recipients.firstIndex(where: { $0.id == id }) else { return }
        if index < requiredPrimaryRecipientCount {
            recipients[index] = CreateDocumentRecipient()
            validationError = nil
            return
        }
        recipients.remove(at: index)
        if recipients.isEmpty {
            recipients = [CreateDocumentRecipient()]
        }
        validationError = nil
    }

    @discardableResult
    func makeRecipientPrimary(
        id: UUID,
        replacingPrimaryID: UUID? = nil
    ) -> Bool {
        let primaryCount = requiredPrimaryRecipientCount
        guard primaryCount > 0,
              let sourceIndex = recipients.firstIndex(where: { $0.id == id }),
              sourceIndex >= primaryCount else {
            return false
        }

        let targetIndex: Int?
        if let replacingPrimaryID {
            targetIndex = recipients.firstIndex(where: { $0.id == replacingPrimaryID })
        } else {
            targetIndex = recipients.prefix(primaryCount).firstIndex(where: \.isBlank)
        }

        guard let targetIndex, targetIndex < primaryCount else { return false }
        let replacesBlankSlot = recipients[targetIndex].isBlank
        recipients.swapAt(sourceIndex, targetIndex)
        if replacesBlankSlot {
            recipients.remove(at: sourceIndex)
        }
        validationError = nil
        return true
    }

    func applyContact(_ contact: CreateDocumentContact, to recipientID: UUID) {
        guard let index = recipients.firstIndex(where: { $0.id == recipientID }) else { return }
        var selected = contact.recipient
        selected = CreateDocumentRecipient(
            id: recipientID,
            contactId: selected.contactId,
            email: selected.email,
            firstName: selected.firstName,
            lastName: selected.lastName,
            phoneNumber: selected.phoneNumber,
            address: selected.address,
            companyName: selected.companyName,
            accountRef: selected.accountRef,
            saveContact: false
        )
        recipients[index] = selected
    }

    func searchContacts(
        field: CreateDocumentContactSearchField = .firstName,
        query: String
    ) async -> [CreateDocumentContact] {
        guard context.canSearchContacts else { return [] }
        do {
            if field == .email {
                return try await service.searchContacts(field: .email, query: query)
            }

            // The service is main-actor isolated; sequential first-value reads avoid
            // transferring its non-Sendable existential into child tasks under Swift 6.
            let firstNameResults = try await service.searchContacts(
                field: .firstName,
                query: query
            )
            let lastNameResults = try await service.searchContacts(
                field: .lastName,
                query: query
            )
            let emailResults = try await service.searchContacts(field: .email, query: query)
            let combined = firstNameResults + lastNameResults + emailResults
            var seen = Set<String>()
            return Array(combined.filter { seen.insert($0.id).inserted }.prefix(10))
        } catch is CancellationError {
            return []
        } catch {
            return []
        }
    }

    @discardableResult
    func goForward() -> Bool {
        validationError = nil
        switch step {
        case .choose:
            guard selection != nil else {
                validationError = .chooseSource
                return false
            }
            step = .details
        case .details:
            guard validateRecipients() else { return false }
            step = hasTemplateFields ? .fields : .review
        case .fields:
            guard validateDataItems() else { return false }
            step = .review
        case .review:
            return false
        }
        return true
    }

    func goBack() {
        abandonFailedCreation()
        validationError = nil
        switch step {
        case .choose:
            break
        case .details:
            step = .choose
        case .fields:
            step = .details
        case .review:
            step = hasTemplateFields ? .fields : .details
        }
    }

    func startCreation() {
        guard creationTask == nil, !operation.isRunning else { return }
        let taskID = UUID()
        creationTaskID = taskID
        creationTask = Task { [weak self] in
            await self?.create()
            guard self?.creationTaskID == taskID else { return }
            self?.creationTask = nil
            self?.creationTaskID = nil
        }
    }

    func cancelCreation() {
        creationTask?.cancel()
        creationTask = nil
        creationTaskID = nil
        cleanupPendingImportDraft()
        operation = .idle
    }

    private func create() async {
        guard !operation.isRunning else { return }
        guard selection != nil else {
            validationError = .chooseSource
            return
        }
        guard validateRecipients(), validateDataItems() else { return }

        let normalizedRecipients = recipients
            .map(\.normalized)
            .filter { !$0.isBlank }
        let input = CreateDocumentActionInput(
            title: normalizedTitle,
            ownerUserID: validatedOwnerUserID,
            recipients: normalizedRecipients,
            dataItems: dataItems
        )

        if context.canSaveContacts {
            let contactsToSave = normalizedRecipients.filter(\.saveContact)
            if !contactsToSave.isEmpty {
                Task { [service] in
                    _ = try? await service.saveContacts(contactsToSave)
                }
            }
        }

        operation = .preparing
        do {
            let result: CreateDocumentActionResult
            switch selection {
            case .blank:
                result = try await service.createBlank(input: input, source: "blank")
            case let .template(template):
                result = try await service.createFromTemplate(templateID: template.id, input: input)
            case let .imported(file):
                result = try await createImportedDocument(file: file, input: input)
            case .none:
                return
            }

            if Task.isCancelled {
                if let documentID = result.id {
                    await service.deleteDraft(documentID: documentID)
                }
                throw CancellationError()
            }
            try finishCreation(result)
        } catch is CancellationError {
            operation = .idle
        } catch {
            operation = .failed(error.localizedDescription)
        }
    }

    func retryCreation() {
        guard step == .review, case .failed = operation else { return }
        startCreation()
    }

    func coverURL(for template: CreateDocumentTemplate) async -> URL? {
        await service.coverURL(for: template, companySignature: companyAssetSignature)
    }

    func reset() {
        creationTask?.cancel()
        creationTask = nil
        creationTaskID = nil
        cleanupPendingImportDraft()
        cancelCategoryLoad()
        step = .choose
        selection = nil
        selectedCollection = .suggested
        selectedCategoryID = nil
        templateSearch = ""
        title = ""
        ownerUserID = nil
        recipients = [CreateDocumentRecipient()]
        dataItems = []
        categoryData = nil
        operation = .idle
        validationError = nil
        createdDocument = nil
    }

    private func cancelCategoryLoad() {
        categoryLoadTask?.cancel()
        categoryLoadTask = nil
    }

    private var normalizedTitle: String {
        let value = title.trimmingCharacters(in: .whitespacesAndNewlines)
        return value.isEmpty ? "Untitled Document" : value
    }

    private func abandonFailedCreation() {
        guard case .failed = operation else { return }
        cleanupPendingImportDraft()
        operation = .idle
    }

    private func cleanupPendingImportDraft() {
        guard let documentID = pendingImportDraft?.id else {
            pendingImportDraft = nil
            return
        }
        pendingImportDraft = nil
        Task { [service] in
            await service.deleteDraft(documentID: documentID)
        }
    }

    private var validatedOwnerUserID: String? {
        guard
            context.canAssignOwner,
            let ownerUserID,
            context.assignableUsers.contains(where: { $0.id == ownerUserID })
        else {
            return nil
        }
        return ownerUserID
    }

    private func updateDataItems() {
        guard let modalData = quickAccessData else {
            dataItems = []
            return
        }
        let selectedTemplateID: String?
        if case let .template(template) = selection {
            selectedTemplateID = template.id
        } else {
            selectedTemplateID = nil
        }
        dataItems = modalData.templateDataItems
            .filter { item in
                item.connectionLinkId == nil || item.connectionLinkId == selectedTemplateID
            }
            .map { item in
                CreateDocumentDataItemValue(
                    item: item,
                    value: defaultValue(for: item.defaultValue)
                )
            }
    }

    private func defaultValue(for value: String?) -> String {
        guard let value, !value.isEmpty else { return "" }
        let dayOffset: Int?
        if value == "currentDate" {
            dayOffset = 0
        } else if value.hasPrefix("days:") {
            dayOffset = Int(value.dropFirst("days:".count)) ?? 0
        } else {
            dayOffset = nil
        }
        guard let dayOffset else { return value }
        let calendar = Calendar(identifier: .gregorian)
        let date = calendar.date(byAdding: .day, value: dayOffset, to: .now) ?? .now
        return ISO8601DateFormatter().string(from: date)
    }

    private func ensureRequiredRecipientSlots() {
        let minimum = context.requireDocumentRecipient
            ? max(1, requiredPrimaryRecipientCount)
            : 1
        while recipients.count < minimum {
            recipients.append(CreateDocumentRecipient())
        }
    }

    private func validateRecipients() -> Bool {
        let normalized = recipients.map(\.normalized)
        let nonBlank = normalized.filter { !$0.isBlank }
        if context.requireDocumentRecipient && nonBlank.isEmpty {
            validationError = .recipientRequired
            return false
        }
        if nonBlank.isEmpty {
            return true
        }
        if requiredPrimaryRecipientCount > 0 {
            let primary = normalized.prefix(requiredPrimaryRecipientCount)
            guard primary.count == requiredPrimaryRecipientCount,
                  primary.allSatisfy(isValidRecipient) else {
                validationError = .invalidRecipient
                return false
            }
        }
        guard nonBlank.allSatisfy(isValidRecipient) else {
            validationError = .invalidRecipient
            return false
        }
        return true
    }

    private func isValidRecipient(_ recipient: CreateDocumentRecipient) -> Bool {
        !recipient.firstName.isEmpty && isValidEmail(recipient.email)
    }

    private func validateDataItems() -> Bool {
        if let missing = dataItems.first(where: {
            $0.item.mandatory &&
                $0.value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        }) {
            validationError = .requiredDataItem(missing.item.label)
            return false
        }
        return true
    }

    private func createImportedDocument(
        file: CreateDocumentImport,
        input: CreateDocumentActionInput
    ) async throws -> CreateDocumentActionResult {
        let draft: CreateDocumentActionResult
        if let pendingImportDraft {
            draft = pendingImportDraft
        } else {
            draft = try await service.createBlank(input: input, source: "import")
            guard draft.success, draft.id != nil else {
                throw CreateDocumentServiceError.invalidResponse(
                    draft.message ?? "Pathway could not create this document."
                )
            }
            pendingImportDraft = draft
        }
        try Task.checkCancellation()
        guard let documentID = draft.id else {
            throw CreateDocumentServiceError.invalidResponse("The document identifier is missing.")
        }

        let upload = try await service.prepareUpload(documentID: documentID, file: file)
        try Task.checkCancellation()
        guard let destination = URL(string: upload.url) else {
            throw CreateDocumentServiceError.invalidUploadURL
        }
        operation = .uploading(0)
        try await service.upload(file: file, to: destination) { [weak self] value in
            Task { @MainActor in
                self?.operation = .uploading(value)
            }
        }
        try Task.checkCancellation()
        operation = .processing
        let result = try await service.replaceWithUploadedFile(
            documentID: documentID,
            file: file,
            assetID: upload.assetID,
            title: input.title
        )
        if result.success {
            pendingImportDraft = nil
        }
        return result
    }

    private func finishCreation(_ result: CreateDocumentActionResult) throws {
        guard result.success, let id = result.id else {
            throw CreateDocumentServiceError.invalidResponse(
                result.message ?? "Pathway could not create this document."
            )
        }
        operation = .openingEditor
        createdDocument = CreatedDocument(
            id: id,
            editToken: result.editToken,
            viewToken: result.viewToken
        )
    }
}
