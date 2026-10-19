import SwiftUI
import PhotosUI
import UIKit

struct PathwayShakeReportSheet: View {
    @Environment(PathwayAppModel.self) private var appModel
    @Environment(\.dismiss) private var dismiss
    @ScaledMetric(relativeTo: .body) private var confirmationHeight = 340
    @State private var showingReport = false
    let screenshot: Data?

    var body: some View {
        @Bindable var reports = appModel.bugReports
        Group {
            if showingReport {
                PathwayBugReportView()
            } else {
                ScrollView {
                    VStack(alignment: .leading, spacing: 24) {
                        HStack {
                            Text("Report a bug?").font(.title2.bold())
                            Spacer()
                            Button("Close", systemImage: "xmark") { dismiss() }
                                .labelStyle(.iconOnly)
                                .buttonStyle(.bordered)
                                .buttonBorderShape(.circle)
                                .accessibilityIdentifier("bug-report-confirmation-close")
                        }
                        Text("If something isn't working correctly, you can report it to help improve Pathway.")
                            .foregroundStyle(.secondary)
                        Button {
                            reports.begin(screenshot: screenshot, device: pathwayBugDevice())
                            withAnimation { showingReport = true }
                        } label: {
                            Text("Report bug").fontWeight(.semibold).frame(maxWidth: .infinity)
                        }
                        .buttonStyle(.borderedProminent)
                        .buttonBorderShape(.capsule)
                        .controlSize(.large)
                        .accessibilityIdentifier("bug-report-confirmation-report")
                        Divider()
                        Toggle(isOn: $reports.shakeEnabled) {
                            VStack(alignment: .leading, spacing: 4) {
                                Text("Shake iPhone to report a bug")
                                Text("Toggle off to disable").font(.footnote).foregroundStyle(.secondary)
                            }
                        }
                    }
                    .padding(24)
                }
                .scrollBounceBehavior(.basedOnSize)
                .accessibilityIdentifier("bug-report-confirmation")
            }
        }
        .presentationDetents(showingReport ? [.large] : [.height(confirmationHeight)])
        .presentationDragIndicator(showingReport ? .visible : .hidden)
        .presentationCornerRadius(32)
    }
}

struct PathwayBugReportSettingsView: View {
    @Environment(PathwayAppModel.self) private var appModel
    @State private var presenting = false

    var body: some View {
        @Bindable var reports = appModel.bugReports
        Form {
            Section("Destination") { PathwayBugReportDestinationPicker() }
            Section {
                #if os(iOS)
                if UIDevice.current.userInterfaceIdiom == .phone {
                    Toggle("Shake iPhone to report a bug", isOn: $reports.shakeEnabled)
                }
                #endif
                Button("Report a bug", systemImage: "ladybug") {
                    reports.begin(screenshot: pathwayBugScreenshot(), device: pathwayBugDevice())
                    presenting = true
                }
                if reports.draft != nil { Text("Your saved report will resume.").font(.caption).foregroundStyle(.secondary) }
            }
            if let error = reports.error { Text(error).foregroundStyle(.red) }
        }
        .navigationTitle("Report a bug")
        .sheet(isPresented: $presenting) { PathwayBugReportView() }
    }
}

private struct PathwayBugReportDestinationPicker: View {
    @Environment(PathwayAppModel.self) private var appModel
    var body: some View {
        let reports = appModel.bugReports
        Picker("Project", selection: Binding(get: {
            "\(reports.targetCompanyID):\(reports.targetProjectID)"
        }, set: { value in
            guard let project = appModel.cloud.projects.first(where: { $0.id == value }) else { return }
            do { try reports.setDestination(companyID: project.companyId, projectID: project.project.id) }
            catch { reports.error = error.localizedDescription }
        })) {
            Text("Choose the Pathway project").tag(":")
            ForEach(appModel.cloud.projects.filter { $0.project.archivedAt == nil }) { project in
                Text("\(appModel.cloud.companyName(for: project.companyId) ?? "Company") · \(project.project.name)").tag(project.id)
            }
        }
        .disabled(reports.draft?.createAttempted == true || reports.busy)
    }
}

struct PathwayBugReportView: View {
    @Environment(PathwayAppModel.self) private var appModel
    @Environment(\.dismiss) private var dismiss
    @State private var providers: [JSONValue] = []
    @State private var environmentMessage: String?
    @State private var photo: PhotosPickerItem?
    @State private var showDiscard = false
    @State private var showTask = false

    private var reports: PathwayBugReportModel { appModel.bugReports }
    private var issue: PathwayIssueRecord? {
        guard let draft = reports.draft else { return nil }
        return appModel.cloud.issues.records.first { $0.companyId == draft.companyID && $0.id == draft.id }
    }
    private func binding<Value>(_ keyPath: WritableKeyPath<PathwayBugReportDraft, Value>, default fallback: Value) -> Binding<Value> {
        Binding(get: { reports.draft?[keyPath: keyPath] ?? fallback }, set: { value in
            reports.draft?[keyPath: keyPath] = value
        })
    }

