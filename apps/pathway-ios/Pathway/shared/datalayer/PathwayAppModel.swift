import Foundation
import Observation
import WidgetKit

enum AppAuthenticationState: Equatable {
    case restoring
    case signedOut
    case signingIn
    case signedIn
}

/// A thread the user just launched from the composer. The shell watches this to switch
/// to Agent Threads and open the thread once it arrives through cloud sync.
struct PathwayPendingThreadRoute: Equatable, Sendable {
    let companyId: String
    let environmentId: String
    let threadId: String
}

@MainActor
@Observable
final class PathwayAppModel {
    private(set) var authenticationState: AppAuthenticationState = .restoring
    private(set) var authenticationErrorMessage: String?
    var pendingThreadRoute: PathwayPendingThreadRoute?
    var pendingStorageNotification: PathwayStorageNotificationDestination?
    var pendingProductLink: PathwayProductLink?
    private(set) var localStorageDirectory: URL?
    private(set) var accountID: String?
    private(set) var accountIdentity: String?
    private(set) var isAccountReady = false {
        didSet { if oldValue != isAccountReady { configureWorkWidget() } }
    }
    @ObservationIgnored private let workWidget = PathwayWorkWidgetStore.shared()
    @ObservationIgnored private var workWidgetSession: UUID?
    @ObservationIgnored private var lastWidgetCounts: [Int]?
    @ObservationIgnored private var lastWidgetDate: Date?
    @ObservationIgnored private var preparedStorageDirectory: URL?
    let cloud: PathwayCloudModel
    let projectIcons = PathwayProjectIconCache()
    let connect: PathwayConnectClient?
    let relayURL: URL?

    @ObservationIgnored private let authProvider: any PathwayAuthenticating
    @ObservationIgnored private var hasRestoredSession = false
    @ObservationIgnored private var authenticationGeneration = 0
    @ObservationIgnored private var storagePreparation: Task<Void, Never>?

    init(
        authProvider: (any PathwayAuthenticating)? = nil,
        convexDeploymentURL: URL? = nil,
        relayURL: URL? = nil,
        relayJWTTemplate: String? = nil
    ) {
        let provider = authProvider ?? PathwayAuthProvider()
        self.relayURL = relayURL
        self.authProvider = provider
        if let relayURL, let relayJWTTemplate {
            connect = PathwayConnectClient(
                relayURL: relayURL,
                clerkTokenProvider: {
                    try await provider.token(template: relayJWTTemplate)
                }
            )
        } else {
            connect = nil
        }
            if let convexDeploymentURL {
                cloud = PathwayCloudModel(
                    client: PathwayConvexClient(
                        deploymentURL: convexDeploymentURL,
                        credentials: provider
                    ),
                    connect: connect
                )
            } else {
                cloud = PathwayCloudModel()
            }
        provider.onSessionChanged = { [weak self] hasActiveSession in
            self?.sessionDidChange(hasActiveSession: hasActiveSession)
        }
        configureWorkWidget()
    }

    func restoreSession() async {
        guard !hasRestoredSession else { return }
        hasRestoredSession = true
        authenticationErrorMessage = nil
        authenticationState = authProvider.hasActiveSession ? .signedIn : .signedOut
        if authenticationState == .signedIn {
            guard await prepareLocalStorage() else { return }
            await cloud.start()
        }
    }

    func signIn() async {
        let generation = authenticationGeneration
        authenticationState = .signingIn
        authenticationErrorMessage = nil

        do {
            try await authProvider.startHostedSignIn()
            guard generation == authenticationGeneration else { return }
            authenticationState = .signedIn
            guard await prepareLocalStorage(), generation == authenticationGeneration else { return }
            await cloud.start()
        } catch {
            guard generation == authenticationGeneration else { return }
            authenticationState = .signedOut
            authenticationErrorMessage = error.localizedDescription
        }
    }

    func signOut() async {
        do {
            await PathwayNotifications.shared.stop()
            try await authProvider.signOut()
            authenticationGeneration += 1
            storagePreparation?.cancel()
            await storagePreparation?.value
            isAccountReady = false
            preparedStorageDirectory = nil
            localStorageDirectory = nil
            accountID = nil
            accountIdentity = nil
            pendingThreadRoute = nil
            pendingProductLink = nil
            PathwaySystemEntry.shared.request = nil
            PathwayKeyboardPreferences.shared.pendingAction = nil
            await PathwayCaptureInbox.shared.configure(accountDirectory: nil)
            await cloud.stop()
            await cloud.configureLocalStorage(directory: nil)
            projectIcons.clear()
            authenticationErrorMessage = nil
            authenticationState = .signedOut
        } catch {
            authenticationErrorMessage = error.localizedDescription
            if authenticationState == .signedIn { await PathwayNotifications.shared.configure(appModel: self) }
        }
    }

    func sessionDidEnd() {
        PathwayNotifications.shared.clearLocalRegistration()
        authenticationGeneration += 1
        storagePreparation?.cancel()
        isAccountReady = false
        preparedStorageDirectory = nil
        localStorageDirectory = nil
        accountID = nil
        accountIdentity = nil
        pendingThreadRoute = nil
        pendingProductLink = nil
        PathwaySystemEntry.shared.request = nil
            PathwayKeyboardPreferences.shared.pendingAction = nil
        projectIcons.clear()
        authenticationErrorMessage = "Your Pathway session ended. Sign in again to continue."
        authenticationState = .signedOut
    }

