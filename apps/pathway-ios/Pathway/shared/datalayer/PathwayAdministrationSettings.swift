import Foundation

struct PathwayAdministrationSettingsDraft {
    private let original: [String: JSONValue]
    var updateChecks: Bool
    var workspaceMode: String
    var startFromOrigin: Bool
    var baseDirectory: String
    var textModel: JSONValue
    var compactionModel: JSONValue
    var writerModel: JSONValue
    var writingMode: String
    var writingInstructions: String
    var followTemplates: Bool
    var backgroundProfile: String
    var gitFetchSeconds: Double
    var providerHealthSeconds: Double
    private(set) var hostOverrides: [String: JSONValue] = [:]

    init(_ settings: JSONValue) {
        let fields = settings.objectValue ?? [:]
        original = fields
        updateChecks = fields["enableProviderUpdateChecks"]?.boolValue ?? true
        workspaceMode = fields["defaultThreadEnvMode"]?.stringValue ?? "local"
        startFromOrigin = fields["newWorktreesStartFromOrigin"]?.boolValue ?? true
        baseDirectory = fields["addProjectBaseDirectory"]?.stringValue ?? ""
        textModel = fields["textGenerationModelSelection"] ?? .null
        compactionModel = fields["contextCompactionModelSelection"] ?? .null
        writerModel = fields["sourceControlWriterModelSelection"] ?? .null
        let style = fields["sourceControlWritingStyle"]?.objectValue ?? [:]
        writingMode = style["mode"]?.stringValue ?? "repo_conventions"
        writingInstructions = style["customInstructions"]?.stringValue ?? ""
        followTemplates = style["followChangeRequestTemplates"]?.boolValue ?? true
        let background = fields["backgroundActivity"]?.objectValue ?? [:]
        backgroundProfile = background["profile"]?.stringValue ?? "balanced"
        let base = backgroundProfile == "custom" ? background["baseProfile"]?.stringValue ?? "balanced" : backgroundProfile
        let overrides = backgroundProfile == "custom" ? background["overrides"]?.objectValue ?? [:] : [:]
        gitFetchSeconds = Self.milliseconds(overrides["automaticGitFetchInterval"]) ?? Self.fetchSeconds(base)
        providerHealthSeconds = Self.milliseconds(overrides["providerHealthRefreshInterval"]) ?? Self.healthSeconds(base)
    }

    private static func milliseconds(_ value: JSONValue?) -> Double? {
        if case let .number(value) = value { return value / 1000 }; return nil
    }

    static func fetchSeconds(_ profile: String) -> Double { profile == "battery-saver" ? 0 : profile == "performance" ? 15 : 30 }
    static func healthSeconds(_ profile: String) -> Double { profile == "battery-saver" ? 900 : profile == "performance" ? 60 : 300 }
    var hasChanges: Bool {
        guard let fields = try? patch() else { return true }; return !fields.isEmpty
    }

    mutating func selectBackgroundProfile(_ profile: String) {
        backgroundProfile = profile
        hostOverrides = [:]
        if profile != "custom" {
            gitFetchSeconds = Self.fetchSeconds(profile)
            providerHealthSeconds = Self.healthSeconds(profile)
        }
    }

    func hostValue(_ field: PathwayBackgroundHostField) -> JSONValue {
        if let edited = hostOverrides[field.rawValue] { return edited }
        let background = original["backgroundActivity"]?.objectValue ?? [:]
        let originalProfile = background["profile"]?.stringValue ?? "balanced"
        if backgroundProfile == "custom" && backgroundProfile == originalProfile,
           let value = background["overrides"]?.objectValue?[field.rawValue] { return value }
        let base = backgroundProfile == "custom" ? background["baseProfile"]?.stringValue ?? "balanced" : backgroundProfile
        return field.defaultValue(profile: base)
    }

    mutating func setHostValue(_ field: PathwayBackgroundHostField, value: JSONValue) {
        hostOverrides[field.rawValue] = value
    }

