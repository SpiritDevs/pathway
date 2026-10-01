import Foundation
@testable import Pathway
import Testing

// Mirrors `packages/client-runtime/src/state/xcodeSetup.test.ts`; keep the expectations in step.

private let gib = 1_073_741_824.0
private let account = PathwayXcodeTarget(companyId: "company-1", accountId: "account-1")

func xcodeStep(_ id: PathwayXcodeStepID, _ state: PathwayXcodeStepState, progress: PathwayXcodeProgress? = nil) -> PathwayXcodeStep {
    PathwayXcodeStep(id: id, state: state, error: nil, progress: progress)
}

func xcodeJob(
    id: String = "job-1",
    kind: PathwayXcodeJobKind = .install,
    versionId: String? = "17B55",
    path: String = "/Applications/Xcode-26.1.app",
    platforms: [PathwayXcodePlatform] = [.iOS],
    state: PathwayXcodeJobState = .running,
    steps: [PathwayXcodeStep]? = nil
) -> PathwayXcodeJob {
    PathwayXcodeJob(
        id: id, kind: kind, account: account, versionId: versionId, path: path, platforms: platforms, state: state,
        steps: steps ?? [
            xcodeStep(.check, .completed),
            xcodeStep(.download, .running, progress: PathwayXcodeProgress(bytes: 5 * gib, total: 10 * gib, bytesPerSecond: 50 * 1024 * 1024)),
            xcodeStep(.expand, .pending),
            xcodeStep(.move, .pending),
            xcodeStep(.license, .pending),
            xcodeStep(.select, .pending),
            xcodeStep(.firstLaunch, .pending),
            xcodeStep(.runtimes, .pending),
            xcodeStep(.helpers, .skipped),
        ],
        createdAt: 0, updatedAt: 0
    )
}

func xcodeStatus(
    installed: [PathwayInstalledXcode] = [],
    runtimes: [PathwayXcodeRuntime] = [],
    job: PathwayXcodeJob? = nil
) -> PathwayXcodeStatus {
    PathwayXcodeStatus(
        host: "mac", installed: installed,
        available: [PathwayAvailableXcode(id: "17B55", version: "26.1", build: "17B55", beta: false, downloadBytes: nil, requiredBytes: 45 * gib)],
        runtimes: runtimes, disk: PathwayXcodeDisk(freeBytes: 100 * gib, requiredBytes: 45 * gib), job: job, error: nil
    )
}

private func selected(_ version: String) -> [PathwayInstalledXcode] {
    [PathwayInstalledXcode(path: "/Applications/Xcode.app", version: version, build: "x", beta: false, selected: true)]
}

private func runtime(_ platform: PathwayXcodePlatform, _ version: String, installed: Bool = true, available: Bool = true) -> PathwayXcodeRuntime {
    PathwayXcodeRuntime(id: "\(platform.rawValue)-\(version)", platform: platform, version: version, build: nil,
                        installed: installed, available: available, downloadBytes: nil)
}

struct PathwayXcodeSetupTests {
    @Test func keepsInventoryAcrossJobTicks() {
        let withStatus = PathwayXcodeView().applying(.status(xcodeStatus(job: xcodeJob(state: .completed))))
        #expect(withStatus.job?.state == .completed)
        let ticked = withStatus.applying(.job(xcodeJob()))
        #expect(ticked.status == withStatus.status)
        #expect(ticked.job?.state == .running)
        #expect(ticked.applying(.job(nil)).job == nil)
    }

    @Test func followsHostJobControls() {
        #expect(PathwayXcodeRules.isActive(xcodeJob(state: .needsReauth)))
        #expect(!PathwayXcodeRules.isActive(xcodeJob(state: .failed)))
        #expect(!PathwayXcodeRules.isActive(nil))
        #expect(PathwayXcodeRules.canRetry(xcodeJob(state: .interrupted)))
        #expect(!PathwayXcodeRules.canRetry(xcodeJob(state: .running)))
        #expect(PathwayXcodeRules.canCancel(xcodeJob(state: .needsAdmin)))
        #expect(!PathwayXcodeRules.canCancel(xcodeJob(state: .cancelling)))
        #expect(!PathwayXcodeRules.canCancel(xcodeJob(state: .completed)))
    }

    @Test func usableNeedsASelectedXcode() {
        let installed = { (selected: Bool) in
            PathwayInstalledXcode(path: "/Applications/Xcode.app", version: "26.1", build: "17B55", beta: false, selected: selected)
        }
        #expect(PathwayXcodeRules.usable(xcodeStatus(installed: [installed(false)])) == nil)
        #expect(PathwayXcodeRules.usable(xcodeStatus(installed: [installed(true)]))?.path == "/Applications/Xcode.app")
    }

