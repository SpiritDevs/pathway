import SwiftUI

/// Settings → Xcode: installs, selection, platforms and the Apple ID session on one environment's
/// Mac. Everything runs on that Mac, never on this device.
struct PathwayXcodeSettingsView: View {
    @Environment(PathwayAppModel.self) private var appModel
    @State private var selectedID: String?

    private var environments: [PathwayCompanyEnvironment] {
        appModel.cloud.environments.filter { $0.environment.state == "active" }
    }

    private var selected: PathwayCompanyEnvironment? {
        environments.first { $0.id == selectedID } ?? environments.first
    }

    var body: some View {
        Form {
            Section {
                Text("Xcode installs on the Mac that runs the environment, not on this device. Installs keep running when you close Pathway.")
                    .foregroundStyle(.secondary)
                if environments.isEmpty {
                    Text("Connect to an environment running on a Mac to manage Xcode.")
                        .foregroundStyle(.secondary)
                } else if environments.count > 1 {
                    Picker("Manage Xcode on", selection: Binding(
                        get: { selected?.id ?? "" },
                        set: { selectedID = $0 }
                    )) {
                        ForEach(environments) { environment in
                            Text(environmentName(environment)).tag(environment.id)
                        }
                    }
                } else if let selected {
                    LabeledContent("Environment", value: environmentName(selected))
                }
            }
            if let selected {
                PathwayXcodeEnvironmentSections(model: makeModel(selected), hostName: selected.environment.label)
                    .id(selected.id)
            }
        }
        .navigationTitle("Xcode")
        .accessibilityIdentifier("pathway-xcode-settings")
    }

    private func environmentName(_ environment: PathwayCompanyEnvironment) -> String {
        let label = environment.environment.label
        let sameLabel = environments.filter { $0.environment.label == label }.count > 1
        guard sameLabel, let company = appModel.cloud.companies.first(where: { $0.id == environment.companyId }) else {
            return label
        }
        return "\(label) · \(company.name)"
    }

    private func makeModel(_ environment: PathwayCompanyEnvironment) -> PathwayXcodeModel {
        let cloud = appModel.cloud
        let organization = cloud.companies.first { $0.id == environment.companyId }?.workspaceKind == "organization"
        return PathwayXcodeModel(
            environmentID: environment.environment.environmentId,
            environmentCompanyID: environment.companyId,
            accountsCompanyID: organization ? environment.companyId : nil,
            request: { method, payload, timeout in
                try await cloud.environmentOperation(environment: environment, method: method, payload: payload, timeout: timeout)
            },
            subscribe: { method, payload in
                await cloud.environmentSubscription(environment: environment, method: method, payload: payload)
            },
            cloudSubscribe: { name, arguments in
                cloud.subscribe(name: name, arguments: arguments)
            }
        )
    }
}

/// The sections for one environment. Its streams run only while this view is on screen.
private struct PathwayXcodeEnvironmentSections: View {
    @State private var model: PathwayXcodeModel
    let hostName: String

    init(model: PathwayXcodeModel, hostName: String) {
        _model = State(initialValue: model)
        self.hostName = hostName
    }

    private var announcement: String { PathwayXcodeRules.announcement(model.job, status: model.status) }

    var body: some View {
        content
            .task { await model.observeAccounts() }
            .task(id: LiveKey(target: model.target, generation: model.liveGeneration)) {
                guard let target = model.target else { return }
                await model.observeLive(target)
            }
            .onChange(of: announcement) { _, text in
                guard !text.isEmpty else { return }
                AccessibilityNotification.Announcement(text).post()
            }
    }

    @ViewBuilder private var content: some View {
        if model.status?.host == "needs-mac" {
            Section("This environment") {
                Text("Xcode needs a Mac. \(hostName) is not a Mac, so choose an environment running on a Mac.")
                    .foregroundStyle(.secondary)
            }
        } else {
            Section {
                PathwayXcodeAccountPicker(model: model)
                if model.target != nil {
                    PathwayAppleIdSignIn(model: model, hostName: hostName)
                }
            } header: {
                Text("Apple ID")
            } footer: {
                Text("\(hostName) downloads Xcode with this Apple ID.")
            }
            if model.target != nil { inventory }
        }
    }

