import SwiftUI

@MainActor
struct SettingsDeviceView: View {
    let preferences: SettingsDevicePreferences
    let openNotificationSettings: () -> Void

    var body: some View {
        Form {
            Section {
                Picker("Appearance", selection: appearanceBinding) {
                    SettingsIconLabel("System", systemName: "circle.lefthalf.filled", color: .blue)
                        .tag(SettingsAppearancePreference.system)
                    SettingsIconLabel("Light", systemName: "sun.max", color: .orange)
                        .tag(SettingsAppearancePreference.light)
                    SettingsIconLabel("Dark", systemName: "moon", color: .indigo)
                        .tag(SettingsAppearancePreference.dark)
                }
                .pickerStyle(.inline)
                .labelsHidden()
            } header: {
                Text("Appearance")
            } footer: {
                Text("System automatically matches your device's appearance.")
            }

            Section {
                LabeledContent("Language", value: "Follows System")
            } header: {
                Text("App Language")
            } footer: {
                Text("Pathway follows your device language. Additional app languages will appear here after their translations are bundled.")
            }

            Section {
                LabeledContent("Text Size", value: "Follows System")
            } header: {
                Text("Accessibility")
            } footer: {
                Text("Pathway follows the text size and accessibility settings configured on this device.")
            }

            Section {
                Button(action: openNotificationSettings) {
                    HStack {
                        SettingsIconLabel("Open Notification Settings", systemName: "bell.badge", color: .red)
                        Spacer()
                        Image(systemName: "arrow.up.forward.app")
                            .foregroundStyle(.secondary)
                            .accessibilityHidden(true)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityHint("Opens Pathway notification permissions in the Settings app")
            } header: {
                Text("Notifications")
            } footer: {
                Text("Notification permissions are controlled by iOS.")
            }

            Section {
                SettingsIconLabel("Protected by your device", systemName: "faceid", color: .green)
            } header: {
                Text("Device Authentication")
            } footer: {
                Text("When Pathway needs to confirm a sensitive action, it can ask iOS to verify you with Face ID, Touch ID, or your device passcode. Pathway cannot change these device security settings.")
            }
        }
        .formStyle(.grouped)
        .navigationTitle("Device Settings")
        .navigationBarTitleDisplayMode(.inline)
    }

    private var appearanceBinding: Binding<SettingsAppearancePreference> {
        Binding(
            get: { preferences.appearance },
            set: { preferences.setAppearance($0) }
        )
    }
}