    @Test func recommendsNewestReleaseAheadOfBetas() {
        let entry = { (version: String, beta: Bool) in
            PathwayAvailableXcode(id: version, version: version, build: version, beta: beta, downloadBytes: nil, requiredBytes: 45 * gib)
        }
        let (recommended, ordered) = PathwayXcodeRules.orderAvailable([
            entry("26.0.1", false), entry("27.0", true), entry("26.1", false), entry("9.4", false),
        ])
        #expect(recommended?.version == "26.1")
        #expect(ordered.map(\.version) == ["26.1", "26.0.1", "9.4", "27.0"])
        #expect(PathwayXcodeRules.orderAvailable([entry("27.0", true)]).recommended == nil)
    }

    @Test func budgetsDiskPerPlatform() {
        let xcode = PathwayAvailableXcode(id: "a", version: "26.1", build: "a", beta: false, downloadBytes: nil, requiredBytes: 45 * gib)
        #expect(PathwayXcodeRules.installRequiredBytes(xcode, platforms: [.iOS, .watchOS]) == 75 * gib)
        #expect(PathwayXcodeRules.diskShortfall(required: 75 * gib, free: 70 * gib) == 5 * gib)
        #expect(PathwayXcodeRules.diskShortfall(required: 75 * gib, free: 80 * gib) == nil)
        #expect(PathwayXcodeRules.diskShortfall(required: 75 * gib, free: nil) == nil)
    }

    @Test func formatsBytesAndEta() {
        #expect(PathwayXcodeRules.formatBytes(512) == "512 B")
        #expect(PathwayXcodeRules.formatBytes(50 * 1024 * 1024) == "50 MB")
        #expect(PathwayXcodeRules.formatBytes(3.25 * gib) == "3.3 GB")
        #expect(PathwayXcodeRules.formatBytes(120 * gib) == "120 GB")
        #expect(PathwayXcodeRules.formatEta(30) == "less than a minute left")
        #expect(PathwayXcodeRules.formatEta(6 * 60) == "about 6 min left")
        #expect(PathwayXcodeRules.formatEta(72 * 60) == "about 1 h 12 min left")
        #expect(PathwayXcodeRules.formatEta(120 * 60) == "about 2 h left")
    }

