@preconcurrency import ConvexMobile
import Foundation
import LocalAuthentication
import Observation
import UIKit
import UserNotifications

enum AppAuthenticationState: Equatable {
    case restoring
    case signedOut
    case signingIn
    case choosingCompany
    case signedIn
}

@MainActor
@Observable
final class PathwayAppModel {
    private(set) var authenticationState: AppAuthenticationState = .restoring
    private(set) var dashboardBootstrap: MobileDashboardBootstrap?
    private(set) var documents: [DashboardDocument] = []
    private(set) var pinnedDocuments: [DashboardDocument] = []
    private(set) var pinnedDocumentIDs: Set<String> = []
    private(set) var companyPickerContext: NativeCompanyPickerContext?
    private(set) var companySwitcherContext: NativeCompanyPickerContext?
    private(set) var pendingCompanyID: String?
    private(set) var dashboardErrorMessage: String?
    private(set) var companySwitcherErrorMessage: String?
    private(set) var companyAssetSignature: CompanyAssetCloudFrontSignature?
    private(set) var pendingAdminAuthorizationRequest: AdminAuthorizationRequest?
    private(set) var adminAuthorizationDecisionState: AdminAuthorizationDecisionState = .idle
    var authenticationErrorMessage: String?

    @ObservationIgnored let settingsStore: SettingsFeatureStore
    @ObservationIgnored let settingsDevicePreferences: SettingsDevicePreferences
    @ObservationIgnored let settingsProfileService: SettingsProfileService
    @ObservationIgnored let settingsBillingService: SettingsBillingService
    @ObservationIgnored let settingsSupportService: SettingsSupportService
    @ObservationIgnored let documentService: any DocumentServicing

    @ObservationIgnored private let authProvider: PathwayAuthProvider
    @ObservationIgnored private let convex: ConvexClientWithAuth<PathwayAuthSession>
    @ObservationIgnored private let createDocumentService: ConvexCreateDocumentService
    @ObservationIgnored private var bootstrapTask: Task<Void, Never>?
    @ObservationIgnored private var companyAssetSignatureTask: Task<Void, Never>?
    @ObservationIgnored private var documentsTask: Task<Void, Never>?
    @ObservationIgnored private var pinnedDocumentsTask: Task<Void, Never>?
    @ObservationIgnored private var adminApprovalsTask: Task<Void, Never>?
    @ObservationIgnored private var adminApprovalExpirationTask: Task<Void, Never>?
    @ObservationIgnored private var deviceRegistrationTask: Task<Void, Never>?
    @ObservationIgnored private var hasRestoredSession = false
    @ObservationIgnored private var hasStartedAdminApprovalCapability = false
    @ObservationIgnored private var remoteNotificationsDeviceToken: String?
    @ObservationIgnored private var preferredAdminAuthorizationRequestID: String?
    @ObservationIgnored private let deviceOwnerAuthenticator: DeviceOwnerAuthenticating
    @ObservationIgnored private var pendingPinOverrides: [String: Bool] = [:]
    @ObservationIgnored private var pendingArchivedDocumentIDs: Set<String> = []

    init(
        convexDeploymentURL: URL = AppConfiguration.convexDeploymentURL
            ?? URL(string: "https://invalid.pathway.local")!,
        deviceOwnerAuthenticator: DeviceOwnerAuthenticating? = nil,
        documentService: (any DocumentServicing)? = nil,
        dashboardBootstrap: MobileDashboardBootstrap? = nil
    ) {
        let provider = PathwayAuthProvider()
        authProvider = provider
        self.deviceOwnerAuthenticator = deviceOwnerAuthenticator ?? DeviceOwnerAuthenticator()
        let convexClient = ConvexClientWithAuth(
            deploymentUrl: convexDeploymentURL.absoluteString,
            authProvider: provider
        )
        convex = convexClient
        let devicePreferences = SettingsDevicePreferences()
        settingsDevicePreferences = devicePreferences
        settingsStore = SettingsFeatureStore(
            client: ConvexSettingsCatalogClient(convex: convexClient),
            devicePreferences: devicePreferences
        )
        settingsProfileService = SettingsProfileService(convex: convexClient)
        settingsBillingService = SettingsBillingService(convex: convexClient)
        settingsSupportService = SettingsSupportService(convex: convexClient)
        createDocumentService = ConvexCreateDocumentService(convex: convexClient)
        self.documentService = documentService ?? ConvexDocumentService(convex: convexClient)
        self.dashboardBootstrap = dashboardBootstrap
    }

