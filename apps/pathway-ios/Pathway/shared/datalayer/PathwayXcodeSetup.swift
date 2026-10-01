import Foundation

// A port of the pure rules in `packages/client-runtime/src/state/xcodeSetup.ts` and
// `apps/web/src/components/xcode/XcodeSetup.logic.ts`. Keep them in step: a rule changed there
// changes here, and `PathwayXcodeSetupTests` mirrors `xcodeSetup.test.ts`.

/// What the Xcode screen renders: the last inventory plus the newest job snapshot.
struct PathwayXcodeView: Equatable, Sendable {
    var status: PathwayXcodeStatus?
    var job: PathwayXcodeJob?

    /// Download ticks carry only the job, so the last inventory is kept across them.
    func applying(_ update: PathwayXcodeUpdate) -> PathwayXcodeView {
        switch update {
        case let .status(status): PathwayXcodeView(status: status, job: status.job)
        case let .job(job): PathwayXcodeView(status: status, job: job)
        }
    }
}

struct PathwayXcodeDownloadDescription: Equatable, Sendable {
    /// 0–1, or nil when the archive size is unknown.
    let fraction: Double?
    let amount: String
    let speed: String?
    let eta: String?
}

struct PathwayXcodeJobSummary: Equatable, Sendable {
    /// Steps that apply to this job, in order; skipped steps are left out.
    let steps: [PathwayXcodeStep]
    /// The step in progress, waiting or failed; nil once every step is settled.
    let current: PathwayXcodeStep?
    let completed: Int
    /// Overall 0–1, counting a running download by its bytes.
    let fraction: Double
}

enum PathwayAppleIdSignInStage: Equatable, Sendable {
    case unavailable, checking, authenticated, authenticating, challenge, password
}

enum PathwayXcodeRules {
    static let gib = 1_073_741_824.0
    // Mirrors the host's budget: each platform reserves 15 GiB on top of the Xcode itself.
    static let platformBudgetBytes = 15 * gib
    static let runtimesJobBudgetBytes = 5 * gib

    /// The host holds one job at a time; these states block starting another.
    static func isActive(_ job: PathwayXcodeJob?) -> Bool {
        guard let job else { return false }
        return [.running, .needsAdmin, .needsReauth, .interrupted, .cancelling].contains(job.state)
    }

    static func canRetry(_ job: PathwayXcodeJob) -> Bool {
        [.failed, .cancelled, .interrupted, .needsReauth].contains(job.state)
    }

    static func canCancel(_ job: PathwayXcodeJob) -> Bool {
        ![.completed, .cancelled, .cancelling].contains(job.state)
    }

    /// The selected Xcode; an installed but unselected one still needs a select step.
    static func usable(_ status: PathwayXcodeStatus) -> PathwayInstalledXcode? {
        status.installed.first(where: \.selected)
    }

    /// Since Xcode 26 the runtimes share its major; before that iOS and tvOS ran two ahead and watchOS
    /// five behind. Nil for versions this table does not know.
    static func runtimeMajor(xcodeVersion: String, platform: PathwayXcodePlatform) -> Int? {
        guard let major = leadingInt(xcodeVersion), major >= 11 else { return nil }
        if major >= 26 { return major }
        return platform == .watchOS ? major - 5 : major + 2
    }

    /// Platforms whose runtime for the selected Xcode is not installed and usable.
    static func missingPlatforms(_ status: PathwayXcodeStatus) -> [PathwayXcodePlatform] {
        guard let selected = usable(status) else { return [] }
        return PathwayXcodePlatform.allCases.filter { platform in
            let major = runtimeMajor(xcodeVersion: selected.version, platform: platform)
            return !status.runtimes.contains { runtime in
                runtime.platform == platform && runtime.installed && runtime.available
                    && (major == nil || leadingInt(runtime.version) == major)
            }
        }
    }

