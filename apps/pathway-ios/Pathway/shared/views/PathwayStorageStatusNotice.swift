import SwiftUI
import UserNotifications

/// A small persistent entry point outside Settings; polling pauses with the app.
struct PathwayStorageStatusNotice: View {
    @Environment(PathwayAppModel.self) private var appModel
    @Environment(\.scenePhase) private var scenePhase
    @State private var pressures: [String: String] = [:]
    @State private var showsStorage = false
    @State private var notice: String?
    @State private var stale: Set<String> = []

    private var low: [PathwayCompanyEnvironment] {
        appModel.cloud.environments.filter { pressures[$0.id] == "critical" || pressures[$0.id] == "warning" }
    }

    var body: some View {
        Group {
            if !low.isEmpty || notice != nil {
                HStack {
                    Button {
                        showsStorage = true
                        notice = nil
                    } label: {
                        Label(notice ?? "\(low.contains { stale.contains($0.id) } ? "Last known low storage" : "Low storage"): \(low.map { $0.environment.label }.joined(separator: ", "))", systemImage: "externaldrive.badge.exclamationmark")
                            .font(.caption).lineLimit(2)
                    }
                    Spacer()
                    if notice != nil { Button("Dismiss") { notice = nil }.font(.caption) }
                }
                .foregroundStyle(low.isEmpty ? Color.secondary : .orange)
                .padding(.horizontal, 16).padding(.vertical, 6)
                .background(.background)
            }
        }
        .task(id: "\(scenePhase):\(appModel.localStorageDirectory?.path ?? ""):\(appModel.cloud.environments.map(\.id).joined())") {
            guard let account = appModel.localStorageDirectory?.lastPathComponent else {
                pressures = [:]; stale = []; notice = nil
                return
            }
            pressures = PathwayStoragePressureCache.restore(account: account,
                environments: appModel.cloud.environments.map { ($0.id, $0.environment.environmentId) })
            stale = Set(pressures.keys)
            notice = nil
            guard scenePhase == .active, let connect = appModel.connect else { return }
            while !Task.isCancelled {
                var seen = Set<String>()
                for environment in appModel.cloud.environments {
                    guard !Task.isCancelled, seen.insert(environment.environment.environmentId).inserted else { continue }
                    do {
                        let value = try await PathwayEnvironmentStorageModel.request(environment: environment, connect: connect, method: "server.getHostResources")
                        guard !Task.isCancelled else { return }
                        let resources = try JSONDecoder().decode(PathwayHostResources.self, from: JSONEncoder().encode(value))
                        guard let pressure = resources.storagePressure, ["healthy", "warning", "critical"].contains(pressure),
                              let storageAt = resources.storageSampledAt, storageAt.isFinite,
                              resources.sampledAt - storageAt >= -5_000, resources.sampledAt - storageAt <= 90_000 else {
                            stale.insert(environment.id)
                            continue
                        }
                        stale.remove(environment.id)
                        let key = PathwayStoragePressureCache.key(account: account, environmentID: environment.environment.environmentId)
                        let previous = UserDefaults.standard.string(forKey: key)
                        pressures[environment.id] = pressure
                        guard previous != pressure else { continue }
                        UserDefaults.standard.set(pressure, forKey: key)
                        guard pressure != "healthy" || previous == "warning" || previous == "critical" else { continue }
                        let title = pressure == "healthy" ? "\(environment.environment.label) has recovered storage space" : "\(environment.environment.label) is \(pressure == "critical" ? "critically low" : "low") on storage"
                        notice = title
                        if PathwayNotifications.shared.preferences.notificationsEnabled,
                           await UNUserNotificationCenter.current().notificationSettings().authorizationStatus == .authorized {
                            let content = UNMutableNotificationContent()
                            content.userInfo = PathwayStorageNotificationDestination(account: account,
                                environmentID: environment.environment.environmentId).userInfo
                            content.title = title
                            content.body = "Open Storage & cleanup to review capacity. Emergency cleanup runs only when you request it."
                            try? await UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: key, content: content, trigger: nil))
                        }
                    } catch {
                        guard !Task.isCancelled else { return }
                        stale.insert(environment.id)
                    }
                }
                do { try await Task.sleep(for: .seconds(60)) } catch { return }
            }
        }
        .sheet(isPresented: $showsStorage) {
            NavigationStack {
                PathwayEnvironmentStorageView()
                    .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { showsStorage = false } } }
            }
        }
    }
}

/// Persisted readings are display-only until a fresh telemetry response arrives.
enum PathwayStoragePressureCache {
    static func key(account: String, environmentID: String) -> String {
        "pathway.storagePressure.\(account).\(environmentID)"
    }

    static func restore(account: String, environments: [(id: String, environmentID: String)],
                        defaults: UserDefaults = .standard) -> [String: String] {
        var pressures: [String: String] = [:]
        for environment in environments {
            if let pressure = defaults.string(forKey: key(account: account, environmentID: environment.environmentID)),
               ["healthy", "warning", "critical"].contains(pressure) {
                pressures[environment.id] = pressure
            }
        }
        return pressures
    }
}
