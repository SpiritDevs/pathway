@preconcurrency import ConvexMobile
import Foundation

@MainActor
protocol CreateDocumentServicing: AnyObject {
    func loadModalData(
        companyID: String,
        request: CreateDocumentModalRequest,
        forceRefresh: Bool
    ) async throws -> CreateDocumentModalData
    func searchContacts(
        field: CreateDocumentContactSearchField,
        query: String
    ) async throws -> [CreateDocumentContact]
    func createBlank(input: CreateDocumentActionInput, source: String) async throws
        -> CreateDocumentActionResult
    func createFromTemplate(
        templateID: String,
        input: CreateDocumentActionInput
    ) async throws -> CreateDocumentActionResult
    func prepareUpload(
        documentID: String,
        file: CreateDocumentImport
    ) async throws -> CreateDocumentPresignedUpload
    func upload(
        file: CreateDocumentImport,
        to destination: URL,
        progress: @escaping @Sendable (Double) -> Void
    ) async throws
    func replaceWithUploadedFile(
        documentID: String,
        file: CreateDocumentImport,
        assetID: String,
        title: String
    ) async throws -> CreateDocumentActionResult
    func saveContacts(_ contacts: [CreateDocumentRecipient]) async throws
        -> SaveCreateDocumentContactsResult
    func deleteDraft(documentID: String) async
    func systemAssetSignature() async -> CompanyAssetCloudFrontSignature?
    func coverURL(
        for template: CreateDocumentTemplate,
        companySignature: CompanyAssetCloudFrontSignature?
    ) async -> URL?
    func clearCache()
}

@MainActor
final class ConvexCreateDocumentService: CreateDocumentServicing {
    private struct DeleteDraftResponse: Decodable {
        let success: Bool
    }

    private struct CacheKey: Hashable {
        let companyID: String
        let request: CreateDocumentModalRequest
    }

    private struct CacheEntry {
        let value: CreateDocumentModalData
        let fetchedAt: Date
    }

    private let convex: ConvexClientWithAuth<PathwayAuthSession>
    private let cacheLifetime: TimeInterval
    private var modalCache: [CacheKey: CacheEntry] = [:]
    private var cachedSystemSignature: CompanyAssetCloudFrontSignature?
    private var cachedCompanySignature: CompanyAssetCloudFrontSignature?
    private var systemSignatureTask: Task<CompanyAssetCloudFrontSignature?, Never>?
    private var companySignatureTask: Task<CompanyAssetCloudFrontSignature?, Never>?
    private var systemSignatureTaskID: UUID?
    private var companySignatureTaskID: UUID?
    private var activeCompanyID: String?

    init(
        convex: ConvexClientWithAuth<PathwayAuthSession>,
        cacheLifetime: TimeInterval = 2 * 60
    ) {
        self.convex = convex
        self.cacheLifetime = cacheLifetime
    }

    func loadModalData(
        companyID: String,
        request: CreateDocumentModalRequest,
        forceRefresh: Bool = false
    ) async throws -> CreateDocumentModalData {
        prepareForCompany(companyID)
        let key = CacheKey(companyID: companyID, request: request)
        if
            !forceRefresh,
            let cached = modalCache[key],
            Date().timeIntervalSince(cached.fetchedAt) < cacheLifetime
        {
            return cached.value
        }

        var arguments: [String: ConvexEncodable?]
        switch request {
        case .quickAccess:
            arguments = [
                "mode": "quickAccess",
                "systemTemplateLimit": Double(20)
            ]
        case let .category(categoryID):
            arguments = [
                "mode": "full",
                "templateCategoryId": categoryID
            ]
        }

        let value: CreateDocumentModalData = try await queryOnce(
            "functions/dashboard/table:getCreateDocumentModalData",
            arguments: arguments
        )
        modalCache[key] = CacheEntry(value: value, fetchedAt: .now)
        return value
    }

    func searchContacts(
        field: CreateDocumentContactSearchField,
        query: String
    ) async throws -> [CreateDocumentContact] {
        let normalized = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard normalized.count >= 2 else { return [] }
        let result: CreateDocumentContactSearchResult = try await queryOnce(
            "functions/addressBook/contacts:searchContacts",
            arguments: [
                "field": field.rawValue,
                "search": normalized
            ]
        )
        return result.contacts
    }