    private func sessionDidChange(hasActiveSession: Bool) {
        if hasActiveSession {
            // Every auth event invalidates token reads started for an earlier session.
            authenticationGeneration += 1
            isAccountReady = false
            PathwayNotifications.shared.clearLocalRegistration()
            let generation = authenticationGeneration
            authenticationErrorMessage = nil
            authenticationState = .signedIn
            Task { @MainActor [weak self] in
                guard let self, generation == authenticationGeneration else { return }
                guard await prepareLocalStorage(), generation == authenticationGeneration else { return }
                await cloud.start()
            }
        } else if authenticationState == .signedIn {
            sessionDidEnd()
            let generation = authenticationGeneration
            let previous = storagePreparation
            previous?.cancel()
            storagePreparation = Task { @MainActor [weak self] in
                await previous?.value
                guard let self, generation == authenticationGeneration else { return }
                await PathwayCaptureInbox.shared.configure(accountDirectory: nil)
                await cloud.stop()
                guard generation == authenticationGeneration else { return }
                await cloud.configureLocalStorage(directory: nil)
            }
        }
    }

    private func prepareLocalStorage() async -> Bool {
        let generation = authenticationGeneration
        await PathwayCaptureInbox.shared.configure(accountDirectory: nil)
        guard generation == authenticationGeneration else { return false }
        let token = try? await authProvider.token(template: nil)
        guard generation == authenticationGeneration, authenticationState == .signedIn else { return false }
        guard let token, let identity = PathwayAccountStorage.identity(fromToken: token) else {
            authenticationErrorMessage = "Pathway could not prepare your account. Sign in again to continue."
            return false
        }
        let directory = PathwayAccountStorage.directory(for: identity)
        let previous = storagePreparation
        if directory == preparedStorageDirectory {
            await previous?.value
            guard generation == authenticationGeneration, authenticationState == .signedIn, !Task.isCancelled else { return false }
            await PathwayCaptureInbox.shared.configure(accountDirectory: directory)
            guard generation == authenticationGeneration, !Task.isCancelled else { return false }
            await PathwayNotifications.shared.configure(appModel: self)
            guard generation == authenticationGeneration, !Task.isCancelled else { return false }
            isAccountReady = true
            return true
        }
        previous?.cancel()
        isAccountReady = false
        preparedStorageDirectory = nil
        if accountIdentity != nil && accountIdentity != identity {
            pendingThreadRoute = nil
            pendingProductLink = nil
            PathwaySystemEntry.shared.request = nil
            PathwayKeyboardPreferences.shared.pendingAction = nil
            projectIcons.clear()
        }
        accountIdentity = identity
        accountID = identity.split(separator: "\n").last.map(String.init)
        localStorageDirectory = directory
        let task = Task { @MainActor [weak self] in
            // Account transitions finish in order even when an SDK operation ignores cancellation.
            await previous?.value
            guard let self, !Task.isCancelled, authenticationGeneration == generation else { return }
            await cloud.configureLocalStorage(directory: directory)
            guard !Task.isCancelled, authenticationGeneration == generation, authenticationState == .signedIn else { return }
            await PathwayCaptureInbox.shared.configure(accountDirectory: directory)
            guard !Task.isCancelled, authenticationGeneration == generation else { return }
            await PathwayNotifications.shared.configure(appModel: self)
            guard !Task.isCancelled, authenticationGeneration == generation else { return }
            preparedStorageDirectory = directory
            isAccountReady = true
        }
        storagePreparation = task
        await task.value
        return generation == authenticationGeneration && authenticationState == .signedIn && isAccountReady && !Task.isCancelled
    }

    var workWidgetCounts: [Int] {
        cloud.threads.reduce(into: [0, 0]) { counts, thread in
            guard thread.shell.archivedAt == nil, thread.shell.deletedAt == nil else { return }
            if thread.isRunning { counts[0] += 1 }
            if thread.needsAction { counts[1] += 1 }
        }
    }

    private func configureWorkWidget() {
        lastWidgetCounts = nil
        lastWidgetDate = nil
        workWidgetSession = try? workWidget?.configure(accountKey: isAccountReady ? localStorageDirectory?.lastPathComponent : nil)
        if workWidget != nil { WidgetCenter.shared.reloadTimelines(ofKind: PathwayWorkWidgetStore.kind) }
        updateWorkWidget()
    }

    func updateWorkWidget() {
        guard isAccountReady, let workWidget, let session = workWidgetSession,
              cloud.isConnected || cloud.connectionState == .disconnected,
              let date = cloud.cachedAt else { return }
        let counts = workWidgetCounts
        if counts == lastWidgetCounts, let previous = lastWidgetDate, date.timeIntervalSince(previous) < 60 { return }
        if (try? workWidget.publish(runningCount: counts[0], attentionCount: counts[1], updatedAt: date, session: session)) == true {
            lastWidgetCounts = counts
            lastWidgetDate = date
            WidgetCenter.shared.reloadTimelines(ofKind: PathwayWorkWidgetStore.kind)
        }
    }

    func openProductLink(_ link: PathwayProductLink) {
        pendingProductLink = link
        resolveProductLink()
    }

    func resolveProductLink() {
        guard authenticationState == .signedIn, isAccountReady, let link = pendingProductLink,
              let thread = cloud.threads.first(where: { $0.environmentId == link.environmentID && $0.threadId == link.threadID }) else { return }
        pendingThreadRoute = .init(companyId: thread.companyId, environmentId: thread.environmentId, threadId: thread.threadId)
        pendingProductLink = nil
    }
}