    func patch(latest: JSONValue? = nil) throws -> [String: JSONValue] {
        guard ["local", "worktree"].contains(workspaceMode),
              ["repo_conventions", "conventional_commits", "custom"].contains(writingMode),
              ["balanced", "performance", "battery-saver", "custom"].contains(backgroundProfile),
              gitFetchSeconds.isFinite && gitFetchSeconds >= 0,
              providerHealthSeconds.isFinite && providerHealthSeconds >= 0 else { throw PathwayAdministrationSettingsError.invalidValue }
        let baseline = Self(.object(original))
        var result: [String: JSONValue] = [:]
        func changed(_ key: String, _ value: JSONValue, _ old: JSONValue) {
            if value != old { result[key] = value }
        }
        changed("enableProviderUpdateChecks", .bool(updateChecks), .bool(baseline.updateChecks))
        changed("defaultThreadEnvMode", .string(workspaceMode), .string(baseline.workspaceMode))
        changed("newWorktreesStartFromOrigin", .bool(startFromOrigin), .bool(baseline.startFromOrigin))
        changed("addProjectBaseDirectory", .string(baseDirectory.trimmingCharacters(in: .whitespacesAndNewlines)), .string(baseline.baseDirectory))
        for (key, value, old) in [("textGenerationModelSelection", textModel, baseline.textModel), ("contextCompactionModelSelection", compactionModel, baseline.compactionModel), ("sourceControlWriterModelSelection", writerModel, baseline.writerModel)] where value != old {
            if value == .null && key != "sourceControlWriterModelSelection" { throw PathwayAdministrationSettingsError.invalidModel }
            if value != .null {
                guard let fields = value.objectValue, fields["instanceId"]?.stringValue?.isEmpty == false,
                      fields["model"]?.stringValue?.isEmpty == false else { throw PathwayAdministrationSettingsError.invalidModel }
            }
            result[key] = value
        }
        var style: [String: JSONValue] = [:]
        if writingMode != baseline.writingMode { style["mode"] = .string(writingMode) }
        let instructions = writingInstructions.trimmingCharacters(in: .whitespacesAndNewlines)
        if instructions != baseline.writingInstructions { style["customInstructions"] = .string(instructions) }
        if followTemplates != baseline.followTemplates { style["followChangeRequestTemplates"] = .bool(followTemplates) }
        if !style.isEmpty { result["sourceControlWritingStyle"] = .object(style) }
        // The legacy interval leaves are deliberately supported by the server's merge
        // contract: they preserve all current host-power and idle-client overrides.
        if backgroundProfile != baseline.backgroundProfile && backgroundProfile != "custom" {
            result["backgroundActivityProfile"] = .string(backgroundProfile)
            if gitFetchSeconds != Self.fetchSeconds(backgroundProfile) { result["automaticGitFetchInterval"] = .number(gitFetchSeconds * 1000) }
            if providerHealthSeconds != Self.healthSeconds(backgroundProfile) { result["providerHealthRefreshInterval"] = .number(providerHealthSeconds * 1000) }
        } else {
            if gitFetchSeconds != baseline.gitFetchSeconds { result["automaticGitFetchInterval"] = .number(gitFetchSeconds * 1000) }
            if providerHealthSeconds != baseline.providerHealthSeconds { result["providerHealthRefreshInterval"] = .number(providerHealthSeconds * 1000) }
        }
        if !hostOverrides.isEmpty {
            // Unlike scalar settings, the override map is replacement-shaped. Merge
            // edits into a fresh server snapshot, retaining all untouched entries.
            let latestFields = latest?.objectValue ?? original
            let latestBackground = latestFields["backgroundActivity"]?.objectValue ?? [:]
            let latestProfile = latestBackground["profile"]?.stringValue ?? "balanced"
            let changedPreset = backgroundProfile != baseline.backgroundProfile && backgroundProfile != "custom"
            let base = changedPreset ? backgroundProfile : latestProfile == "custom" ? latestBackground["baseProfile"]?.stringValue ?? "balanced" : latestProfile
            var overrides = !changedPreset && latestProfile == "custom" ? latestBackground["overrides"]?.objectValue ?? [:] : [:]
            for (key, value) in hostOverrides {
                if case let .number(number) = value, !number.isFinite || number < 0 { throw PathwayAdministrationSettingsError.invalidValue }
                overrides[key] = value
            }
            if gitFetchSeconds != baseline.gitFetchSeconds && (!changedPreset || gitFetchSeconds != Self.fetchSeconds(base)) {
                overrides["automaticGitFetchInterval"] = .number(gitFetchSeconds * 1000)
            }
            if providerHealthSeconds != baseline.providerHealthSeconds && (!changedPreset || providerHealthSeconds != Self.healthSeconds(base)) {
                overrides["providerHealthRefreshInterval"] = .number(providerHealthSeconds * 1000)
            }
            result.removeValue(forKey: "backgroundActivityProfile")
            result.removeValue(forKey: "automaticGitFetchInterval")
            result.removeValue(forKey: "providerHealthRefreshInterval")
            result["backgroundActivity"] = .object(["schemaVersion": .number(1), "profile": .string("custom"), "baseProfile": .string(base), "overrides": .object(overrides)])
        }
        return result
    }
}

