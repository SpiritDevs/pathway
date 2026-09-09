import Foundation
import Observation
import UIKit
import UserNotifications

struct PathwayNotificationPreferences: Codable, Equatable {
    var notificationsEnabled = false
    var notifyOnApproval = true
    var notifyOnInput = true
    var notifyOnCompletion = true
    var notifyOnFailure = true
    var liveActivitiesEnabled = false
}

@MainActor @Observable final class PathwayNotifications {
    static let shared = PathwayNotifications()
    var preferences = PathwayNotificationPreferences()
    private(set) var authorization: UNAuthorizationStatus = .notDetermined
    private(set) var registering = false
    private(set) var registered = false
    var errorMessage: String?
    @ObservationIgnored private weak var appModel: PathwayAppModel?
    @ObservationIgnored private var token: String?
    @ObservationIgnored private var pushToStartToken: String?
    @ObservationIgnored private var preferenceKey: String?
    @ObservationIgnored private var generation = 0
    @ObservationIgnored private let registrationWriter = PathwayNotificationRegistrationWriter()
    @ObservationIgnored private var activityConfigurationTask: Task<Void, Never>?
    @ObservationIgnored private var needsActivityConfiguration = false
    @ObservationIgnored private var activityStopTask: Task<Void, Never>?
    private let deviceID: String

    private init() {
        let key = "pathway.apns.deviceID"
        let stored = UserDefaults.standard.string(forKey: key)
        deviceID = stored ?? UUID().uuidString.lowercased()
        if stored == nil { UserDefaults.standard.set(deviceID, forKey: key) }
    }

    func configure(appModel: PathwayAppModel) async {
        await activityStopTask?.value
        activityStopTask = nil
        guard let directory = appModel.localStorageDirectory else { return }
        let key = "pathway.notifications.\(directory.lastPathComponent)"
        if preferenceKey != key {
            let drain = registrationWriter.fence()
            generation += 1; registered = false
            await drain?.value
            await activityConfigurationTask?.value
            #if os(iOS)
            await PathwayLiveActivities.shared.stop()
            #endif
            registrationWriter.resume()
            preferenceKey = key
            preferences = UserDefaults.standard.data(forKey: key).flatMap { try? JSONDecoder().decode(PathwayNotificationPreferences.self, from: $0) } ?? .init()
        }
        self.appModel = appModel
        await refreshAuthorization()
        if preferences.notificationsEnabled && authorization == .authorized {
            UIApplication.shared.registerForRemoteNotifications()
        }
        if preferences.liveActivitiesEnabled { await register() }
    }

    func refreshAuthorization() async {
        authorization = await UNUserNotificationCenter.current().notificationSettings().authorizationStatus
    }

