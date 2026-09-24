import Foundation

/// What a Computer approval card is asking for, recovered from the prompt the
/// server writes with `computerApprovalCardText`. The approval item carries no
/// structured scope, so this parser and that function must stay in step.
enum PathwayComputerApprovalPrompt: Equatable, Sendable {
    /// Consent for Computer for the rest of this turn.
    case task
    /// Consent to drive one more app in this turn.
    case app(String)
    /// One supervised action; `args` are the display-safe call arguments, when they parse.
    case call(toolName: String, args: [String: JSONValue]?)

    static let taskPrompt = "Allow Computer for this task"
    private static let appPrefix = "Allow Computer to use "
    private static let appSuffix = " in this task"
    private static let callPrefix = "Computer action needs approval: "

    /// Reads a Computer approval prompt; nil for anything else, including other request kinds.
    init?(requestKind: String?, detail: String?) {
        guard requestKind == "computer",
              let prompt = detail?.trimmingCharacters(in: .whitespacesAndNewlines), !prompt.isEmpty else { return nil }
        if prompt == Self.taskPrompt { self = .task; return }
        if prompt.count > Self.appPrefix.count + Self.appSuffix.count,
           prompt.hasPrefix(Self.appPrefix), prompt.hasSuffix(Self.appSuffix) {
            let app = prompt.dropFirst(Self.appPrefix.count).dropLast(Self.appSuffix.count)
                .trimmingCharacters(in: .whitespacesAndNewlines)
            if !app.isEmpty { self = .app(app); return }
        }
        guard prompt.hasPrefix(Self.callPrefix) else { return nil }
        let call = prompt.dropFirst(Self.callPrefix.count).trimmingCharacters(in: .whitespacesAndNewlines)
        let space = call.firstIndex(of: " ")
        let toolName = String(space.map { call[..<$0] } ?? Substring(call))
        guard !toolName.isEmpty else { return nil }
        let args = space.flatMap { index in
            (try? JSONDecoder().decode(JSONValue.self, from: Data(call[call.index(after: index)...].utf8)))?.objectValue
        }
        self = .call(toolName: toolName, args: args)
    }

    init?(_ item: PathwayTimelineItem) {
        self.init(requestKind: item.requestKind, detail: item.fields["prompt"]?.stringValue ?? item.text)
    }

    var title: String {
        switch self {
        case .task: "Allow Computer for this task?"
        case .app(let app): "Allow Computer to use \(app) in this task?"
        case .call: "Approve this Computer action?"
        }
    }

    /// The accept button; decline and cancel keep their usual labels.
    var acceptLabel: String {
        switch self {
        case .task: "Allow for this task"
        case .app(let app): "Allow \(app) for this task"
        case .call: "Approve once"
        }
    }

    static let taskAcceptDescription = "Continue routine desktop actions until this response ends. Stop cancels access. Clipboard reads still ask separately."
}

/// A Computer notice the transcript shows as its own card rather than a tool row:
/// the host needs setup, or the chat's Computer control is off.
enum PathwayComputerNotice: Equatable, Sendable {
    /// `missing` is empty when the host refused without naming a grant.
    case setupRequired(missing: [String])
    case controlDenied(toolName: String?)

    static let setupRequiredTool = "computer_setup_required"
    static let controlDeniedTool = "computer_capability_denied"
    private static let permissionLabels = [
        ("accessibility", "Accessibility"), ("screenRecording", "Screen Recording"), ("inputMonitoring", "Input Monitoring")
    ]

    init?(_ item: PathwayTimelineItem) {
        guard item.type == "dynamic_tool" else { return nil }
        let input = item.fields["input"]?.objectValue
        switch item.fields["toolName"]?.stringValue {
        case Self.setupRequiredTool:
            self = .setupRequired(missing: input?["missing"]?.arrayValue?.compactMap(\.stringValue) ?? [])
        case Self.controlDeniedTool:
            let tool = input?["toolName"]?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines)
            self = .controlDenied(toolName: tool?.isEmpty == false ? tool : nil)
        default:
            return nil
        }
    }

    /// "Accessibility", or "Accessibility and Screen Recording", in the host's setup order.
    static func permissionList(_ missing: [String]) -> String {
        let labels = permissionLabels.filter { missing.contains($0.0) }.map(\.1)
        guard let last = labels.last else { return "" }
        return labels.count == 1 ? last : "\(labels.dropLast().joined(separator: ", ")) and \(last)"
    }

    static let accessDeniedHint = "This device isn't allowed to use Computer on this environment. Re-pair it with “Use Computer” enabled, or ask an admin to change the Computer access policy in Settings."
}

