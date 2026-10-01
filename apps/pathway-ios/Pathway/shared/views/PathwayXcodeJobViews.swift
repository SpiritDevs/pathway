import SwiftUI

/// One host job with its step list. Progress renders straight from the coalesced snapshots, so a
/// download repaints at most a few times a second.
struct PathwayXcodeJobCard: View {
    let model: PathwayXcodeModel
    let job: PathwayXcodeJob
    let status: PathwayXcodeStatus
    let hostName: String

    var body: some View {
        let summary = PathwayXcodeRules.summarize(job)
        let failure = summary.current?.error?.message
        HStack {
            Text(PathwayXcodeRules.title(job, status: status)).font(.headline)
            Spacer()
            Text(job.state.label).font(.caption).foregroundStyle(stateColor)
        }
        .accessibilityElement(children: .combine)
        if job.state != .completed {
            ProgressView(value: summary.fraction)
                .accessibilityLabel("Overall progress")
        }
        ForEach(summary.steps) { step in
            stepRow(step, current: step.id == summary.current?.id)
        }
        if job.state == .needsAdmin, PathwayXcodeRules.adminStepKey(job) != nil {
            adminApproval
        }
        if job.state == .needsReauth {
            reauth
        }
        if job.state == .failed || job.state == .interrupted, let failure {
            Text(failure).font(.footnote).foregroundStyle(.red)
        } else if job.state == .interrupted {
            Text("The environment restarted during this job. Retry to continue where it stopped.")
                .font(.footnote).foregroundStyle(.secondary)
        }
        PathwayXcodeActionError(model: model)
        if PathwayXcodeRules.canRetry(job) {
            Button(model.pending == "retry" ? "Retrying…" : (job.state == .cancelled ? "Resume" : "Retry")) {
                Task { await model.retry(job: job) }
            }
            .disabled(model.pending != nil || (job.state == .needsReauth && !model.signedIn))
        }
        if PathwayXcodeRules.canCancel(job) {
            Button(model.pending == "cancel" ? "Cancelling…" : "Cancel", role: .destructive) {
                Task { await model.cancel(job: job) }
            }
            .disabled(model.pending != nil)
        }
    }

    private var stateColor: Color {
        switch job.state {
        case .needsAdmin, .needsReauth, .interrupted: .orange
        case .failed: .red
        case .completed: .green
        default: .secondary
        }
    }

    private func stepRow(_ step: PathwayXcodeStep, current: Bool) -> some View {
        HStack(alignment: .firstTextBaseline) {
            Image(systemName: icon(step.state)).foregroundStyle(iconColor(step.state))
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 4) {
                Text(step.id.label)
                    .foregroundStyle(step.state == .pending ? .secondary : .primary)
                    .accessibilityLabel("\(step.id.label): \(step.state.label)")
                if step.id == .download, step.state == .running, let progress = step.progress {
                    downloadProgress(PathwayXcodeRules.describeDownload(progress))
                }
                if let error = step.error, step.state != .completed {
                    Text(error.message).font(.footnote).foregroundStyle(.red)
                }
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(current ? .isSelected : [])
    }

    private func downloadProgress(_ download: PathwayXcodeDownloadDescription) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            if let fraction = download.fraction {
                ProgressView(value: fraction).accessibilityLabel("Download progress")
            }
            Text([download.amount, download.speed, download.eta].compactMap(\.self).joined(separator: " · "))
                .font(.caption).monospacedDigit().foregroundStyle(.secondary)
        }
    }

    private func icon(_ state: PathwayXcodeStepState) -> String {
        switch state {
        case .pending, .skipped: "circle.dashed"
        case .running: "circle.dotted.circle"
        case .needsAdmin: "exclamationmark.circle"
        case .completed: "checkmark.circle"
        case .failed, .cancelled: "xmark.circle"
        }
    }

    private func iconColor(_ state: PathwayXcodeStepState) -> Color {
        switch state {
        case .running: .accentColor
        case .needsAdmin: .orange
        case .completed: .green
        case .failed: .red
        default: .secondary
        }
    }

    @ViewBuilder private var adminApproval: some View {
        let waiting = model.awaitingAdminPrompt
        VStack(alignment: .leading, spacing: 4) {
            Text("Needs admin approval on the Mac").font(.subheadline.weight(.semibold))
            Text(waiting
                ? "A macOS password prompt is open on \(hostName). Someone at that Mac enters an administrator password to continue."
                : "Approving opens a macOS password prompt on \(hostName), not on this device. Someone at that Mac enters an administrator password; Pathway never sees it.")
                .font(.footnote).foregroundStyle(.secondary)
        }
        .accessibilityElement(children: .combine)
        Button(waiting ? "Waiting for the Mac…" : "Approve on the Mac") {
            Task { await model.approve(job: job) }
        }
        .disabled(waiting || model.pending != nil)
    }

    /// The password form lives in the Apple ID section; this explains why and offers a fresh session.
    @ViewBuilder private var reauth: some View {
        Text("Sign in to your Apple ID again to continue").font(.subheadline.weight(.semibold))
        if case let .authenticated(expiresAt) = model.session, model.signedIn {
            Text("If Apple keeps asking, the saved session no longer works. Sign in again for a fresh one.")
                .font(.footnote).foregroundStyle(.secondary)
            Button("Sign in again") { model.replacingSession = expiresAt }
        } else {
            Text("Sign in under Apple ID above, then choose Retry.")
                .font(.footnote).foregroundStyle(.secondary)
        }
    }
}