    func restoreSession() async {
        guard !hasRestoredSession else { return }
        hasRestoredSession = true
        authenticationState = .restoring

        switch await convex.loginFromCache() {
        case .success:
            settingsStore.reset()
            authenticationState = .signedIn
            startSubscriptions()
        case .failure:
            if let context = await authProvider.companyPickerContext() {
                companyPickerContext = context
                authenticationState = .choosingCompany
            } else {
                authenticationState = .signedOut
            }
        }
    }

    func signIn() async {
        authenticationState = .signingIn
        authenticationErrorMessage = nil

        do {
            try await authProvider.startHostedSignIn()
            switch await convex.login() {
            case .success:
                settingsStore.reset()
                authenticationState = .signedIn
                startSubscriptions()
            case let .failure(error):
                authenticationState = .signedOut
                authenticationErrorMessage = error.localizedDescription
            }
        } catch {
            authenticationState = .signedOut
            authenticationErrorMessage = error.localizedDescription
        }
    }

    func chooseCompany(_ companyID: String) async {
        guard pendingCompanyID == nil else { return }
        pendingCompanyID = companyID
        authenticationErrorMessage = nil

        do {
            try await authProvider.chooseCompany(companyID)
            switch await convex.login() {
            case .success:
                settingsStore.reset()
                companyPickerContext = nil
                pendingCompanyID = nil
                authenticationState = .signedIn
                startSubscriptions()
            case let .failure(error):
                pendingCompanyID = nil
                authenticationErrorMessage = error.localizedDescription
            }
        } catch {
            pendingCompanyID = nil
            authenticationErrorMessage = error.localizedDescription
        }
    }

    func loadCompanySwitcherContext() async {
        guard authenticationState == .signedIn else { return }
        companySwitcherErrorMessage = nil

        do {
            companySwitcherContext = try await authProvider.loadCompanySwitcherContext()
        } catch {
            companySwitcherContext = nil
            companySwitcherErrorMessage = error.localizedDescription
        }
    }

    func switchCompany(_ companyID: String) async -> Bool {
        guard
            authenticationState == .signedIn,
            pendingCompanyID == nil,
            dashboardBootstrap?.companyData.id != companyID
        else {
            return false
        }

        pendingCompanyID = companyID
        companySwitcherErrorMessage = nil

        do {
            try await authProvider.selectCompanyForCurrentSession(companyID)
            cancelSubscriptions()
            settingsStore.reset()

            switch await convex.login() {
            case .success:
                dashboardBootstrap = nil
                documents = []
                pinnedDocuments = []
                pinnedDocumentIDs = []
                companyAssetSignature = nil
                companySwitcherContext = nil
                pendingCompanyID = nil
                startSubscriptions()
                return true
            case let .failure(error):
                pendingCompanyID = nil
                companySwitcherErrorMessage = error.localizedDescription
                startSubscriptions()
                return false
            }
        } catch {
            pendingCompanyID = nil
            companySwitcherErrorMessage = error.localizedDescription
            return false
        }
    }

    func signOut() async {
        deviceOwnerAuthenticator.cancelAdminAuthorizationAuthentication()
        await unregisterAdminApprovalDevice()
        cancelSubscriptions()
        settingsStore.reset()
        await convex.logout()
        dashboardBootstrap = nil
        documents = []
        pinnedDocuments = []
        pinnedDocumentIDs = []
        companyPickerContext = nil
        companySwitcherContext = nil
        pendingCompanyID = nil
        authenticationErrorMessage = nil
        companySwitcherErrorMessage = nil
        companyAssetSignature = nil
        pendingAdminAuthorizationRequest = nil
        adminAuthorizationDecisionState = .idle
        authenticationState = .signedOut
    }

    func authenticateSensitiveSettingsChange(reason: String) async throws {
        try await deviceOwnerAuthenticator.authenticateDeviceOwner(localizedReason: reason)
    }

    func finishCompanyCancellation(hasAnotherSelectableCompany: Bool) async {
        guard hasAnotherSelectableCompany else {
            await signOut()
            return
        }

        await loadCompanySwitcherContext()
        let currentCompanyID = dashboardBootstrap?.companyData.id
        guard let nextCompany = companySwitcherContext?.companies.first(where: {
            $0.isSelectable && $0.companyId != currentCompanyID
        }) else {
            await signOut()
            return
        }
        if !(await switchCompany(nextCompany.companyId)) {
            await signOut()
        }
    }