    func savePreferences() async {
        guard let preferenceKey, appModel != nil else { return }
        let epoch = generation
        errorMessage = nil
        if preferences.notificationsEnabled {
            do {
                let allowed = try await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge])
                guard generation == epoch else { return }
                await refreshAuthorization()
                if !allowed { preferences.notificationsEnabled = false; errorMessage = "Notifications are disabled in system settings." }
            } catch { errorMessage = error.localizedDescription; return }
        }
        guard generation == epoch else { return }
        if let data = try? JSONEncoder().encode(preferences) { UserDefaults.standard.set(data, forKey: preferenceKey) }
        if preferences.notificationsEnabled { UIApplication.shared.registerForRemoteNotifications() }
        await register()
    }

    func received(token data: Data) {
        token = data.map { String(format: "%02x", $0) }.joined()
        Task { await register() }
    }

    func register(configureActivity: Bool = true) async {
        let epoch = generation
        if configureActivity { needsActivityConfiguration = true }
        do {
            if try await submitRegistration(), needsActivityConfiguration { await configureActivities() }
        } catch is CancellationError {} catch { if generation == epoch { errorMessage = error.localizedDescription } }
    }

    @discardableResult private func submitRegistration(reset: Bool = false) async throws -> Bool {
        guard let appModel, let connect = appModel.connect, appModel.authenticationState == .signedIn else { throw CancellationError() }
        let epoch = generation
        var currentPreferences = preferences
        #if os(visionOS)
        currentPreferences.liveActivitiesEnabled = false
        #endif
        var fields: [String: JSONValue] = [
            "deviceId": .string(deviceID), "label": .string(UIDevice.current.model),
            "iosMajorVersion": .number(Double(ProcessInfo.processInfo.operatingSystemVersion.majorVersion)),
            "bundleId": .string(Bundle.main.bundleIdentifier ?? "com.spiritdevs.pathway"),
            "apsEnvironment": .string(Bundle.main.object(forInfoDictionaryKey: "PATHWAY_APS_ENVIRONMENT") as? String == "development" ? "sandbox" : "production"),
            "preferences": try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(currentPreferences))
        ]
        #if os(visionOS)
        fields["platform"] = .string("visionos")
        #else
        fields["platform"] = .string("ios")
        if let pushToStartToken { fields["pushToStartToken"] = .string(pushToStartToken) }
        #endif
        if let token { fields["pushToken"] = .string(token) }
        registering = true
        defer { if generation == epoch { registering = registrationWriter.isBusy } }
        do {
            let latest = try await registrationWriter.submit(.object(fields), reset: reset) { [weak self] payload, reset in
                guard let self, generation == epoch else { throw CancellationError() }
                if reset {
                    _ = try await connect.relayRequest(method: "DELETE", path: "/v1/mobile/devices/\(deviceID)")
                    guard generation == epoch else { throw CancellationError() }
                }
                _ = try await connect.relayRequest(method: "POST", path: "/v1/mobile/devices", payload: payload)
            }
            guard generation == epoch else { throw CancellationError() }
            if latest {
                registered = true; errorMessage = nil
                if needsActivityConfiguration { Task { await configureActivities() } }
            }
            return latest
        } catch {
            if generation == epoch { registered = false; errorMessage = error.localizedDescription }
            throw error
        }
    }

    private func configureActivities() async {
        #if os(iOS)
        if let activityConfigurationTask { await activityConfigurationTask.value; return }
        let epoch = generation
        let task = Task { [weak self] in
            guard let self else { return }
            defer { activityConfigurationTask = nil }
            while needsActivityConfiguration, generation == epoch {
                needsActivityConfiguration = false
                guard let preferenceKey, let connect = appModel?.connect else { return }
                await PathwayLiveActivities.shared.configure(accountKey: preferenceKey, deviceID: deviceID,
                    connect: connect, enabled: preferences.liveActivitiesEnabled,
                    onPushToStartToken: { [weak self] token in
                        guard let self, generation == epoch else { throw CancellationError() }
                        pushToStartToken = token
                        try await submitRegistration()
                    }, onActivityEnded: { [weak self] in
                        guard let self, generation == epoch else { throw CancellationError() }
                        pushToStartToken = nil
                        try await submitRegistration(reset: true)
                    })
            }
        }
        activityConfigurationTask = task
        await task.value
        #else
        needsActivityConfiguration = false
        #endif
    }

    func stop() async {
        let connect = appModel?.connect
        let drain = registrationWriter.fence()
        generation += 1
        let activityConfiguration = activityConfigurationTask
        clearLocalState()
        await drain?.value
        await activityConfiguration?.value
        await activityStopTask?.value
        #if os(iOS)
        await PathwayLiveActivities.shared.stop()
        #endif
        if let connect { _ = try? await connect.relayRequest(method: "DELETE", path: "/v1/mobile/devices/\(deviceID)") }
    }

    func clearLocalRegistration() {
        let connect = appModel?.connect
        let drain = registrationWriter.fence()
        generation += 1
        let activityConfiguration = activityConfigurationTask
        let previousStop = activityStopTask
        clearLocalState()
        activityStopTask = Task {
            await previousStop?.value
            await drain?.value
            await activityConfiguration?.value
            #if os(iOS)
            await PathwayLiveActivities.shared.stop()
            #endif
            if let connect { _ = try? await connect.relayRequest(method: "DELETE", path: "/v1/mobile/devices/\(deviceID)") }
        }
    }

    private func clearLocalState() {
        appModel = nil; preferenceKey = nil; registered = false; registering = false
        preferences = .init(); errorMessage = nil
        pushToStartToken = nil; needsActivityConfiguration = false
        UIApplication.shared.unregisterForRemoteNotifications()
        UNUserNotificationCenter.current().removeAllDeliveredNotifications()
    }

    func foreground() async {
        await refreshAuthorization()
        guard appModel?.authenticationState == .signedIn else { return }
        if preferences.notificationsEnabled { UIApplication.shared.registerForRemoteNotifications() }
        #if os(iOS)
        if preferences.liveActivitiesEnabled { await PathwayLiveActivities.shared.refresh() }
        #endif
    }
}

final class PathwayNotificationDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    @MainActor var onOpenThread: ((PathwayProductLink) -> Void)?
    @MainActor var onOpenStorage: ((PathwayStorageNotificationDestination) -> Void)?
    @MainActor var pendingStorage: PathwayStorageNotificationDestination?
    @MainActor var pendingLink: PathwayProductLink?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        Task { @MainActor in PathwayNotifications.shared.received(token: deviceToken) }
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: any Error) {
        Task { @MainActor in PathwayNotifications.shared.errorMessage = error.localizedDescription }
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions { [.banner, .sound, .list] }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        if let storage = PathwayStorageNotificationDestination(notification: response.notification.request.content.userInfo) {
            await MainActor.run {
                if let onOpenStorage { onOpenStorage(storage) } else { pendingStorage = storage }
            }
            return
        }
        guard let link = PathwayProductLink(notification: response.notification.request.content.userInfo) else { return }
        await MainActor.run {
            if let onOpenThread { onOpenThread(link) } else { pendingLink = link }
        }
    }
}