    var body: some View {
        @Bindable var reports = reports
        NavigationStack {
            Form {
                if reports.draft?.evidenceSaved == true {
                    Section {
                        Label(reports.notice ?? "Report saved", systemImage: "checkmark.circle.fill")
                        if reports.busy { ProgressView("Finishing report…") }
                        if let draft = reports.draft {
                            Text(issue?.key ?? "Task saved. Its key will appear after sync.")
                            Button("Open task") { showTask = true }
                                .disabled(reports.busy)
                                .navigationDestination(isPresented: $showTask) {
                                    PathwayIssueDetailView(model: appModel.cloud.issues, companyID: draft.companyID, issueID: draft.id)
                                }
                        }
                        Button("Done") {
                            do { try reports.discard(); dismiss() }
                            catch { reports.error = error.localizedDescription }
                        }.disabled(reports.busy)
                    }
                } else {
                    reportFields
                }
                if let error = reports.error { Section { Text(error).foregroundStyle(.red).textSelection(.enabled) } }
                #if os(iOS)
                if UIDevice.current.userInterfaceIdiom == .phone {
                    Section {
                        Toggle("Shake iPhone to report a bug", isOn: $reports.shakeEnabled)
                    } footer: { Text("Shaking asks if you want to report a bug before opening this form. A report is sent only when you choose Report bug in the form.") }
                }
                #endif
            }
            .navigationTitle("Report a bug")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close") { saveDraft(); dismiss() }.disabled(reports.busy)
                }
                if reports.draft != nil && reports.draft?.evidenceSaved != true {
                    ToolbarItem(placement: .topBarTrailing) {
                        Button("Discard", role: .destructive) { showDiscard = true }.disabled(reports.busy)
                    }
                }
            }
            .confirmationDialog("Discard this report draft?", isPresented: $showDiscard, titleVisibility: .visible) {
                Button("Discard draft", role: .destructive) {
                    do { try reports.discard(); dismiss() }
                    catch { reports.error = error.localizedDescription }
                }
            } message: { Text(reports.draft?.taskSaved == true ? "The task already saved in Pathway will remain." : "Your description and unsent attachments will be removed.") }
            .task(id: "\(reports.draft?.companyID ?? ""):\(reports.draft?.projectID ?? "")") { await loadModels() }
            .task(id: photo) {
                guard let photo else { return }
                do {
                    guard let data = try await photo.loadTransferable(type: Data.self),
                          let image = UIImage(data: data), let jpeg = image.jpegData(compressionQuality: 0.8), jpeg.count <= 5 * 1024 * 1024 else {
                        throw PathwayIssueWriteError(message: "Choose a screenshot smaller than 5 MB.")
                    }
                    try reports.replaceScreenshot(jpeg)
                } catch { reports.error = error.localizedDescription }
            }
            .task(id: reports.draft) {
                do { try await Task.sleep(for: .milliseconds(300)); try reports.persist() }
                catch is CancellationError {} catch { reports.error = error.localizedDescription }
            }
            .onChange(of: reports.draft?.includeScreenshot) { saveDraft() }
            .onChange(of: reports.draft?.includeChat) { saveDraft() }
            .onDisappear { saveDraft() }
            .interactiveDismissDisabled(reports.busy)
        }
        .presentationDetents([.large])
        .presentationDragIndicator(.visible)
        .accessibilityIdentifier("bug-report-sheet")
    }

    @ViewBuilder private var reportFields: some View {
        Section {
            Text("Tell us what happened. Pathway will save a task with diagnostic evidence in your team's project.")
                .foregroundStyle(.secondary)
            TextField("What went wrong?", text: binding(\.description, default: ""), axis: .vertical)
                .lineLimit(4...10).disabled(reports.draft?.createAttempted == true || reports.busy)
                .accessibilityIdentifier("bug-report-description")
            PathwayBugReportDestinationPicker()
        }
        Section("Included diagnostics") {
            Text(reports.diagnosticSummary).font(.subheadline).foregroundStyle(.secondary)
            DisclosureGroup("Review diagnostics") {
                Text(reports.diagnosticText()).font(.caption.monospaced()).textSelection(.enabled)
            }
        }
        Section("Optional attachments") {
            if let data = reports.screenshot {
                Toggle("Include screenshot", isOn: binding(\.includeScreenshot, default: false))
                if reports.draft?.includeScreenshot == true, let image = UIImage(data: data) {
                    Image(uiImage: image).resizable().scaledToFit().frame(maxHeight: 220)
                        .accessibilityLabel("Screenshot to attach")
                }
            }
            PhotosPicker("Choose screenshot", selection: $photo, matching: .images)
            if reports.hasChat {
                Toggle("Include current conversation", isOn: binding(\.includeChat, default: false))
                if reports.draft?.includeChat == true {
                    DisclosureGroup("Review conversation") { Text(reports.chatText()).font(.caption).textSelection(.enabled) }
                }
            }
        }.disabled(reports.draft?.createAttempted == true || reports.busy)
        Section {
            Toggle("Investigate", isOn: binding(\.investigate, default: false))
            if reports.draft?.investigate == true {
                PathwayIssueModelSelectionPicker(selection: binding(\.modelSelection, default: .object([:])), providers: providers)
                if let environmentMessage { Text(environmentMessage).font(.caption).foregroundStyle(.secondary) }
            }
        } footer: { Text("An agent reads the code and diagnostics and adds findings to the task. Fixes are a separate action.") }
            .disabled(reports.busy)
        Section {
            Button {
                Task {
                    let project = appModel.cloud.projects.first {
                        $0.companyId == reports.draft?.companyID && $0.project.id == reports.draft?.projectID
                    }?.project
                    await reports.submit(using: appModel.cloud.issues, project: project)
                }
            } label: {
                HStack {
                    if reports.busy { ProgressView() }
                    Text(reports.draft?.taskSaved == true ? "Retry saving evidence" : "Report bug").frame(maxWidth: .infinity)
                }
            }
            .buttonStyle(.borderedProminent).controlSize(.large)
            .disabled(reports.busy || reports.draft?.description.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty != false || !destinationAvailable)
            if !destinationAvailable { Text("Choose an accessible destination project to submit.").font(.caption) }
        }
    }

    private var destinationAvailable: Bool {
        appModel.cloud.projects.contains { $0.companyId == reports.draft?.companyID && $0.project.id == reports.draft?.projectID && $0.project.archivedAt == nil }
    }
    private func saveDraft() {
        do { try reports.retainAttachments() } catch { reports.error = error.localizedDescription }
    }
    private func loadModels() async {
        providers = []; environmentMessage = nil
        guard let report = reports.draft, !report.companyID.isEmpty, !report.projectID.isEmpty else { return }
        do {
            let config = try await appModel.cloud.requestIssueEnvironment(companyID: report.companyID, projectID: report.projectID,
                                                                         method: "server.getConfig", payload: .object([:]))
            guard reports.draft?.companyID == report.companyID, reports.draft?.projectID == report.projectID else { return }
            providers = config.objectValue?["providers"]?.arrayValue ?? []
            if !pathwayIssueModelSelectionIsValid(reports.draft?.modelSelection ?? .null) {
                reports.draft?.modelSelection = config.objectValue?["settings"]?.objectValue?["issueEnrichmentModelSelection"] ?? .object([:])
            }
        } catch { environmentMessage = "The investigation environment is unavailable. You can save the report and investigate from the task later." }
    }
}

