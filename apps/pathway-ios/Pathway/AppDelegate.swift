import OSLog
import UIKit
import UserNotifications

@MainActor
final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    private let logger = Logger(subsystem: Bundle.main.bundleIdentifier ?? "Pathway", category: "notifications")
    private weak var appModel: PathwayAppModel?
    private var latestDeviceToken: String?
    private var pendingAdminAuthorizationRequestID: String?

    func connect(to appModel: PathwayAppModel) {
        self.appModel = appModel
        if let latestDeviceToken {
            appModel.didRegisterForRemoteNotifications(deviceToken: latestDeviceToken)
        }
        if let pendingAdminAuthorizationRequestID {
            self.pendingAdminAuthorizationRequestID = nil
            appModel.handleAdminAuthorizationNotification(requestID: pendingAdminAuthorizationRequestID)
        }
    }

    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
    ) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        if
            let payload = launchOptions?[.remoteNotification] as? [AnyHashable: Any],
            let requestID = payload["adminAuthorizationRequestId"] as? String
        {
            pendingAdminAuthorizationRequestID = requestID
        }
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        let token = deviceToken.apnsTokenString
        latestDeviceToken = token
        appModel?.didRegisterForRemoteNotifications(deviceToken: token)
        logger.info("Registered for remote notifications with token suffix: \(token.suffix(6), privacy: .private)")
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        logger.error("Failed to register for remote notifications: \(error.localizedDescription, privacy: .public)")
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        if notification.request.content.userInfo["adminAuthorizationRequestId"] is String {
            // The authenticated Convex subscription presents the in-app approval sheet.
            return []
        }
        return [.banner, .list, .sound]
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse
    ) async {
        guard
            let requestID = response.notification.request.content.userInfo["adminAuthorizationRequestId"] as? String
        else { return }

        await routeAdminAuthorizationNotification(requestID: requestID)
    }

    private func routeAdminAuthorizationNotification(requestID: String) {
        guard let appModel else {
            pendingAdminAuthorizationRequestID = requestID
            return
        }
        appModel.handleAdminAuthorizationNotification(requestID: requestID)
    }
}

extension Data {
    var apnsTokenString: String {
        map { String(format: "%02.2hhx", $0) }.joined()
    }
}