/// How one user send asks for Computer: not at all, for this request (a leading
/// `/computer-use`), or for the whole chat (the Computer control setting).
enum PathwayComputerInvocation: String, Equatable, Sendable {
    case off, request, chat

    static let slashCommand = "computer-use"

    /// The prompt after a leading `/computer-use`, or nil when the text does not start with one.
    /// Four spaces or a tab are Markdown code indentation, not a command.
    static func prompt(in text: String) -> String? {
        let scalars = Array(text.unicodeScalars)
        var index = 0
        while index < scalars.count, index < 3, scalars[index] == " " { index += 1 }
        let command = Array("/computer-use".unicodeScalars)
        guard scalars.count >= index + command.count,
              zip(scalars[index...], command).allSatisfy({ $0.0.isASCII && String($0.0).lowercased() == String($0.1) }) else { return nil }
        let rest = scalars[(index + command.count)...]
        guard let first = rest.first else { return "" }
        guard [" ", "\t", "\r", "\n"].contains(first) else { return nil }
        var tail = String.UnicodeScalarView(); tail.append(contentsOf: rest)
        return String(tail).trimmingCharacters(in: .whitespacesAndNewlines)
    }

    init(text: String, controlEnabled: Bool) {
        self = controlEnabled ? .chat : Self.prompt(in: text) == nil ? .off : .request
    }

    /// The Computer fields one send carries. `enableComputerControl` goes only with the
    /// setting, because sending it with a `/computer-use` request would widen it to the chat.
    /// The generation pins the intent to the control epoch it was made in.
    static func fields(text: String, controlEnabled: Bool, generation: Int?) -> [String: JSONValue] {
        guard Self(text: text, controlEnabled: controlEnabled) != .off else { return [:] }
        var fields: [String: JSONValue] = ["computerControlGeneration": .number(Double(generation ?? 0))]
        if controlEnabled { fields["enableComputerControl"] = .bool(true) }
        return fields
    }
}

/// Environment-level Computer rules shared by the composer, transcript and Settings.
enum PathwayComputerAccess {
    /// Hosts with a Computer backend.
    static let platforms: Set<String> = ["darwin", "linux"]
    static let accessPolicies = ["any-operator", "scoped", "admins-only"]
    static let autonomyLevels = ["supervised", "per-task", "auto", "full-access"]

    /// ADR 0041, as the server checks it.
    static func canUse(policy: String, scopes: Set<String>) -> Bool {
        switch policy {
        case "any-operator": scopes.contains("orchestration:operate")
        case "admins-only": scopes.contains("access:write")
        default: scopes.contains("computer:operate") || scopes.contains("access:write")
        }
    }

    /// Whether a server config names a host that can drive a desktop.
    static func supportsComputer(serverConfig: [String: JSONValue]) -> Bool {
        let os = serverConfig["environment"]?.objectValue?["platform"]?.objectValue?["os"]?.stringValue
        return os.map(platforms.contains) ?? false
    }

    static func capability(_ name: String, in serverConfig: [String: JSONValue]) -> Bool {
        serverConfig["environment"]?.objectValue?["capabilities"]?.objectValue?[name]?.boolValue == true
    }
}