@MainActor func pathwayBugDevice() -> String { "\(UIDevice.current.model) · \(UIDevice.current.systemName) \(UIDevice.current.systemVersion)" }

@MainActor func pathwayBugScreenshot() -> Data? {
    #if os(iOS)
    guard let scene = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }).first(where: { $0.activationState == .foregroundActive }),
          let window = scene.windows.first(where: \.isKeyWindow) else { return nil }
    let format = UIGraphicsImageRendererFormat(); format.scale = 1
    return UIGraphicsImageRenderer(bounds: window.bounds, format: format).image { _ in
        window.drawHierarchy(in: window.bounds, afterScreenUpdates: false)
    }.jpegData(compressionQuality: 0.8)
    #else
    return nil
    #endif
}

#if os(iOS)
/// Hosting the shell keeps motion events in its responder chain, including while a field is focused.
struct PathwayShakeReporter<Content: View>: UIViewControllerRepresentable {
    let content: Content
    let enabled: Bool
    let onShake: () -> Void
    func makeUIViewController(context: Context) -> Controller {
        let controller = Controller(rootView: AnyView(content.environment(\.self, context.environment)))
        controller.onShake = onShake
        controller.setEnabled(enabled)
        return controller
    }
    func updateUIViewController(_ controller: Controller, context: Context) {
        controller.rootView = AnyView(content.environment(\.self, context.environment))
        controller.onShake = onShake
        controller.setEnabled(enabled)
    }
    static func dismantleUIViewController(_ controller: Controller, coordinator: ()) {
        UIApplication.shared.applicationSupportsShakeToEdit = controller.previousShakeToEdit
    }
    final class Controller: UIHostingController<AnyView> {
        var onShake: (() -> Void)?
        var enabled = false
        let previousShakeToEdit = UIApplication.shared.applicationSupportsShakeToEdit
        override var canBecomeFirstResponder: Bool { true }
        func setEnabled(_ value: Bool) {
            enabled = value
            UIApplication.shared.applicationSupportsShakeToEdit = value ? false : previousShakeToEdit
        }
        override func viewDidAppear(_ animated: Bool) { super.viewDidAppear(animated); becomeFirstResponder() }
        override func motionEnded(_ motion: UIEvent.EventSubtype, with event: UIEvent?) {
            if enabled && motion == .motionShake { onShake?() } else { super.motionEnded(motion, with: event) }
        }
    }
}
#endif