/// Installed Xcodes with the selected one marked; selecting another switches `xcode-select`.
struct PathwayXcodeInstalledList: View {
    let model: PathwayXcodeModel
    let status: PathwayXcodeStatus
    let busy: Bool

    var body: some View {
        if status.installed.isEmpty {
            Text("No Xcode is installed on this Mac.").foregroundStyle(.secondary)
        }
        ForEach(status.installed) { xcode in
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Xcode \(xcode.version)\(xcode.beta ? " beta" : "")").font(.body.weight(.medium))
                    Text("\(xcode.build) · \(xcode.path)").font(.caption.monospaced()).foregroundStyle(.secondary)
                        .lineLimit(1).truncationMode(.middle)
                }
                .accessibilityElement(children: .combine)
                Spacer()
                if xcode.selected {
                    Text("Selected").font(.caption.weight(.semibold)).foregroundStyle(.green)
                } else {
                    Button(model.pending == xcode.path ? "Selecting…" : "Select") {
                        Task { await model.select(path: xcode.path) }
                    }
                    .buttonStyle(.bordered)
                    .disabled(busy || model.pending != nil)
                    .accessibilityLabel("Select Xcode \(xcode.version)")
                }
            }
        }
        PathwayXcodeActionError(model: model)
    }
}

/// Simulator runtimes and the form that adds platforms to the selected Xcode.
struct PathwayXcodeRuntimes: View {
    let model: PathwayXcodeModel
    let status: PathwayXcodeStatus
    let busy: Bool
    @State private var platforms: [PathwayXcodePlatform] = []

    var body: some View {
        let installed = status.runtimes.filter(\.installed)
        let missing = PathwayXcodeRules.missingPlatforms(status)
        let chosen = platforms.filter(missing.contains)
        let required = PathwayXcodeRules.runtimesRequiredBytes(chosen)
        if installed.isEmpty {
            Text("No simulator platforms are installed.").foregroundStyle(.secondary)
        }
        ForEach(installed) { runtime in
            LabeledContent("\(runtime.platform.rawValue) \(runtime.version)", value: runtime.build ?? "")
        }
        if let selected = PathwayXcodeRules.usable(status), !missing.isEmpty {
            Text("Add platforms to Xcode \(selected.version)").font(.subheadline.weight(.semibold))
            PathwayXcodePlatformToggles(platforms: $platforms, available: missing, disabled: busy || model.pending != nil)
            if !chosen.isEmpty {
                PathwayXcodeDiskLine(required: required, free: status.disk.freeBytes)
            }
            Button(model.pending == "runtimes" ? "Starting…" : "Add platforms") {
                Task {
                    if await model.installRuntimes(path: selected.path, platforms: chosen) { platforms = [] }
                }
            }
            .disabled(busy || model.pending != nil || chosen.isEmpty
                || PathwayXcodeRules.diskShortfall(required: required, free: status.disk.freeBytes) != nil)
        }
    }
}