enum PathwayBackgroundHostField: String, CaseIterable, Identifiable {
    case activeInterval = "hostPowerMonitorActiveInterval"
    case idleInterval = "hostPowerMonitorIdleInterval"
    case clientTTL = "idleClientTtl"
    case locked = "pauseWhenHostLocked"
    case hostLowPower = "pauseWhenHostLowPower"
    case clientLowPower = "pauseWhenClientLowPower"
    case battery = "pauseWhenOnBattery"
    var id: String { rawValue }
    var isInterval: Bool { self == .activeInterval || self == .idleInterval || self == .clientTTL }
    var title: String {
        switch self {
        case .activeInterval: "Active host monitor (seconds)"
        case .idleInterval: "Idle host monitor (seconds)"
        case .clientTTL: "Idle client expiry (seconds)"
        case .locked: "Pause when host is locked"
        case .hostLowPower: "Pause in host low-power mode"
        case .clientLowPower: "Pause in client low-power mode"
        case .battery: "Pause when host uses battery"
        }
    }
    func defaultValue(profile: String) -> JSONValue {
        switch self {
        case .activeInterval: .number(profile == "battery-saver" ? 60_000 : 30_000)
        case .idleInterval: .number(profile == "performance" ? 120_000 : profile == "battery-saver" ? 600_000 : 300_000)
        case .clientTTL: .number(45_000)
        case .locked: .bool(true)
        case .hostLowPower, .clientLowPower: .bool(profile != "performance")
        case .battery: .bool(profile == "battery-saver")
        }
    }
}

enum PathwayAdministrationSettingsError: LocalizedError {
    case invalidValue, invalidModel
    var errorDescription: String? {
        switch self {
        case .invalidValue: "Choose valid settings and nonnegative refresh intervals."
        case .invalidModel: "Choose a provider and model before saving."
        }
    }
}

struct PathwaySourceControlDiscovery: Decodable {
    let versionControlSystems: [Item]
    let sourceControlProviders: [Item]
    struct Item: Decodable, Identifiable {
        let kind: String
        let label: String
        let executable: String?
        let status: String
        let implemented: Bool?
        let version: JSONValue?
        let installHint: String
        let detail: JSONValue?
        let auth: Auth?
        var id: String { kind }
    }
    struct Auth: Decodable {
        let status: String
        let account: JSONValue?
        let host: JSONValue?
        let detail: JSONValue?
    }
    static func option(_ value: JSONValue?) -> String? {
        let fields = value?.objectValue
        return fields?["_tag"] == .string("Some") ? fields?["value"]?.stringValue : nil
    }
}