    /// Numeric dotted-version comparison; "26.1" sorts after "26.0.1".
    static func compareVersions(_ lhs: String, _ rhs: String) -> Int {
        let left = lhs.split(separator: ".", omittingEmptySubsequences: false).map { leadingInt(String($0)) ?? 0 }
        let right = rhs.split(separator: ".", omittingEmptySubsequences: false).map { leadingInt(String($0)) ?? 0 }
        for index in 0 ..< max(left.count, right.count) {
            let difference = (index < left.count ? left[index] : 0) - (index < right.count ? right[index] : 0)
            if difference != 0 { return difference }
        }
        return 0
    }

    /// Newest release first, then older releases, then betas. The first release is recommended.
    static func orderAvailable(_ available: [PathwayAvailableXcode])
        -> (recommended: PathwayAvailableXcode?, ordered: [PathwayAvailableXcode]) {
        let ordered = available.enumerated().sorted { lhs, rhs in
            if lhs.element.beta != rhs.element.beta { return !lhs.element.beta }
            let order = compareVersions(rhs.element.version, lhs.element.version)
            return order == 0 ? lhs.offset < rhs.offset : order < 0
        }.map(\.element)
        let recommended = ordered.first.flatMap { $0.beta ? nil : $0 }
        return (recommended, ordered)
    }

    static func installRequiredBytes(_ version: PathwayAvailableXcode, platforms: [PathwayXcodePlatform]) -> Double {
        version.requiredBytes + Double(platforms.count) * platformBudgetBytes
    }

    static func runtimesRequiredBytes(_ platforms: [PathwayXcodePlatform]) -> Double {
        runtimesJobBudgetBytes + Double(platforms.count) * platformBudgetBytes
    }

    /// Bytes missing on the Mac, or nil when there is room or free space is unknown.
    static func diskShortfall(required: Double, free: Double?) -> Double? {
        guard let free, free < required else { return nil }
        return required - free
    }

    /// Binary units labelled GB, matching Finder's rounding closely enough for a disk budget.
    static func formatBytes(_ bytes: Double) -> String {
        if bytes < 1024 { return "\(Int(max(0, bytes.rounded(.toNearestOrAwayFromZero)))) B" }
        let units = ["KB", "MB", "GB", "TB"]
        var value = bytes / 1024
        var unit = 0
        while value >= 1024, unit < units.count - 1 {
            value /= 1024
            unit += 1
        }
        let number = value >= 100 || unit < 2
            ? String(Int(value.rounded(.toNearestOrAwayFromZero)))
            : String(format: "%.1f", locale: Locale(identifier: "en_US_POSIX"), value)
        return "\(number) \(units[unit])"
    }

    static func formatEta(_ seconds: Double) -> String {
        if seconds < 60 { return "less than a minute left" }
        let minutes = Int((seconds / 60).rounded(.toNearestOrAwayFromZero))
        if minutes < 60 { return "about \(minutes) min left" }
        let hours = minutes / 60
        let rest = minutes % 60
        return rest == 0 ? "about \(hours) h left" : "about \(hours) h \(rest) min left"
    }

    static func describeDownload(_ progress: PathwayXcodeProgress) -> PathwayXcodeDownloadDescription {
        let total = progress.total.flatMap { $0 > 0 ? $0 : nil }
        let speed = progress.bytesPerSecond > 0 ? "\(formatBytes(progress.bytesPerSecond))/s" : nil
        return PathwayXcodeDownloadDescription(
            fraction: total.map { min(1, progress.bytes / $0) },
            amount: total.map { "\(formatBytes(progress.bytes)) of \(formatBytes($0))" } ?? formatBytes(progress.bytes),
            speed: speed,
            eta: total.flatMap { total in
                progress.bytesPerSecond > 0 && progress.bytes < total
                    ? formatEta((total - progress.bytes) / progress.bytesPerSecond) : nil
            }
        )
    }