    func didRegisterForRemoteNotifications(deviceToken: String) {
        remoteNotificationsDeviceToken = deviceToken
        guard hasStartedAdminApprovalCapability else { return }
        registerCurrentApprovalDevice(apnsToken: deviceToken)
    }

    func handleAdminAuthorizationNotification(requestID: String) {
        preferredAdminAuthorizationRequestID = requestID
        guard pendingAdminAuthorizationRequest?.requestId != requestID else { return }
        restartAdminApprovalSubscription()
    }

    func approveAdminAuthorizationRequest(_ request: AdminAuthorizationRequest) async {
        guard canBeginDecision(for: request) else { return }
        adminAuthorizationDecisionState = .deciding(requestID: request.requestId, decision: .approved)

        do {
            try await deviceOwnerAuthenticator.authenticateAdminAuthorization()
            try await decideAdminAuthorization(request, decision: "approved")
        } catch {
            guard pendingAdminAuthorizationRequest?.requestId == request.requestId else {
                adminAuthorizationDecisionState = .idle
                return
            }
            adminAuthorizationDecisionState = .failed(
                requestID: request.requestId,
                message: decisionErrorMessage(for: error)
            )
        }
    }

    func denyAdminAuthorizationRequest(_ request: AdminAuthorizationRequest) async {
        guard canBeginDecision(for: request) else { return }
        adminAuthorizationDecisionState = .deciding(requestID: request.requestId, decision: .denied)

        do {
            try await decideAdminAuthorization(request, decision: "denied")
        } catch {
            guard pendingAdminAuthorizationRequest?.requestId == request.requestId else {
                adminAuthorizationDecisionState = .idle
                return
            }
            adminAuthorizationDecisionState = .failed(
                requestID: request.requestId,
                message: decisionErrorMessage(for: error)
            )
        }
    }

    func requestPasswordReset(email: String) async throws -> String {
        try await authProvider.requestPasswordReset(email: email)
    }

    func makeCreateDocumentFlowModel() -> CreateDocumentFlowModel? {
        guard let dashboardBootstrap else { return nil }
        return CreateDocumentFlowModel(
            service: createDocumentService,
            context: dashboardBootstrap.createDocumentContext,
            companyAssetSignature: companyAssetSignature
        )
    }

    func isDocumentPinned(_ documentID: String) -> Bool {
        pendingPinOverrides[documentID] ?? pinnedDocumentIDs.contains(documentID)
    }

    func setDocumentPinned(_ document: DashboardDocument, pinned: Bool) async throws {
        let previousPinnedIDs = pinnedDocumentIDs
        let previousPinnedDocuments = pinnedDocuments
        pendingPinOverrides[document.id] = pinned
        applyPinnedState(document, pinned: pinned)

        do {
            let serverPinnedIDs = try await documentService.setPinned(
                documentID: document.id,
                pinned: pinned
            )
            pendingPinOverrides[document.id] = nil
            if let serverPinnedIDs {
                pinnedDocumentIDs = Set(serverPinnedIDs)
                pinnedDocuments.removeAll { !pinnedDocumentIDs.contains($0.id) }
                if pinnedDocumentIDs.contains(document.id),
                   !pinnedDocuments.contains(where: { $0.id == document.id })
                {
                    pinnedDocuments.insert(document, at: 0)
                }
            }
        } catch {
            pendingPinOverrides[document.id] = nil
            pinnedDocumentIDs = previousPinnedIDs
            pinnedDocuments = previousPinnedDocuments
            throw error
        }
    }

    func archiveDocument(_ document: DashboardDocument) async throws -> ArchivedDocumentUndo {
        let undo = ArchivedDocumentUndo(
            document: document,
            documentIndex: documents.firstIndex(where: { $0.id == document.id }),
            pinnedDocumentIndex: pinnedDocuments.firstIndex(where: { $0.id == document.id }),
            wasPinned: isDocumentPinned(document.id)
        )
        pendingArchivedDocumentIDs.insert(document.id)
        removeDocumentFromVisibleCollections(document.id)

        do {
            try await documentService.archive(documentID: document.id)
            return undo
        } catch {
            pendingArchivedDocumentIDs.remove(document.id)
            restoreDocumentToVisibleCollections(undo)
            throw error
        }
    }

    func restoreArchivedDocument(_ undo: ArchivedDocumentUndo) async throws {
        pendingArchivedDocumentIDs.remove(undo.document.id)
        restoreDocumentToVisibleCollections(undo)

        do {
            try await documentService.restore(documentID: undo.document.id)
        } catch {
            pendingArchivedDocumentIDs.insert(undo.document.id)
            removeDocumentFromVisibleCollections(undo.document.id)
            throw error
        }
    }

