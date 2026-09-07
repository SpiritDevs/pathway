import SwiftUI

struct PathwayConnectedMailSettings: View {
  @Environment(\.dismiss) private var dismiss
  @Bindable var model: PathwayConnectedMailModel
  let companyID: String
  let environments: [PathwayCompanyEnvironment]
  @State private var disconnect: PathwayMailAccount?
  @State private var error: String?
  @State private var busy = false
  var body: some View {
    Form {
      Section("Connected accounts") {
        ForEach(model.accounts) { account in
          VStack(alignment: .leading, spacing: 5) {
            Text(account.email)
            Text(
              account.status == "reauth_required"
                ? "Reconnect required" : account.lastSyncAt == nil ? "Importing mail" : "Connected"
            ).font(.caption).foregroundStyle(.secondary)
            if let error = account.lastError { Text(error).font(.caption).foregroundStyle(.red) }
            NavigationLink("Sender rules") {
              PathwayMailSenderRulesView(model: model, companyID: companyID, accountID: account.id)
            }
            NavigationLink("Mail analysis") {
              PathwayMailBrainSettings(
                model: model, companyID: companyID, account: account, environments: environments)
            }
            if account.brain != nil {
              Button("Pause analysis") {
                Task {
                  busy = true
                  defer { busy = false }
                  do {
                    _ = try await model.mutate(
                      "mail:disableBrain", companyID: companyID,
                      fields: ["accountId": .string(account.id)])
                  } catch { self.error = error.localizedDescription }
                }
              }.disabled(busy)
            } else {
              Text(
                "Analysis is paused. Mail continues to arrive. Save analysis settings to enable it."
              ).font(.caption).foregroundStyle(.secondary)
            }
            Button("Disconnect", role: .destructive) { disconnect = account }.disabled(busy)
          }
        }
      }
      Section("Connect Gmail") {
        Link(
          "Open Gmail setup on web",
          destination: URL(string: "https://app.spiritdevs.com/settings/email")!)
        Text(
          "Open Email settings on Pathway web and select the same workspace to connect or reconnect Gmail. Once connected, mail appears here automatically."
        )
        Text(
          "Mail and sender knowledge are private to you. Each message gets a Priority or Noise bucket and a reason. Priority messages get a briefing."
        ).foregroundStyle(.secondary)
      }
      if let error { Text(error).foregroundStyle(.red) }
    }
    .navigationTitle("Mail settings")
    .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
    .confirmationDialog(
      "Disconnect Gmail?",
      isPresented: Binding(get: { disconnect != nil }, set: { if !$0 { disconnect = nil } }),
      titleVisibility: .visible
    ) {
      Button("Disconnect and remove copied mail", role: .destructive) {
        guard let account = disconnect else { return }
        Task {
          busy = true
          defer { busy = false }
          do {
            _ = try await model.relay(
              "disconnect", companyID: companyID, fields: ["accountId": .string(account.id)])
            disconnect = nil
          } catch { self.error = error.localizedDescription }
        }
      }
      Button("Cancel", role: .cancel) { disconnect = nil }
    } message: {
      Text(
        "Copied messages, drafts, and private sender knowledge are removed from Pathway. Gmail messages are unaffected."
      )
    }
  }
}