    func createBlank(
        input: CreateDocumentActionInput,
        source: String
    ) async throws -> CreateDocumentActionResult {
        return try await convex.action(
            "functions/dashboard/documentAssetActions:createBlankDocument",
            with: Self.createArguments(input, source: source)
        )
    }

    func createFromTemplate(
        templateID: String,
        input: CreateDocumentActionInput
    ) async throws -> CreateDocumentActionResult {
        return try await convex.action(
            "functions/dashboard/documentAssetActions:createDocumentFromTemplate",
            with: Self.createArguments(input, source: "template", templateID: templateID)
        )
    }

    func prepareUpload(
        documentID: String,
        file: CreateDocumentImport
    ) async throws -> CreateDocumentPresignedUpload {
        let attachment: [String: ConvexEncodable?] = [
            "fileName": file.fileName,
            "type": file.kind.rawValue,
            "size": Double(file.size)
        ]
        let attachments: [ConvexEncodable?] = [attachment]
        let result: CreateDocumentPresignedUploadResult = try await convex.action(
            "functions/api/fileManagerUploads:getDocumentAttachmentPresignedUrls",
            with: [
                "documentId": documentID,
                "attachments": attachments
            ]
        )
        guard result.success, let upload = result.presignedUrls?.first else {
            throw CreateDocumentServiceError.invalidResponse(
                result.error ?? "Pathway could not prepare this upload."
            )
        }
        return upload
    }

    func upload(
        file: CreateDocumentImport,
        to destination: URL,
        progress: @escaping @Sendable (Double) -> Void
    ) async throws {
        let hasSecurityScopedAccess = file.fileURL.startAccessingSecurityScopedResource()
        defer {
            if hasSecurityScopedAccess {
                file.fileURL.stopAccessingSecurityScopedResource()
            }
        }
        var request = URLRequest(url: destination)
        request.httpMethod = "PUT"
        let delegate = CreateDocumentUploadDelegate(progress: progress)
        let session = URLSession(configuration: .ephemeral, delegate: delegate, delegateQueue: nil)
        defer { session.finishTasksAndInvalidate() }

        let task = session.uploadTask(with: request, fromFile: file.fileURL)
        delegate.setTask(task)
        try await delegate.waitForCompletion(starting: task)
    }

    func replaceWithUploadedFile(
        documentID: String,
        file: CreateDocumentImport,
        assetID: String,
        title: String
    ) async throws -> CreateDocumentActionResult {
        switch file.kind {
        case .pdf:
            return try await convex.action(
                "functions/dashboard/documentAssetActions:replaceDocumentWithUploadedPdf",
                with: [
                    "documentId": documentID,
                    "pdfAssetKey": assetID,
                    "pdfFileName": file.fileName,
                    "fileType": "pdf",
                    "title": title
                ]
            )
        case .image:
            return try await convex.action(
                "functions/dashboard/documentAssetActions:replaceDocumentWithUploadedImageBlock",
                with: [
                    "documentId": documentID,
                    "imageAssetKey": assetID,
                    "imageFileName": file.fileName,
                    "title": title
                ]
            )
        }
    }

    func saveContacts(
        _ contacts: [CreateDocumentRecipient]
    ) async throws -> SaveCreateDocumentContactsResult {
        let values: [ConvexEncodable?] = contacts.map { recipient in
            Self.contactArguments(recipient.normalized)
        }
        return try await convex.mutation(
            "functions/dashboard/documentActions:saveCreateDocumentContacts",
            with: ["contacts": values]
        )
    }

    func deleteDraft(documentID: String) async {
        let documentIDs: [ConvexEncodable?] = [documentID]
        let _: DeleteDraftResponse? = try? await convex.action(
            "functions/dashboard/documentAssetActions:deleteDocuments",
            with: ["documentIds": documentIDs]
        )
    }