    private func applyPinnedState(_ document: DashboardDocument, pinned: Bool) {
        if pinned {
            pinnedDocumentIDs.insert(document.id)
            if !pinnedDocuments.contains(where: { $0.id == document.id }) {
                pinnedDocuments.insert(document, at: 0)
            }
        } else {
            pinnedDocumentIDs.remove(document.id)
            pinnedDocuments.removeAll { $0.id == document.id }
        }
    }

    private func removeDocumentFromVisibleCollections(_ documentID: String) {
        documents.removeAll { $0.id == documentID }
        pinnedDocuments.removeAll { $0.id == documentID }
        pinnedDocumentIDs.remove(documentID)
    }

    private func restoreDocumentToVisibleCollections(_ undo: ArchivedDocumentUndo) {
        if let index = undo.documentIndex,
           !documents.contains(where: { $0.id == undo.document.id })
        {
            documents.insert(undo.document, at: min(index, documents.endIndex))
        }
        if undo.wasPinned {
            pinnedDocumentIDs.insert(undo.document.id)
            if !pinnedDocuments.contains(where: { $0.id == undo.document.id }) {
                let index = undo.pinnedDocumentIndex ?? 0
                pinnedDocuments.insert(undo.document, at: min(index, pinnedDocuments.endIndex))
            }
        }
    }

    private func startSubscriptions() {
        cancelSubscriptions()
        dashboardErrorMessage = nil
        companyAssetSignature = nil

        bootstrapTask = Task { [weak self] in
            guard let self else { return }
            let updates = convex.subscribe(
                to: "functions/dashboard/table:getMobileDashboardBootstrap",
                yielding: MobileDashboardBootstrap?.self
            ).values
            do {
                for try await value in updates {
                    guard !Task.isCancelled else { return }
                    dashboardBootstrap = value
                    await updateAdminApprovalCapability(for: value)
                }
            } catch {
                guard !Task.isCancelled else { return }
                dashboardErrorMessage = error.localizedDescription
            }
        }

        companyAssetSignatureTask = Task { [weak self] in
            guard let self else { return }
            do {
                let signature: CompanyAssetCloudFrontSignature = try await convex.action(
                    "functions/settings/companySettingsActions:getCompanyAssetCloudfrontSignature"
                )
                guard !Task.isCancelled else { return }
                companyAssetSignature = signature
            } catch {
                guard !Task.isCancelled else { return }
                companyAssetSignature = nil
            }
        }

        documentsTask = subscribeToDocuments(tab: "all") { [weak self] result in
            guard let self else { return }
            reconcileArchivedDocuments(with: result.documents)
            pinnedDocumentIDs = resolvedPinnedDocumentIDs(from: result.pinnedDocumentIds)
            documents = result.documents.filter { !pendingArchivedDocumentIDs.contains($0.id) }
        }
        pinnedDocumentsTask = subscribeToDocuments(tab: "pinned") { [weak self] result in
            guard let self else { return }
            pinnedDocumentIDs = resolvedPinnedDocumentIDs(from: result.pinnedDocumentIds)
            pinnedDocuments = result.documents.filter {
                !pendingArchivedDocumentIDs.contains($0.id) && isDocumentPinned($0.id)
            }
        }
    }

    private func resolvedPinnedDocumentIDs(from serverIDs: [String]) -> Set<String> {
        var ids = Set(serverIDs)
        for (documentID, pinned) in pendingPinOverrides {
            if pinned {
                ids.insert(documentID)
            } else {
                ids.remove(documentID)
            }
        }
        return ids.subtracting(pendingArchivedDocumentIDs)
    }

    private func reconcileArchivedDocuments(with serverDocuments: [DashboardDocument]) {
        let serverDocumentIDs = Set(serverDocuments.map(\.id))
        pendingArchivedDocumentIDs = pendingArchivedDocumentIDs.intersection(serverDocumentIDs)
    }