    static func summarize(_ job: PathwayXcodeJob) -> PathwayXcodeJobSummary {
        let steps = job.steps.filter { $0.state != .skipped }
        let completed = steps.count { $0.state == .completed }
        let current = steps.first { [.running, .needsAdmin, .failed, .cancelled].contains($0.state) }
            ?? steps.first { $0.state == .pending }
        var partial = 0.0
        if let current, current.state == .running, let progress = current.progress,
           let total = progress.total, total > 0 {
            partial = min(1, progress.bytes / total)
        }
        return PathwayXcodeJobSummary(
            steps: steps,
            current: current,
            completed: completed,
            fraction: steps.isEmpty ? 0 : (Double(completed) + partial) / Double(steps.count)
        )
    }

    /// "Installing Xcode 26.1", or the app name for select and runtime jobs.
    static func title(_ job: PathwayXcodeJob, status: PathwayXcodeStatus?) -> String {
        let version = status?.available.first { $0.id == job.versionId }?.version
            ?? status?.installed.first { $0.path == job.path }?.version
        let app = job.path.split(separator: "/").last.map(String.init) ?? job.path
        let name = version.map { "Xcode \($0)" } ?? (app.hasSuffix(".app") ? String(app.dropLast(4)) : app)
        let done = job.state == .completed
        switch job.kind {
        case .install: return done ? "Installed \(name)" : "Installing \(name)"
        case .select: return done ? "Selected \(name)" : "Selecting \(name)"
        case .runtimes:
            let platforms = job.platforms.map(\.rawValue).joined(separator: ", ")
            return done ? "Added \(platforms) to \(name)" : "Adding \(platforms) to \(name)"
        }
    }

    /// What VoiceOver announces when a job needs the user or ends. Other states, including download
    /// ticks, stay silent.
    static func announcement(_ job: PathwayXcodeJob?, status: PathwayXcodeStatus?) -> String {
        guard let job else { return "" }
        let title = title(job, status: status)
        switch job.state {
        case .needsAdmin: return "\(title): needs admin approval on the Mac."
        case .needsReauth: return "\(title): sign in to your Apple ID again to continue."
        case .failed: return "\(title) failed."
        case .completed: return "\(title)."
        default: return ""
        }
    }

    /// Identifies one admin step of one job, so an approval is not mistaken for another step's.
    static func adminStepKey(_ job: PathwayXcodeJob?) -> String? {
        guard let job, job.state == .needsAdmin,
              let step = job.steps.first(where: { $0.state == .needsAdmin }) else { return nil }
        return "\(job.id):\(step.id.rawValue)"
    }

    /// Keeps an approval only while its job is still waiting on that step. A dismissed prompt fails
    /// the job, so a retried step asks for approval again instead of waiting forever.
    static func nextAdminApproval(_ approved: String?, job: PathwayXcodeJob?) -> String? {
        guard let approved, approved == adminStepKey(job) else { return nil }
        return approved
    }

    /// Keeps the remembered account while it still exists; otherwise the first one.
    static func pickAccountID(_ accounts: [PathwayAppleAccount], remembered: String?) -> String? {
        if let remembered, accounts.contains(where: { $0.id == remembered }) { return remembered }
        return accounts.first?.id
    }

    /// The environment authorization context: the account's company, or the environment's own
    /// company for a personal Apple ID.
    static func rpcCompanyID(_ scope: PathwayAppleAccount.Scope, environmentCompanyID: String) -> String {
        if case let .company(companyID) = scope { return companyID }
        return environmentCompanyID
    }

    /// Which part of Apple ID sign-in to show. A stream error wins over stale data so it can be
    /// retried; `signInAgain` replaces an authenticated session Apple has already rejected.
    static func signInStage(session: PathwayAppleIdSession?, error: String?, signInAgain: Bool = false)
        -> PathwayAppleIdSignInStage {
        if error != nil { return .unavailable }
        switch session {
        case nil: return .checking
        case .authenticated: return signInAgain ? .password : .authenticated
        case .authenticating: return .authenticating
        case .challenge: return .challenge
        default: return .password
        }
    }

    private static func leadingInt(_ text: String) -> Int? {
        let digits = text.drop { $0 == " " }.prefix { $0.isASCII && $0.isNumber }
        return digits.isEmpty ? nil : Int(digits)
    }
}
