import Foundation
import Observation
import SwiftUI

@MainActor @Observable final class PathwayGeneralPreferences {
    static let shared = PathwayGeneralPreferences()
    var activeTurnSendMode: String { didSet { defaults.set(activeTurnSendMode, forKey: "pathway.native.activeTurnSendMode") } }
    var autoSettleDays: Int { didSet { defaults.set(autoSettleDays, forKey: "pathway.native.autoSettleDays") } }
    var absoluteTimestamps: Bool { didSet { defaults.set(absoluteTimestamps, forKey: "pathway.native.absoluteTimestamps") } }
    var ignoreDiffWhitespace: Bool { didSet { defaults.set(ignoreDiffWhitespace, forKey: "pathway.native.ignoreDiffWhitespace") } }
    private let defaults: UserDefaults
    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        activeTurnSendMode = defaults.string(forKey: "pathway.native.activeTurnSendMode") == "steer" ? "steer" : "queue"
        let days = defaults.object(forKey: "pathway.native.autoSettleDays") as? Int ?? 3
        autoSettleDays = [0, 1, 3, 7, 14, 30].contains(days) ? days : 3
        absoluteTimestamps = defaults.bool(forKey: "pathway.native.absoluteTimestamps")
        ignoreDiffWhitespace = defaults.object(forKey: "pathway.native.ignoreDiffWhitespace") as? Bool ?? true
    }
}

struct PathwayGeneralSettingsView: View {
    @State private var preferences = PathwayGeneralPreferences.shared
    var body: some View {
        Form {
            Section("Files") { NavigationLink("Assets") { PathwayAssetsSettingsView() } }
            Section("Conversations") {
                Picker("Send while an agent is running", selection: $preferences.activeTurnSendMode) {
                    Text("Queue for the next turn").tag("queue")
                    Text("Steer the active turn").tag("steer")
                }
                Text("Touch and hold Send to choose either action for an individual message.").font(.footnote).foregroundStyle(.secondary)
            }
            Section("Thread list") {
                Picker("Settle inactive threads after", selection: $preferences.autoSettleDays) {
                    Text("Never").tag(0)
                    ForEach([1, 3, 7, 14, 30], id: \.self) { Text("\($0) days").tag($0) }
                }
                Toggle("Show exact dates and times", isOn: $preferences.absoluteTimestamps)
            }
            Section("Review") { Toggle("Ignore whitespace in current diffs", isOn: $preferences.ignoreDiffWhitespace) }
            Section { Text("These preferences apply on this device. Environment settings control provider tools and background work.").font(.footnote).foregroundStyle(.secondary) }
        }.navigationTitle("General")
    }
}