    @Test func describesDownloadsWithAndWithoutSize() {
        #expect(PathwayXcodeRules.describeDownload(PathwayXcodeProgress(bytes: 5 * gib, total: 10 * gib, bytesPerSecond: 50 * 1024 * 1024))
            == PathwayXcodeDownloadDescription(fraction: 0.5, amount: "5.0 GB of 10.0 GB", speed: "50 MB/s", eta: "about 2 min left"))
        #expect(PathwayXcodeRules.describeDownload(PathwayXcodeProgress(bytes: 5 * gib, total: nil, bytesPerSecond: 0))
            == PathwayXcodeDownloadDescription(fraction: nil, amount: "5.0 GB", speed: nil, eta: nil))
    }

    @Test func summarizesJobs() {
        let summary = PathwayXcodeRules.summarize(xcodeJob())
        #expect(summary.steps.count == 8)
        #expect(summary.completed == 1)
        #expect(summary.current?.id == .download)
        #expect(summary.current?.id.label == "Download Xcode")
        #expect(abs(summary.fraction - 1.5 / 8) < 1e-9)

        let admin = PathwayXcodeRules.summarize(xcodeJob(state: .needsAdmin, steps: [
            xcodeStep(.check, .completed), xcodeStep(.move, .needsAdmin), xcodeStep(.license, .pending),
        ]))
        #expect(admin.current?.id == .move)

        let settled = PathwayXcodeRules.summarize(xcodeJob(state: .completed, steps: [
            xcodeStep(.check, .completed), xcodeStep(.select, .completed),
        ]))
        #expect(settled.current == nil)
        #expect(settled.fraction == 1)
    }

    @Test func titlesJobsFromCatalogueOrApp() {
        #expect(PathwayXcodeRules.title(xcodeJob(), status: xcodeStatus()) == "Installing Xcode 26.1")
        #expect(PathwayXcodeRules.title(
            xcodeJob(kind: .select, versionId: nil, path: "/Applications/Xcode-beta.app", state: .completed), status: nil
        ) == "Selected Xcode-beta")
        #expect(PathwayXcodeRules.title(
            xcodeJob(kind: .runtimes, versionId: nil, platforms: [.iOS, .tvOS]), status: xcodeStatus()
        ) == "Adding iOS, tvOS to Xcode-26.1")
    }

    @Test func keepsAdminApprovalOnlyWhileTheSameStepWaits() {
        let waiting = xcodeJob(state: .needsAdmin, steps: [xcodeStep(.check, .completed), xcodeStep(.move, .needsAdmin)])
        let approved = PathwayXcodeRules.adminStepKey(waiting)
        #expect(approved == "job-1:move")
        #expect(PathwayXcodeRules.nextAdminApproval(approved, job: waiting) == approved)
        // The Mac prompt was dismissed: the step fails, so the retried step is approvable again.
        let dismissed = xcodeJob(state: .failed, steps: [xcodeStep(.check, .completed), xcodeStep(.move, .failed)])
        #expect(PathwayXcodeRules.nextAdminApproval(approved, job: dismissed) == nil)
        #expect(PathwayXcodeRules.nextAdminApproval(nil, job: waiting) == nil)
        let other = xcodeJob(id: "job-2", state: .needsAdmin, steps: waiting.steps)
        #expect(PathwayXcodeRules.nextAdminApproval(approved, job: other) == nil)
    }

    @Test func announcesOnlyStatesThatNeedTheUserOrEnd() {
        let status = xcodeStatus()
        #expect(PathwayXcodeRules.announcement(xcodeJob(state: .needsAdmin), status: status)
            == "Installing Xcode 26.1: needs admin approval on the Mac.")
        #expect(PathwayXcodeRules.announcement(xcodeJob(state: .needsReauth), status: status)
            == "Installing Xcode 26.1: sign in to your Apple ID again to continue.")
        #expect(PathwayXcodeRules.announcement(xcodeJob(state: .failed), status: status) == "Installing Xcode 26.1 failed.")
        #expect(PathwayXcodeRules.announcement(xcodeJob(state: .completed), status: status) == "Installed Xcode 26.1.")
        #expect(PathwayXcodeRules.announcement(xcodeJob(), status: status).isEmpty)
        #expect(PathwayXcodeRules.announcement(nil, status: status).isEmpty)
    }

    @Test func mapsXcodeVersionsToRuntimeMajors() {
        #expect(PathwayXcodeRules.runtimeMajor(xcodeVersion: "26.1", platform: .watchOS) == 26)
        #expect(PathwayXcodeRules.runtimeMajor(xcodeVersion: "16.4", platform: .iOS) == 18)
        #expect(PathwayXcodeRules.runtimeMajor(xcodeVersion: "16.4", platform: .watchOS) == 11)
        #expect(PathwayXcodeRules.runtimeMajor(xcodeVersion: "10.3", platform: .iOS) == nil)
    }

    @Test func offersPlatformsWithoutAMatchingUsableRuntime() {
        let covered = xcodeStatus(installed: selected("26.1"), runtimes: [
            runtime(.iOS, "18.5"), runtime(.iOS, "26.1", installed: false), runtime(.tvOS, "26.0"),
        ])
        #expect(PathwayXcodeRules.missingPlatforms(covered) == [.iOS, .watchOS])
        #expect(PathwayXcodeRules.missingPlatforms(xcodeStatus(installed: selected("26.1"), runtimes: [runtime(.iOS, "26.0")]))
            == [.watchOS, .tvOS])
        #expect(PathwayXcodeRules.missingPlatforms(xcodeStatus()).isEmpty)
        let broken = xcodeStatus(installed: selected("26.1"), runtimes: [
            runtime(.iOS, "26.1", available: false), runtime(.watchOS, "26.1"), runtime(.tvOS, "26.1"),
        ])
        #expect(PathwayXcodeRules.missingPlatforms(broken) == [.iOS])
    }

    @Test func picksSignInStage() {
        #expect(PathwayXcodeRules.signInStage(session: .authenticated(expiresAt: 1), error: "down") == .unavailable)
        #expect(PathwayXcodeRules.signInStage(session: nil, error: nil) == .checking)
        #expect(PathwayXcodeRules.signInStage(session: .authenticated(expiresAt: 1), error: nil) == .authenticated)
        #expect(PathwayXcodeRules.signInStage(session: .authenticated(expiresAt: 1), error: nil, signInAgain: true) == .password)
        #expect(PathwayXcodeRules.signInStage(session: .expired, error: nil) == .password)
        #expect(PathwayXcodeRules.signInStage(session: .authenticating(flowId: "f", expiresAt: 1), error: nil) == .authenticating)
    }

    @Test func picksAccountAndAuthorizationCompany() {
        #expect(PathwayXcodeRules.rpcCompanyID(.company("org-1"), environmentCompanyID: "env-co") == "org-1")
        #expect(PathwayXcodeRules.rpcCompanyID(.user, environmentCompanyID: "env-co") == "env-co")
    }
}
