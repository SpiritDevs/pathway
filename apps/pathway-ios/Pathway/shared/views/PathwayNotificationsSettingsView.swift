import SwiftUI

struct PathwayNotificationsSettingsView: View {
    @State private var notifications = PathwayNotifications.shared
    var body: some View {
        Form {
            Section {
                Toggle("Agent notifications", isOn: $notifications.preferences.notificationsEnabled)
                Toggle("Approval needed", isOn: $notifications.preferences.notifyOnApproval)
                Toggle("Answer needed", isOn: $notifications.preferences.notifyOnInput)
                Toggle("Completed", isOn: $notifications.preferences.notifyOnCompletion)
                Toggle("Failed", isOn: $notifications.preferences.notifyOnFailure)
                #if os(iOS)
                Toggle("Live Activities", isOn: $notifications.preferences.liveActivitiesEnabled)
                #endif
            } footer: { Text("Notification preferences apply to this device and account.") }
            Section {
                Button("Save preferences") { Task { await notifications.savePreferences() } }.disabled(notifications.registering)
                if notifications.registering { ProgressView("Registering this device…") }
                if notifications.registered { Label("Device registered", systemImage: "checkmark.circle") }
                if let error = notifications.errorMessage { Text(error).foregroundStyle(.red) }
                #if os(iOS)
                if let error = PathwayLiveActivities.shared.errorMessage { Text(error).foregroundStyle(.red) }
                #endif
                if notifications.authorization == .denied {
                    Link("Open system settings", destination: URL(string: UIApplication.openSettingsURLString)!)
                }
            }
        }
        .navigationTitle("Notifications")
        .task { await notifications.refreshAuthorization() }
    }
}