private struct PathwayMailBrainSettings: View {
  @Bindable var model: PathwayConnectedMailModel
  let companyID: String
  let account: PathwayMailAccount
  let environments: [PathwayCompanyEnvironment]
  @State private var primaryID = ""
  @State private var backupID = ""
  @State private var selection: JSONValue = .null
  @State private var backupSelection: JSONValue = .null
  @State private var providers: [JSONValue] = []
  @State private var backupProviders: [JSONValue] = []
  @State private var error: String?
  @State private var busy = false
  @State private var saved = false
  @State private var initialized = false
  @State private var loadedPrimaryID = ""
  @State private var loadedBackupID = ""
  var body: some View {
    Form {
      Section("Primary environment") {
        Picker("Environment", selection: $primaryID) {
          Text("Choose environment").tag("")
          ForEach(environments) { Text($0.environment.label).tag($0.environment.environmentId) }
        }
        PathwayIssueModelSelectionPicker(selection: $selection, providers: providers)
      }
      Section("Backup environment") {
        Picker("Environment", selection: $backupID) {
          Text("No backup").tag("")
          ForEach(environments.filter { $0.environment.environmentId != primaryID }) {
            Text($0.environment.label).tag($0.environment.environmentId)
          }
        }
        if !backupID.isEmpty {
          PathwayIssueModelSelectionPicker(selection: $backupSelection, providers: backupProviders)
        }
      }
      Text(
        "The selected model stays pinned. The backup takes over if the primary is unavailable. Mail continues to arrive when both are offline."
      ).foregroundStyle(.secondary)
      Button("Save analysis settings") {
        Task {
          busy = true
          error = nil
          saved = false
          defer { busy = false }
          do {
            var brain: [String: JSONValue] = [
              "primaryEnvironmentId": .string(primaryID), "selection": selection,
            ]
            if !backupID.isEmpty {
              brain["backupEnvironmentId"] = .string(backupID)
              brain["backupSelection"] = backupSelection
            }
            _ = try await model.mutate(
              "mail:configureBrain", companyID: companyID,
              fields: ["accountId": .string(account.id), "brain": .object(brain)])
            saved = true
          } catch { self.error = error.localizedDescription }
        }
      }.disabled(
        busy || !available(selection, in: providers) || primaryID.isEmpty || primaryID == backupID
          || (!backupID.isEmpty && !available(backupSelection, in: backupProviders)))
      if saved { Text("Analysis settings saved.").foregroundStyle(.secondary) }
      if let error { Text(error).foregroundStyle(.red) }
    }
    .navigationTitle("Mail analysis")
    .onAppear {
      guard !initialized else { return }
      initialized = true
      let brain = account.brain?.objectValue
      primaryID =
        brain?["primaryEnvironmentId"]?.stringValue ?? environments.first?.environment.environmentId
        ?? ""
      backupID = brain?["backupEnvironmentId"]?.stringValue ?? ""
      selection = brain?["selection"] ?? .null
      backupSelection = brain?["backupSelection"] ?? .null
    }
    .task(id: primaryID) { await load(primaryID, backup: false) }
    .task(id: backupID) { await load(backupID, backup: true) }
  }
  private func available(_ value: JSONValue, in providers: [JSONValue]) -> Bool {
    guard let instance = value.objectValue?["instanceId"]?.stringValue,
      let model = value.objectValue?["model"]?.stringValue
    else { return false }
    return providers.contains { provider in
      provider.objectValue?["instanceId"]?.stringValue == instance
        && (provider.objectValue?["models"]?.arrayValue ?? []).contains {
          $0.objectValue?["slug"]?.stringValue == model
        }
    }
  }
  private func valid(_ value: JSONValue) -> Bool {
    !(value.objectValue?["instanceId"]?.stringValue ?? "").isEmpty
      && !(value.objectValue?["model"]?.stringValue ?? "").isEmpty
  }
  private func load(_ id: String, backup: Bool) async {
    if backup {
      backupProviders = []
      if !loadedBackupID.isEmpty && loadedBackupID != id { backupSelection = .null }
      loadedBackupID = id
    } else {
      providers = []
      if !loadedPrimaryID.isEmpty && loadedPrimaryID != id { selection = .null }
      loadedPrimaryID = id
    }
    guard let environment = environments.first(where: { $0.environment.environmentId == id }) else {
      return
    }
    do {
      let config = try await model.configuration(environment: environment).objectValue ?? [:]
      guard !Task.isCancelled else { return }
      let rows = (config["providers"]?.arrayValue ?? []).filter {
        ["codex", "claudeAgent", "opencode"].contains($0.objectValue?["driver"]?.stringValue ?? "")
      }
      let defaultSelection =
        config["settings"]?.objectValue?["textGenerationModelSelection"] ?? .null
      if backup {
        backupProviders = rows
        if !valid(backupSelection) {
          if let primaryModel = selection.objectValue?["model"]?.stringValue,
            let matched = rows.first(where: {
              ($0.objectValue?["models"]?.arrayValue ?? []).contains {
                $0.objectValue?["slug"]?.stringValue == primaryModel
              }
            }), let instance = matched.objectValue?["instanceId"]?.stringValue
          {
            backupSelection = .object([
              "instanceId": .string(instance), "model": .string(primaryModel),
            ])
          } else {
            backupSelection = defaultSelection
          }
        }
      } else {
        providers = rows
        if !valid(selection) { selection = defaultSelection }
      }
    } catch { if !Task.isCancelled { self.error = error.localizedDescription } }
  }
}

private struct PathwayMailSenderRulesView: View {
  @Bindable var model: PathwayConnectedMailModel
  let companyID: String
  let accountID: String
  @State private var rules: [Rule] = []
  @State private var error: String?
  @State private var busy = false
  private struct Rule: Decodable, Identifiable {
    let email: String
    let bucket: String
    var id: String { email }
  }
  var body: some View {
    List {
      Text("Removing a rule lets the model classify future messages from that sender.")
        .foregroundStyle(.secondary)
      ForEach(rules) { rule in
        HStack {
          VStack(alignment: .leading) {
            Text(rule.email)
            Text(rule.bucket.capitalized).font(.caption).foregroundStyle(.secondary)
          }
          Spacer()
          Button("Remove") {
            Task {
              busy = true
              defer { busy = false }
              do {
                _ = try await model.mutate(
                  "mail:removeSenderRule", companyID: companyID,
                  fields: ["accountId": .string(accountID), "email": .string(rule.email)])
              } catch { self.error = error.localizedDescription }
            }
          }.disabled(busy)
        }
      }
      if rules.isEmpty { Text("No sender rules.").foregroundStyle(.secondary) }
      if let error { Text(error).foregroundStyle(.red) }
    }
    .navigationTitle("Sender rules")
    .task(id: accountID) {
      do {
        try await model.observe(
          [Rule].self, name: "mail:listSenderRules", companyID: companyID,
          fields: ["accountId": .string(accountID)]
        ) { rules = $0 }
      } catch {
        if !Task.isCancelled {
          rules = []
          self.error = error.localizedDescription
        }
      }
    }
  }
}