/// The gateway's Computer tools and the verb each performs, as the web client names them.
enum PathwayComputerTool {
    static let titles: [String: String] = [
        "computer_screenshot": "Take a screenshot", "computer_get_state": "Read the screen",
        "computer_get_screen_size": "Measure the screen", "computer_list_windows": "Find open windows",
        "computer_list_apps": "List apps", "computer_verify_state": "Verify state",
        "computer_zoom": "Zoom into a window", "computer_get_accessibility_tree": "List apps and windows",
        "computer_get_cursor_position": "Read the cursor position", "computer_help": "Read the Computer playbook",
        "computer_click": "Click", "computer_move_cursor": "Move the agent cursor", "computer_drag": "Drag",
        "computer_scroll": "Scroll", "computer_type_text": "Type", "computer_press_key": "Press a key",
        "computer_set_value": "Set a field", "computer_select_text": "Select text",
        "computer_perform_action": "Activate a control", "computer_launch_app": "Open an app",
        "computer_activate_window": "Activate a window", "computer_set_window_frame": "Move or resize a window",
        "computer_invoke_menu": "Invoke a menu item", "computer_kill_app": "Force-quit an app",
        "computer_set_window_minimized": "Minimize or restore a window", "computer_set_app_visibility": "Hide or unhide an app",
        "computer_wait": "Wait", "computer_read_clipboard": "Read the clipboard",
        "computer_write_clipboard": "Write to the clipboard", "computer_paste": "Paste text",
        "computer_run": "Run a sequence", "computer_inspect": "Inspect the computer",
        "computer_spaces": "Inspect desktop Spaces", "computer_browser_state": "Read the browser page",
        "computer_browser_prepare": "Prepare a browser", "computer_browser_navigate": "Open a browser page",
        "computer_browser_click": "Click in the browser", "computer_browser_type": "Type in a browser field",
        "computer_browser_dialog": "Handle a browser dialog", "computer_browser_upload": "Attach files in the browser",
        "computer_browser_download": "Download a file", "computer_browser_pointer": "Use the pointer in the browser",
        "computer_browser_press": "Press Enter in the browser"
    ]

    /// The bare tool inside a provider's wrapping (`mcp__pathway__computer_click`), or nil.
    static func name(_ candidate: String?) -> String? {
        guard let candidate else { return nil }
        var normalized = ""
        var pendingSeparator = false
        for scalar in candidate.trimmingCharacters(in: .whitespacesAndNewlines).lowercased().unicodeScalars {
            if scalar.isASCII && (CharacterSet.lowercaseLetters.contains(scalar) || CharacterSet.decimalDigits.contains(scalar)) {
                if pendingSeparator { normalized.append("_"); pendingSeparator = false }
                normalized.unicodeScalars.append(scalar)
            } else { pendingSeparator = true }
        }
        if pendingSeparator { normalized.append("_") }
        return titles.keys.first { normalized == $0 || normalized.hasSuffix("_\($0)") }
    }

    static func title(_ candidate: String) -> String { name(candidate).flatMap { titles[$0] } ?? candidate }
}

extension PathwayAgentThreadModel {
    static let computerControlDefaultsKey = "pathway.computerControlEnabled"

    /// Whether this thread's host can drive a desktop.
    var supportsComputer: Bool { PathwayComputerAccess.supportsComputer(serverConfig: serverConfig) }

    /// This device's pairing is known to fall outside the access policy. Unknown reads as
    /// allowed: the server is authoritative, and a guess must not blame the pairing.
    var computerAccessDenied: Bool {
        guard let computerAccessPolicy, let computerSessionScopes else { return false }
        return !PathwayComputerAccess.canUse(policy: computerAccessPolicy, scopes: computerSessionScopes)
    }

    /// The device-wide Computer control setting as it applies here: on only where the host can
    /// drive a desktop and this device may use it, so no environment refuses ordinary messages.
    func computerControlApplies(setting: Bool) -> Bool { setting && supportsComputer && !computerAccessDenied }

    /// Starts the draft with `/computer-use` unless it already asks for Computer.
    func armComputerUse() {
        guard PathwayComputerInvocation.prompt(in: draft) == nil else { return }
        draft = "/\(PathwayComputerInvocation.slashCommand) " + draft
    }

    func setComputerSessionScopes(_ scopes: Set<String>) { computerSessionScopes = scopes }

    func loadComputerAccessPolicy() async {
        guard supportsComputer, let settings = try? await request("server.getSettings", payload: .object([:]), reportsErrors: false) else { return }
        computerAccessPolicy = settings.objectValue?["computer"]?.objectValue?["accessPolicy"]?.stringValue
    }
}