    @ViewBuilder private var inventory: some View {
        if let error = model.viewError {
            Section("Installed Xcodes") {
                Text(error).foregroundStyle(.red)
                Button("Try again") { model.tryAgain() }
            }
        } else if let status = model.status {
            let busy = PathwayXcodeRules.isActive(model.job)
            if let job = model.job, job.state != .completed {
                Section("Current job") { PathwayXcodeJobCard(model: model, job: job, status: status, hostName: hostName) }
            }
            Section("Installed Xcodes") { PathwayXcodeInstalledList(model: model, status: status, busy: busy) }
            Section("Platforms") { PathwayXcodeRuntimes(model: model, status: status, busy: busy) }
            Section("Install Xcode") {
                if busy {
                    Text("Finish or cancel the current job to install another version.").foregroundStyle(.secondary)
                } else if model.signedIn {
                    PathwayXcodeInstallChooser(model: model, status: status)
                } else {
                    Text("Sign in to your Apple ID above to download Xcode.").foregroundStyle(.secondary)
                }
            }
        } else {
            Section("Installed Xcodes") {
                Text("Checking Xcode on \(hostName)…").foregroundStyle(.secondary)
            }
        }
    }

    private struct LiveKey: Hashable {
        let target: PathwayXcodeTarget?
        let generation: Int
    }
}

private struct PathwayXcodeAccountPicker: View {
    @Bindable var model: PathwayXcodeModel

    var body: some View {
        if let error = model.accountsError {
            Text(error).foregroundStyle(.red)
        } else if let accounts = model.accounts {
            if accounts.isEmpty {
                Text("Add your Apple ID first in Settings → Apple accounts in Pathway on the web or desktop. Pathway uses it to download Xcode from Apple.")
                    .foregroundStyle(.secondary)
            } else if accounts.count == 1, let account = model.account {
                LabeledContent("Apple ID", value: account.label)
            } else {
                Picker("Apple ID", selection: Binding(
                    get: { model.account?.id ?? "" },
                    set: { model.choose(accountID: $0) }
                )) {
                    ForEach(accounts) { Text($0.label).tag($0.id) }
                }
                .accessibilityLabel("Apple ID for Xcode")
            }
        } else {
            Text("Loading Apple accounts…").foregroundStyle(.secondary)
        }
    }
}

/// Password, then Apple's two-factor code. The password goes to the environment for this attempt
/// only; every watching client sees the same challenge.
private struct PathwayAppleIdSignIn: View {
    let model: PathwayXcodeModel
    let hostName: String

    private var email: String { model.account?.email ?? "your Apple ID" }

    var body: some View {
        switch PathwayXcodeRules.signInStage(session: model.session, error: model.sessionError, signInAgain: model.signInAgain) {
        case .unavailable:
            Text("Could not read the Apple ID session on \(hostName). \(model.sessionError ?? "")").foregroundStyle(.red)
            Button("Try again") { model.tryAgain() }
        case .checking:
            Text("Checking Apple ID…").foregroundStyle(.secondary)
        case .authenticated:
            Label("Signed in as \(email)", systemImage: "checkmark.shield")
            Text("Pathway keeps this Apple session sealed in your account so \(hostName) can resume downloads. Sign out to end it.")
                .font(.footnote).foregroundStyle(.secondary)
            Button(model.pending == "sign-out" ? "Signing out…" : "Sign out", role: .destructive) {
                Task { await model.signOut() }
            }
            .disabled(model.pending != nil)
            PathwayXcodeActionError(model: model)
        case .authenticating:
            if case let .authenticating(flowID, _) = model.session {
                Text("Signing in to Apple…").foregroundStyle(.secondary)
                Button(model.pending == "cancel-sign-in" ? "Cancelling…" : "Cancel") {
                    Task { await model.cancelSignIn(flowID: flowID) }
                }
                .disabled(!model.canCancelSignIn)
                PathwayXcodeActionError(model: model)
            }
        case .challenge:
            if case let .challenge(challenge) = model.session {
                PathwayAppleIdChallengeView(model: model, challenge: challenge).id(challenge.flowId)
            }
        case .password:
            // A password typed for one Apple ID must never be submitted for another.
            PathwayAppleIdPasswordForm(model: model, email: email, hostName: hostName, notice: notice)
                .id(model.target)
        }
    }

    private var notice: String? {
        switch model.session {
        case .expired: "Your Apple ID session expired. Sign in again to continue."
        case let .failed(failure):
            failure.code == "rate-limited" && failure.retryAfterSeconds != nil
                ? "Apple is rate limiting sign-in. Try again in \(Int((failure.retryAfterSeconds ?? 0).rounded(.up))) seconds."
                : failure.message.isEmpty ? "Apple sign-in failed." : failure.message
        default: nil
        }
    }
}

/// Mounted only while a password is wanted, so leaving this stage discards anything typed.
private struct PathwayAppleIdPasswordForm: View {
    let model: PathwayXcodeModel
    let email: String
    let hostName: String
    let notice: String?
    @State private var password = ""