    private func subscribeToDocuments(
        tab: String,
        receiveValue: @MainActor @escaping (DashboardTableResult) -> Void
    ) -> Task<Void, Never> {
        Task { [weak self] in
            guard let self else { return }
            let recordCount: [String: ConvexEncodable?] = ["count": Double(20)]
            let updates = convex.subscribe(
                to: "functions/dashboard/table:fetchDocumentTable",
                with: [
                    "page": "allDocuments",
                    "pageOffset": Double(0),
                    "nowMs": coarseCurrentTime,
                    "mobileTab": tab,
                    "mobileRecordOffset": Double(0),
                    "recordCount": recordCount
                ],
                yielding: DashboardTableResult?.self
            ).values

            do {
                for try await value in updates {
                    guard !Task.isCancelled, let value, value.success else { continue }
                    receiveValue(value)
                }
            } catch {
                guard !Task.isCancelled else { return }
                dashboardErrorMessage = error.localizedDescription
            }
        }
    }

    private var coarseCurrentTime: Double {
        let fiveMinutes = 5 * 60 * 1000
        let currentMilliseconds = Int(Date.now.timeIntervalSince1970 * 1000)
        return Double((currentMilliseconds / fiveMinutes) * fiveMinutes)
    }

    private func cancelSubscriptions() {
        bootstrapTask?.cancel()
        companyAssetSignatureTask?.cancel()
        documentsTask?.cancel()
        pinnedDocumentsTask?.cancel()
        adminApprovalsTask?.cancel()
        adminApprovalExpirationTask?.cancel()
        deviceRegistrationTask?.cancel()
        bootstrapTask = nil
        companyAssetSignatureTask = nil
        documentsTask = nil
        pinnedDocumentsTask = nil
        adminApprovalsTask = nil
        adminApprovalExpirationTask = nil
        deviceRegistrationTask = nil
        hasStartedAdminApprovalCapability = false
        preferredAdminAuthorizationRequestID = nil
        pendingPinOverrides = [:]
        pendingArchivedDocumentIDs = []
        createDocumentService.clearCache()
    }

    private func updateAdminApprovalCapability(for bootstrap: MobileDashboardBootstrap?) async {
        guard bootstrap?.userData.canApproveAdminAuthorization == true else {
            if hasStartedAdminApprovalCapability {
                await unregisterAdminApprovalDevice()
                stopAdminApprovalCapability()
            }
            return
        }

        guard !hasStartedAdminApprovalCapability else { return }
        hasStartedAdminApprovalCapability = true
        try? await registerApprovalDevice(apnsToken: remoteNotificationsDeviceToken)
        restartAdminApprovalSubscription()
        await requestRemoteNotificationAuthorization()
    }

    private func stopAdminApprovalCapability() {
        deviceOwnerAuthenticator.cancelAdminAuthorizationAuthentication()
        hasStartedAdminApprovalCapability = false
        adminApprovalsTask?.cancel()
        adminApprovalExpirationTask?.cancel()
        deviceRegistrationTask?.cancel()
        adminApprovalsTask = nil
        adminApprovalExpirationTask = nil
        deviceRegistrationTask = nil
        pendingAdminAuthorizationRequest = nil
        adminAuthorizationDecisionState = .idle
        preferredAdminAuthorizationRequestID = nil
    }

    private func restartAdminApprovalSubscription() {
        guard hasStartedAdminApprovalCapability else { return }
        adminApprovalsTask?.cancel()
        adminApprovalsTask = Task { [weak self] in
            guard let self else { return }
            let updates = convex.subscribe(
                to: "functions/admin/adminAuthorization:listPendingMobileApprovals",
                with: ["deviceIdentifier": DeviceIdentifier.shared.getDeviceUUID()],
                yielding: [AdminAuthorizationRequest].self
            ).values

            do {
                for try await requests in updates {
                    guard !Task.isCancelled else { return }
                    selectPendingAdminAuthorization(from: requests)
                }
            } catch {
                guard !Task.isCancelled else { return }
                adminAuthorizationDecisionState = .failed(
                    requestID: pendingAdminAuthorizationRequest?.requestId ?? "",
                    message: "Pathway could not check for authorization requests."
                )
            }
        }
    }

    private func selectPendingAdminAuthorization(from requests: [AdminAuthorizationRequest]) {
        let preferredRequestID = preferredAdminAuthorizationRequestID
        let selected = requests.selectedAdminAuthorizationRequest(
            preferredRequestID: preferredRequestID
        )

        // A delayed notification must not replace the visible sheet with an
        // unrelated request when its own request has already been decided.
        if preferredRequestID != nil, selected == nil {
            preferredAdminAuthorizationRequestID = nil
            return
        }

        let requestChanged = pendingAdminAuthorizationRequest?.requestId != selected?.requestId
        if requestChanged {
            deviceOwnerAuthenticator.cancelAdminAuthorizationAuthentication()
            adminAuthorizationDecisionState = .idle
        }
        preferredAdminAuthorizationRequestID = nil
        pendingAdminAuthorizationRequest = selected
        scheduleLocalExpiration(for: selected)
    }