    func systemAssetSignature() async -> CompanyAssetCloudFrontSignature? {
        if let cachedSystemSignature { return cachedSystemSignature }
        if let systemSignatureTask { return await systemSignatureTask.value }

        let taskID = UUID()
        let task = Task { [convex] in
            let signature: CompanyAssetCloudFrontSignature? = try? await convex.action(
                "functions/settings/companySettingsActions:getSystemTemplateAssetCloudfrontSignature"
            )
            return signature?.isUsable == true ? signature : nil
        }
        systemSignatureTaskID = taskID
        systemSignatureTask = task
        let signature = await task.value
        guard systemSignatureTaskID == taskID else { return nil }
        systemSignatureTask = nil
        systemSignatureTaskID = nil
        guard let signature, signature.isUsable else { return nil }
        cachedSystemSignature = signature
        return signature
    }

    func coverURL(
        for template: CreateDocumentTemplate,
        companySignature: CompanyAssetCloudFrontSignature?
    ) async -> URL? {
        guard template.generatedAssets?.coverpageGenerationLastTriggered == true else {
            return nil
        }
        let signature: CompanyAssetCloudFrontSignature?
        if template.isSystemTemplate {
            signature = await systemAssetSignature()
        } else if let companySignature {
            signature = companySignature
        } else {
            signature = await companyAssetSignature()
        }
        guard let signature, signature.isUsable else { return nil }

        var url = URL(string: signature.baseUrl)
        if template.isSystemTemplate {
            url?.append(path: "system-template")
        } else {
            url?.append(path: "company")
            url?.append(path: template.companyId)
        }
        if !template.isSystemTemplate {
            url?.append(path: "document")
        }
        url?.append(path: template.id)
        url?.append(path: "coverpage")
        url?.append(path: template.generatedAssets?.coverpage ?? "\(template.id).png")
        return signedURL(url, signature: signature)
    }

    func clearCache() {
        systemSignatureTask?.cancel()
        companySignatureTask?.cancel()
        modalCache.removeAll()
        cachedSystemSignature = nil
        cachedCompanySignature = nil
        systemSignatureTask = nil
        companySignatureTask = nil
        systemSignatureTaskID = nil
        companySignatureTaskID = nil
        activeCompanyID = nil
    }

    private func prepareForCompany(_ companyID: String) {
        guard let activeCompanyID else {
            self.activeCompanyID = companyID
            return
        }
        guard activeCompanyID != companyID else { return }
        clearCache()
        self.activeCompanyID = companyID
    }

    private func companyAssetSignature() async -> CompanyAssetCloudFrontSignature? {
        if let cachedCompanySignature { return cachedCompanySignature }
        if let companySignatureTask { return await companySignatureTask.value }

        let taskID = UUID()
        let task = Task { [convex] in
            let signature: CompanyAssetCloudFrontSignature? = try? await convex.action(
                "functions/settings/companySettingsActions:getCompanyAssetCloudfrontSignature"
            )
            return signature?.isUsable == true ? signature : nil
        }
        companySignatureTaskID = taskID
        companySignatureTask = task
        let signature = await task.value
        guard companySignatureTaskID == taskID else { return nil }
        companySignatureTask = nil
        companySignatureTaskID = nil
        guard let signature, signature.isUsable else { return nil }
        cachedCompanySignature = signature
        return signature
    }

    private func queryOnce<T: Decodable>(
        _ name: String,
        arguments: [String: ConvexEncodable?]? = nil
    ) async throws -> T {
        let values = convex.subscribe(to: name, with: arguments, yielding: T.self).values
        for try await value in values {
            try Task.checkCancellation()
            return value
        }
        throw CancellationError()
    }

    nonisolated private static func createArguments(
        _ input: CreateDocumentActionInput,
        source: String,
        templateID: String? = nil
    ) -> [String: ConvexEncodable?] {
        let recipients: [ConvexEncodable?] = input.recipients.map { recipient in
            recipientArguments(recipient) as ConvexEncodable
        }
        let dataItems: [ConvexEncodable?] = input.dataItems.map { dataItem in
            let value: [String: ConvexEncodable?] = [
                "dataItemId": dataItem.id,
                "value": dataItem.value
            ]
            return value as ConvexEncodable
        }
        var arguments: [String: ConvexEncodable?] = [
            "title": input.title,
            "source": source,
            "recipients": recipients,
            "dataItems": dataItems
        ]
        if let ownerUserID = input.ownerUserID {
            arguments["ownerUserId"] = ownerUserID
        }
        if let templateID {
            arguments["templateId"] = templateID
        }
        return arguments
    }