    var body: some View {
        if let notice { Text(notice).foregroundStyle(.red) }
        Text("Sign in to \(email) so \(hostName) can download Xcode from Apple. Your password is used for this sign-in only and is never stored.")
            .font(.footnote).foregroundStyle(.secondary)
        SecureField("Apple ID password", text: $password)
            .textContentType(.password)
            .disabled(model.pending != nil)
            .onSubmit(submit)
        PathwayXcodeActionError(model: model)
        Button(model.pending == "start" ? "Signing in…" : "Sign in", action: submit)
            .disabled(model.pending != nil || password.isEmpty)
        if model.signInAgain {
            Button("Cancel") { model.replacingSession = nil }
        }
    }

    private func submit() {
        guard !password.isEmpty, model.pending == nil else { return }
        let submitted = password
        password = ""
        Task { await model.signIn(password: submitted) }
    }
}

private struct PathwayAppleIdChallengeView: View {
    let model: PathwayXcodeModel
    let challenge: PathwayAppleIdSession.Challenge
    @State private var code = ""
    @State private var phoneID: Int?
    @State private var expired = false

    var body: some View {
        Group {
            if expired {
                Text("The verification code request expired. Start again to get a new code.").foregroundStyle(.red)
                cancelButton
            } else if challenge.kind == .smsChoice {
                Text("Choose where Apple should text a verification code.").foregroundStyle(.secondary)
                phonePicker
                Button(model.pending == "send" ? "Sending…" : "Text me a code", action: sendCode)
                    .disabled(model.pending != nil || phoneID == nil)
                cancelButton
            } else {
                Text(prompt).font(.footnote).foregroundStyle(.secondary)
                TextField("Verification code", text: $code)
                    .textContentType(.oneTimeCode)
                    .keyboardType(.numberPad)
                    .disabled(model.pending != nil)
                    .onChange(of: code) { _, value in
                        let trimmed = String(value.filter { !$0.isWhitespace }.prefix(8))
                        if trimmed != value { code = trimmed }
                    }
                    .onSubmit(verify)
                Button(model.pending == "complete" ? "Verifying…" : "Verify", action: verify)
                    .disabled(model.pending != nil || code.isEmpty)
                cancelButton
                if !challenge.phoneNumbers.isEmpty {
                    phonePicker
                    Button(model.pending == "send" ? "Sending…" : "Send code", action: sendCode)
                        .disabled(model.pending != nil || phoneID == nil)
                }
            }
            PathwayXcodeActionError(model: model)
        }
        .onAppear {
            phoneID = challenge.phoneNumbers.first { $0.destination == challenge.destination }?.id
                ?? challenge.phoneNumbers.first?.id
        }
        // One wake at the deadline, so a stale challenge stops accepting codes without a ticking clock.
        .task(id: challenge.expiresAt) {
            let remaining = challenge.expiresAt / 1000 - Date().timeIntervalSince1970
            if remaining > 0 { try? await Task.sleep(for: .seconds(remaining + 0.05)) }
            if !Task.isCancelled { expired = true }
        }
    }

    private var prompt: String {
        let expiry = Date(timeIntervalSince1970: challenge.expiresAt / 1000).formatted(date: .omitted, time: .shortened)
        let request = challenge.kind == .trustedDevice
            ? "Enter the verification code shown on your other Apple devices."
            : "Enter the verification code Apple texted to \(challenge.destination ?? "your phone")."
        return "\(request) The request expires at \(expiry)."
    }

    private var phonePicker: some View {
        Picker(challenge.kind == .sms ? "Didn't get it? Resend to" : "Or text a code to", selection: $phoneID) {
            ForEach(challenge.phoneNumbers) { Text($0.destination).tag(Optional($0.id)) }
        }
    }

    private var cancelButton: some View {
        Button(expired ? "Start again" : (model.pending == "cancel-sign-in" ? "Cancelling…" : "Cancel")) {
            Task { await model.cancelSignIn(flowID: challenge.flowId) }
        }
        .disabled(model.pending != nil)
    }

    private func sendCode() {
        guard let phoneID else { return }
        Task { await model.requestCode(flowID: challenge.flowId, phoneNumberID: phoneID) }
    }

    private func verify() {
        let submitted = code.trimmingCharacters(in: .whitespaces)
        guard !submitted.isEmpty, model.pending == nil else { return }
        Task { if await model.complete(flowID: challenge.flowId, code: submitted) { code = "" } }
    }
}

struct PathwayXcodeActionError: View {
    let model: PathwayXcodeModel

    var body: some View {
        if let error = model.actionError {
            Text(error).font(.footnote).foregroundStyle(.red)
        }
    }
}