    private func scheduleLocalExpiration(for request: AdminAuthorizationRequest?) {
        adminApprovalExpirationTask?.cancel()
        guard let request else {
            adminApprovalExpirationTask = nil
            return
        }

        let delay = max(0, request.expiresDate.timeIntervalSinceNow)
        adminApprovalExpirationTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(delay))
            guard
                !Task.isCancelled,
                self?.pendingAdminAuthorizationRequest?.requestId == request.requestId
            else { return }
            self?.deviceOwnerAuthenticator.cancelAdminAuthorizationAuthentication()
            self?.pendingAdminAuthorizationRequest = nil
            self?.adminAuthorizationDecisionState = .idle
        }
    }

    private func requestRemoteNotificationAuthorization() async {
        let center = UNUserNotificationCenter.current()
        let settings = await center.notificationSettings()
        var mayRegister = settings.authorizationStatus == .authorized ||
            settings.authorizationStatus == .provisional ||
            settings.authorizationStatus == .ephemeral

        if settings.authorizationStatus == .notDetermined {
            mayRegister = (try? await center.requestAuthorization(options: [.alert, .badge, .sound])) == true
        }

        if mayRegister {
            UIApplication.shared.registerForRemoteNotifications()
        }
    }

    private func registerCurrentApprovalDevice(apnsToken: String?) {
        guard hasStartedAdminApprovalCapability else { return }
        let previousRegistration = deviceRegistrationTask
        previousRegistration?.cancel()
        deviceRegistrationTask = Task { [weak self] in
            guard let self else { return }
            await previousRegistration?.value
            guard !Task.isCancelled else { return }
            try? await registerApprovalDevice(apnsToken: apnsToken)
        }
    }

    private func registerApprovalDevice(apnsToken: String?) async throws {
        let deviceIdentifier = DeviceIdentifier.shared.getDeviceUUID()
        let bundleID = Bundle.main.bundleIdentifier ?? "com.cit.Pathway"
        var arguments: [String: ConvexEncodable?] = [
            "deviceIdentifier": deviceIdentifier,
            "environment": AppConfiguration.apnsEnvironment.rawValue,
            "bundleId": bundleID,
            "supportsImpersonationRenewal": true
        ]
        if let apnsToken {
            arguments["apnsToken"] = apnsToken
        }

        let _: String = try await convex.mutation(
            "functions/admin/adminAuthorization:registerApprovalDevice",
            with: arguments
        )
    }

    private func unregisterAdminApprovalDevice() async {
        guard hasStartedAdminApprovalCapability else { return }
        deviceRegistrationTask?.cancel()
        await deviceRegistrationTask?.value
        deviceRegistrationTask = nil
        let deviceIdentifier = DeviceIdentifier.shared.getDeviceUUID()
        let _: String? = try? await convex.mutation(
            "functions/admin/adminAuthorization:unregisterApprovalDevice",
            with: ["deviceIdentifier": deviceIdentifier]
        )
    }

    private func canBeginDecision(for request: AdminAuthorizationRequest) -> Bool {
        guard case .deciding = adminAuthorizationDecisionState else {
            return pendingAdminAuthorizationRequest?.requestId == request.requestId &&
                request.expiresDate > .now
        }
        return false
    }

    private func decideAdminAuthorization(
        _ request: AdminAuthorizationRequest,
        decision: String
    ) async throws {
        // Reassert the authenticated session/device binding immediately before
        // deciding so a transient bootstrap registration failure cannot strand
        // a foreground approval sheet.
        try await registerApprovalDevice(apnsToken: remoteNotificationsDeviceToken)
        let _: AdminAuthorizationDecisionResult = try await convex.mutation(
            "functions/admin/adminAuthorization:decideMobileAuthorization",
            with: [
                "requestId": request.requestId,
                "deviceIdentifier": DeviceIdentifier.shared.getDeviceUUID(),
                "decision": decision
            ]
        )

        // Every response represents a terminal first-wins decision, even when another device won.
        pendingAdminAuthorizationRequest = nil
        adminAuthorizationDecisionState = .idle
    }

    private func decisionErrorMessage(for error: Error) -> String {
        if error is CancellationError {
            return "Confirmation was cancelled. The admin session has not been authorized."
        }
        if error is LAError {
            return "Your identity could not be verified. The admin session has not been authorized."
        }
        return "Pathway could not complete this decision. Please try again."
    }
}