    nonisolated private static func recipientArguments(
        _ recipient: CreateDocumentRecipient
    ) -> [String: ConvexEncodable?] {
        var arguments = contactArguments(recipient.normalized)
        if let contactID = recipient.contactId {
            arguments["contactId"] = contactID
        }
        return arguments
    }

    nonisolated private static func contactArguments(
        _ recipient: CreateDocumentRecipient
    ) -> [String: ConvexEncodable?] {
        var arguments: [String: ConvexEncodable?] = [
            "email": recipient.email,
            "firstName": recipient.firstName
        ]
        add(recipient.lastName, key: "lastName", to: &arguments)
        add(recipient.phoneNumber, key: "phoneNumber", to: &arguments)
        add(recipient.address, key: "address", to: &arguments)
        add(recipient.companyName, key: "companyName", to: &arguments)
        add(recipient.accountRef, key: "accountRef", to: &arguments)
        return arguments
    }

    nonisolated private static func add(
        _ value: String,
        key: String,
        to arguments: inout [String: ConvexEncodable?]
    ) {
        guard !value.isEmpty else { return }
        arguments[key] = value
    }

    private func signedURL(
        _ url: URL?,
        signature: CompanyAssetCloudFrontSignature
    ) -> URL? {
        guard let url else { return nil }
        var components = URLComponents(url: url, resolvingAgainstBaseURL: false)
        components?.queryItems = [
            URLQueryItem(name: "Policy", value: signature.policy),
            URLQueryItem(name: "Key-Pair-Id", value: signature.keyPairId),
            URLQueryItem(name: "Signature", value: signature.signature)
        ]
        return components?.url
    }
}

private final class CreateDocumentUploadDelegate: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    private let lock = NSLock()
    private let progress: @Sendable (Double) -> Void
    private var continuation: CheckedContinuation<Void, Error>?
    private weak var task: URLSessionUploadTask?
    private var completedResult: Result<Void, Error>?

    init(progress: @escaping @Sendable (Double) -> Void) {
        self.progress = progress
    }

    func setTask(_ task: URLSessionUploadTask) {
        lock.lock()
        self.task = task
        lock.unlock()
    }

    func waitForCompletion(starting task: URLSessionUploadTask) async throws {
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                lock.lock()
                if let completedResult {
                    lock.unlock()
                    continuation.resume(with: completedResult)
                } else {
                    self.continuation = continuation
                    lock.unlock()
                    progress(0)
                    task.resume()
                }
            }
        } onCancel: {
            self.cancel()
        }
    }

    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        didSendBodyData bytesSent: Int64,
        totalBytesSent: Int64,
        totalBytesExpectedToSend: Int64
    ) {
        guard totalBytesExpectedToSend > 0 else { return }
        progress(min(1, Double(totalBytesSent) / Double(totalBytesExpectedToSend)))
    }

    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        didCompleteWithError error: Error?
    ) {
        let result: Result<Void, Error>
        if let urlError = error as? URLError, urlError.code == .cancelled {
            result = .failure(CancellationError())
        } else if let error {
            result = .failure(error)
        } else if let response = task.response as? HTTPURLResponse,
                  !(200...299).contains(response.statusCode) {
            result = .failure(CreateDocumentServiceError.uploadFailed(response.statusCode))
        } else {
            progress(1)
            result = .success(())
        }
        finish(result)
    }

    private func cancel() {
        lock.lock()
        let task = task
        lock.unlock()
        task?.cancel()
    }

    private func finish(_ result: Result<Void, Error>) {
        lock.lock()
        guard let continuation else {
            completedResult = result
            lock.unlock()
            return
        }
        self.continuation = nil
        lock.unlock()
        continuation.resume(with: result)
    }
}