/// Version and platform choice. The newest release is preselected and marked recommended.
struct PathwayXcodeInstallChooser: View {
    let model: PathwayXcodeModel
    let status: PathwayXcodeStatus
    @State private var versionID: String?
    @State private var platforms: [PathwayXcodePlatform] = [.iOS]

    var body: some View {
        let (recommended, ordered) = PathwayXcodeRules.orderAvailable(status.available)
        let chosen = ordered.first { $0.id == versionID } ?? recommended ?? ordered.first
        if let chosen {
            let required = PathwayXcodeRules.installRequiredBytes(chosen, platforms: platforms)
            let installedBuilds = Set(status.installed.map(\.build))
            ForEach(ordered) { xcode in
                Button { versionID = xcode.id } label: {
                    versionRow(xcode, selected: xcode.id == chosen.id, recommended: xcode.id == recommended?.id,
                               installed: installedBuilds.contains(xcode.build))
                }
                .foregroundStyle(.primary)
                .disabled(model.pending != nil)
                .accessibilityAddTraits(xcode.id == chosen.id ? .isSelected : [])
            }
            PathwayXcodePlatformToggles(platforms: $platforms, available: PathwayXcodePlatform.allCases, disabled: model.pending != nil)
            Text("macOS is always included. Add platforms now or later from Settings.").font(.footnote).foregroundStyle(.secondary)
            PathwayXcodeDiskLine(required: required, free: status.disk.freeBytes)
            PathwayXcodeActionError(model: model)
            Button(model.pending == "install" ? "Starting…" : "Install Xcode \(chosen.version)") {
                Task { await model.install(versionID: chosen.id, platforms: platforms) }
            }
            .disabled(model.pending != nil
                || PathwayXcodeRules.diskShortfall(required: required, free: status.disk.freeBytes) != nil)
        } else {
            Text(status.error?.message ?? "No Xcode releases are available for this Mac right now.")
                .foregroundStyle(status.error == nil ? Color.secondary : Color.red)
        }
    }

    private func versionRow(_ xcode: PathwayAvailableXcode, selected: Bool, recommended: Bool, installed: Bool) -> some View {
        HStack {
            Image(systemName: selected ? "largecircle.fill.circle" : "circle")
                .foregroundStyle(Color.accentColor)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text("Xcode \(xcode.version)").font(.body.weight(.medium))
                Text(([xcode.build] + (recommended ? ["Recommended"] : []) + (xcode.beta ? ["Beta"] : [])
                    + (installed ? ["Installed"] : [])).joined(separator: " · "))
                    .font(.caption).foregroundStyle(recommended ? Color.green : Color.secondary)
            }
            Spacer()
            if let bytes = xcode.downloadBytes {
                Text("\(PathwayXcodeRules.formatBytes(bytes)) download").font(.caption).foregroundStyle(.secondary)
            }
        }
        .accessibilityElement(children: .combine)
    }
}

private struct PathwayXcodePlatformToggles: View {
    @Binding var platforms: [PathwayXcodePlatform]
    let available: [PathwayXcodePlatform]
    let disabled: Bool

    var body: some View {
        ForEach(available) { platform in
            Toggle(platform.rawValue, isOn: Binding(
                get: { platforms.contains(platform) },
                set: { on in
                    platforms = on
                        ? PathwayXcodePlatform.allCases.filter { $0 == platform || platforms.contains($0) }
                        : platforms.filter { $0 != platform }
                }
            ))
            .disabled(disabled)
        }
    }
}

private struct PathwayXcodeDiskLine: View {
    let required: Double
    let free: Double?

    var body: some View {
        let short = PathwayXcodeRules.diskShortfall(required: required, free: free)
        Text("Needs \(PathwayXcodeRules.formatBytes(required))"
            + (free.map { " · \(PathwayXcodeRules.formatBytes($0)) free on the Mac" } ?? "")
            + (short.map { ". Free up \(PathwayXcodeRules.formatBytes($0)) to continue." } ?? ""))
            .font(.footnote)
            .foregroundStyle(short == nil ? Color.secondary : Color.red)
    }
}
