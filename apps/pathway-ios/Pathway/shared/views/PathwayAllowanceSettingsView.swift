import SwiftUI

/// Cloud account allocations use the same runtime guard as web and desktop.
struct PathwayAllowanceSettingsView: View {
  let environmentID: String
  let provider: PathwayAdministrationProvider
  @State private var selectedWork = ""
  @State private var accountKey: String?
  private var thread: PathwayAgentThread? {
    appModel.cloud.threads.first {
      $0.environmentId == environmentID && "thread:\($0.threadId)" == selectedWork
    }
  }
  private var threadChoices: [PathwayAgentThread] {
    appModel.cloud.threads.filter { $0.environmentId == environmentID }
  }
  @Environment(PathwayAppModel.self) private var appModel
  @State private var companyID = ""
  private var chatID: String {
    selectedWork.hasPrefix("chat:") ? String(selectedWork.dropFirst(5)) : ""
  }
  @State private var budgets: [PathwayOrchestratorRecord] = []
  @State private var editing = false
  @State private var renewal: PathwayOrchestratorRecord?
  @State private var error: String?
  @State private var saving = false
  private var model: PathwayOrchestratorsModel { appModel.cloud.orchestrators }
  private var chats: [PathwayOrchestratorRecord] {
    model.chats.filter {
      $0.string("ownerSubject") == appModel.accountID
    }
  }
  private var scopes: [JSONValue] {
    if let thread {
      return [
        .object([
          "kind": .string("thread"), "environmentId": .string(thread.environmentId),
          "threadId": .string(thread.threadId),
        ])
      ]
    }
    return [.object(["kind": .string("chat"), "chatId": .string(chatID)])]
  }
  private var visibleBudgets: [PathwayOrchestratorRecord] {
    budgets.filter { budget in
      let matchesAccount = (budget.fields["allocations"]?.arrayValue ?? []).contains {
        $0.objectValue?["provider"]?.stringValue == provider.driver
          && $0.objectValue?["accountKey"]?.stringValue == accountKey && accountKey != nil
      }
      return matchesAccount
        && (budget.fields["scopes"]?.arrayValue ?? []).contains { scope in
          if let thread {
            return scope.objectValue?["environmentId"]?.stringValue == thread.environmentId
              && scope.objectValue?["threadId"]?.stringValue == thread.threadId
          }
          return scope.objectValue?["chatId"]?.stringValue == chatID
        }
    }
  }
  var body: some View {
    Form {
      Section {
        Picker("Workspace", selection: $companyID) {
          ForEach(appModel.cloud.companies) { Text($0.name).tag($0.id) }
        }
        Picker("Thread or conversation", selection: $selectedWork) {
          Text("Choose work to manage").tag("")
          ForEach(threadChoices, id: \.threadId) { thread in
            Text("Thread · \(thread.shell.title)").tag("thread:\(thread.threadId)")
          }
          ForEach(chats) { chat in
            Text("Conversation · \(chat.string("title"))").tag("chat:\(chat.id)")
          }
        }
        if accountKey == nil {
          Text("Connect this provider account to load its allowance readings.")
            .font(.footnote).foregroundStyle(.secondary)
        }
        Text(
          "Percentage points refer to the full provider window: 10 points takes 60% remaining to 50%. All activity on the account counts. Delayed readings can allow overshoot."
        ).font(.footnote).foregroundStyle(.secondary)
      }
      if let error { Text(error).foregroundStyle(.red) }
      ForEach(visibleBudgets) { budget in
        Section(budget.string("title")) {
          if (budget.fields["allocations"]?.arrayValue ?? []).contains(where: {
            $0.objectValue?["provider"]?.stringValue != provider.driver
              || $0.objectValue?["accountKey"]?.stringValue != accountKey
          }) {
            Text(
              "This allowance also covers other accounts. Actions below apply to the whole allowance."
            ).font(.footnote).foregroundStyle(.secondary)
          }
          if let schedule = budget.fields["scheduledResume"]?.objectValue,
            let at = schedule["at"]?.numericValue
          {
            Text(
              "Resume once: \(Date(timeIntervalSince1970: at / 1000).formatted(Date.FormatStyle(date: .abbreviated, time: .shortened, timeZone: TimeZone(identifier: schedule["timeZone"]?.stringValue ?? "") ?? .current))) · \(schedule["timeZone"]?.stringValue ?? "")"
            )
            .font(.footnote)
            ForEach(Array((schedule["allocations"]?.arrayValue ?? []).enumerated()), id: \.offset) {
              _, value in
              if let allocation = value.objectValue {
                Text(
                  "\(allocation["provider"]?.stringValue ?? "Provider") · \(allocation["windowLabel"]?.stringValue ?? "Account window") · \(Int(allocation["authorizedPercent"]?.numericValue ?? 0)) new percentage points"
                )
                .font(.footnote)
              }
            }
            Text("If the resume is missed by more than an hour, work stays held.")
              .font(.footnote).foregroundStyle(.secondary)
            Button("Cancel scheduled resume") { change("cancelScheduledResume", budget: budget) }
          }
          Text(
            budget.string("status") == "closed"
              ? "Limit removed" : budget.string("status").capitalized)
          ForEach(
            Array((budget.fields["allocations"]?.arrayValue ?? []).enumerated()), id: \.offset
          ) { _, value in allocation(value, budget: budget) }
          if budget.string("status") == "active" {
            Button("Pause work") { change("pause", budget: budget) }
          }
          Button("Authorize new allocation") {
            renewal = budget
            editing = true
          }
          if budget.string("status") != "closed" {
            Button("Remove limit and resume") { change("close", budget: budget) }
          }
        }
      }
      Section {
        Button("Set allowance") {
          renewal = nil
          editing = true
        }.disabled(
          companyID.isEmpty || (thread == nil && !chats.contains(where: { $0.id == chatID }))
            || accountKey == nil)
      }
    }
    .navigationTitle("\(provider.name) allowance")
    .disabled(saving)
    .onChange(of: appModel.accountID) { _, _ in
      budgets = []
      editing = false
      renewal = nil
      companyID = ""
      selectedWork = ""
      accountKey = nil
      error = nil
    }
    .onChange(of: companyID) { _, _ in
      selectedWork = ""
      editing = false
      renewal = nil
    }
    .onAppear {
      if companyID.isEmpty {
        companyID = thread?.companyId ?? appModel.cloud.companies.first?.id ?? ""
      }
    }
    .task(id: "\(appModel.accountID ?? ""):\(environmentID):\(provider.instanceId)") {
      accountKey = nil
      guard
        let environment = appModel.cloud.environments.first(where: {
          $0.environment.environmentId == environmentID
        })
      else { return }
      do {
        let snapshot = try await appModel.cloud.environmentRequest(
          environment: environment, method: "server.getProviderUsage",
          payload: .object([
            "instanceId": .string(provider.instanceId), "provider": .string(provider.driver),
          ]))
        try Task.checkCancellation()
        accountKey = snapshot.objectValue?["accountKey"]?.stringValue
      } catch is CancellationError {} catch { self.error = error.localizedDescription }
    }
    .task(id: "\(appModel.accountID ?? ""):\(companyID)") {
      budgets = []
      guard !companyID.isEmpty else { return }
      do {
        for try await value in model.allowanceUpdates(companyID: companyID) {
          try Task.checkCancellation()
          budgets = PathwayOrchestratorRecord.records(value)
        }
      } catch is CancellationError {} catch {
        budgets = []
        self.error = error.localizedDescription
      }
    }
    .sheet(isPresented: $editing) {
      NavigationStack {
        PathwayAllowanceEditor(
          companyID: companyID, scopes: scopes,
          title: thread?.shell.title ?? chats.first(where: { $0.id == chatID })?.string("title")
            ?? "Conversation allowance", renewal: renewal,
          initialEnvironmentID: environmentID,
          provider: provider,
          accountKey: accountKey)
      }
    }
  }
  @ViewBuilder private func allocation(_ value: JSONValue, budget: PathwayOrchestratorRecord)
    -> some View
  {
    let fields = value.objectValue ?? [:]
    let baseline = fields["baselineUsedPercent"]?.numericValue ?? 0
    let used = max(0, (fields["observedUsedPercent"]?.numericValue ?? baseline) - baseline)
    let authorized = fields["authorizedPercent"]?.numericValue ?? 0
    VStack(alignment: .leading, spacing: 6) {
      Text("\(fields["provider"]?.stringValue ?? "") · \(fields["windowLabel"]?.stringValue ?? "")")
      ProgressView(value: min(used, authorized), total: max(authorized, 1)).accessibilityLabel(
        "Allowance consumed")
      Text(
        "\(used.formatted()) / \(authorized.formatted()) points · \((100-baseline).formatted())% → \(max(0, 100-baseline-authorized).formatted())% remaining"
      ).font(.caption)
      if budget.string("status") == "paused" {
        Text("Allocation retained").font(.caption).foregroundStyle(.secondary)
      } else if fields["state"]?.stringValue != "ready" {
        Text(fields["detail"]?.stringValue ?? "").font(.caption).foregroundStyle(.secondary)
      }
      if used > authorized {
        Text("Observed overshoot: \((used-authorized).formatted()) points").font(.caption)
          .foregroundStyle(.orange)
      }
    }
  }
  private func change(_ operation: String, budget: PathwayOrchestratorRecord) {
    saving = true
    let accountID = appModel.accountID
    let workspace = companyID
    Task {
      defer { saving = false }
      guard accountID == appModel.accountID else { return }
      do {
        try await model.changeAllowance(
          operation, ["companyId": .string(workspace), "budgetId": .string(budget.id)])
      } catch {
        if accountID == appModel.accountID && workspace == companyID {
          self.error = error.localizedDescription
        }
      }
    }
  }
}

private struct PathwayAllowanceEditor: View {
  let companyID: String
  let scopes: [JSONValue]
  let title: String
  let renewal: PathwayOrchestratorRecord?
  let initialEnvironmentID: String
  let provider: PathwayAdministrationProvider
  let accountKey: String?
  private var multipleAccounts: Bool {
    (renewal?.fields["allocations"]?.arrayValue ?? []).contains {
      $0.objectValue?["provider"]?.stringValue != provider.driver
        || $0.objectValue?["accountKey"]?.stringValue != accountKey
    }
  }
  @Environment(PathwayAppModel.self) private var appModel
  @Environment(\.dismiss) private var dismiss
  @State private var environmentID = ""
  @State private var snapshots: [JSONValue] = []
  @State private var selected = ""
  @State private var percent = ""
  @State private var choices: [Choice] = []
  @State private var error: String?
  @State private var busy = false
  @State private var budgetID = UUID().uuidString
  @State private var readingID = UUID()
  @State private var scheduleResume = false
  @State private var resumeAt = Date().addingTimeInterval(3600)
  @State private var resumeZone = TimeZone.current.identifier
  struct Choice: Identifiable {
    let environmentID: String
    let instanceID: String
    let provider: String
    let windowKey: String
    let label: String
    let percent: Double
    var id: String { environmentID + ":" + instanceID + ":" + windowKey }
  }
  struct Window: Identifiable {
    let snapshot: [String: JSONValue]
    let limit: [String: JSONValue]
    var key: String {
      let fields: [JSONValue] = [
        limit["limitId"] ?? limit["windowKey"] ?? limit["window"] ?? .string(""),
        limit["scope"] ?? .string(""), limit["lane"] ?? .string(""),
        limit["windowDurationMins"] ?? .null,
      ]
      let encoder = JSONEncoder()
      encoder.outputFormatting = [.withoutEscapingSlashes]
      return (try? String(data: encoder.encode(JSONValue.array(fields)), encoding: .utf8)) ?? ""
    }
    var id: String { (snapshot["instanceId"]?.stringValue ?? "") + ":" + key }
    var label: String {
      "\(snapshot["instanceId"]?.stringValue ?? "") · \(limit["window"]?.stringValue ?? "")"
    }
  }
  private var windows: [Window] {
    snapshots.flatMap { value in
      let snapshot = value.objectValue ?? [:]
      return (snapshot["limits"]?.arrayValue ?? []).compactMap {
        $0.objectValue.map { Window(snapshot: snapshot, limit: $0) }
      }
    }
  }
  private var window: Window? { windows.first { $0.id == selected } ?? windows.first }
  var body: some View {
    Form {
      Section {
        if multipleAccounts {
          Text(
            "This allowance covers multiple accounts. Renew every account you want included; authorizing replaces the whole allocation."
          ).font(.footnote).foregroundStyle(.secondary)
          Picker("Environment", selection: $environmentID) {
            ForEach(appModel.cloud.environments) {
              Text($0.environment.label).tag($0.environment.environmentId)
            }
          }
        }
        Picker("Account window", selection: $selected) {
          ForEach(windows) { Text($0.label).tag($0.id) }
        }
        TextField("Allowance in percentage points", text: $percent).keyboardType(.decimalPad)
        if let used = window?.limit["usedPercent"]?.numericValue, let points = Double(percent),
          points > 0 && points <= 100
        {
          Text("\((100-used).formatted())% → \(max(0,100-used-points).formatted())% remaining")
            .font(.footnote)
        }
        Button("Refresh reading") { Task { await load() } }
        Button("Add account window") { add() }.disabled(window == nil || choices.count >= 8)
        Text(
          "A fresh reading with a stable account identity and reset boundary is required. Each fallback account needs an allocation; a quota reset does not renew it."
        ).font(.footnote).foregroundStyle(.secondary)
      }
      if let error { Text(error).foregroundStyle(.red) }
      ForEach(choices) { choice in
        Section {
          Text("\(choice.label): \(choice.percent.formatted()) points")
          Button("Remove") { choices.removeAll { $0.id == choice.id } }
        }
      }
      if let renewal, renewal.string("status") != "closed" {
        Section("Resume time") {
          Toggle("Resume at a chosen time", isOn: $scheduleResume)
          if scheduleResume {
            TextField("Timezone", text: $resumeZone)
            DatePicker("Resume once", selection: $resumeAt, in: Date()...)
              .environment(\.timeZone, TimeZone(identifier: resumeZone) ?? .current)
            Text(
              "Pauses work now and authorizes the selected allowance once, from fresh readings at this time. If missed by over an hour, work stays held."
            )
            .font(.footnote).foregroundStyle(.secondary)
          }
        }
      }
      Button(
        busy ? "Saving…" : scheduleResume ? "Pause and schedule allocation" : "Authorize allocation"
      ) { save() }.disabled(choices.isEmpty)
    }
    .navigationTitle(renewal == nil ? "New allocation" : "Resume allowance")
    .disabled(busy)
    .onChange(of: appModel.accountID) { _, _ in
      readingID = UUID()
      snapshots = []
      choices = []
      dismiss()
    }
    .onDisappear { readingID = UUID() }
    .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
    .onAppear {
      if environmentID.isEmpty {
        environmentID = initialEnvironmentID
      }
    }
    .task(id: "\(appModel.accountID ?? ""):\(environmentID)") { await load() }
  }
  private func load() async {
    let accountID = appModel.accountID
    let requestID = UUID()
    readingID = requestID
    snapshots = []
    error = nil
    guard
      let environment = appModel.cloud.environments.first(where: {
        $0.environment.environmentId == environmentID
      })
    else { return }
    do {
      let config = try await appModel.cloud.environmentRequest(
        environment: environment, method: "server.getConfig", payload: .object([:]))
      var next: [JSONValue] = []
      for provider in config.objectValue?["providers"]?.arrayValue ?? [] {
        guard let fields = provider.objectValue, let driver = fields["driver"]?.stringValue,
          ["codex", "claudeAgent", "cursor"].contains(driver), let id = fields["instanceId"]
        else { continue }
        if !multipleAccounts
          && (id.stringValue != self.provider.instanceId || driver != self.provider.driver)
        {
          continue
        }
        next.append(
          try await appModel.cloud.environmentRequest(
            environment: environment, method: "server.getProviderUsage",
            payload: .object([
              "instanceId": id, "provider": .string(driver), "forceRefresh": .bool(true),
            ])))
      }
      guard accountID == appModel.accountID, readingID == requestID,
        environment.environment.environmentId == environmentID, !Task.isCancelled
      else { return }
      snapshots = next
      selected =
        windows.first(where: { $0.snapshot["instanceId"]?.stringValue == self.provider.instanceId }
        )?.id ?? windows.first?.id ?? ""
    } catch {
      if !Task.isCancelled && accountID == appModel.accountID && readingID == requestID {
        self.error = error.localizedDescription
      }
    }
  }
  private func add() {
    guard let window, let points = Double(percent), points > 0 && points <= 100 else {
      error = "Choose more than zero and at most 100 percentage points."
      return
    }
    let choice = Choice(
      environmentID: environmentID, instanceID: window.snapshot["instanceId"]?.stringValue ?? "",
      provider: window.snapshot["provider"]?.stringValue ?? "", windowKey: window.key,
      label: window.label, percent: points)
    choices.removeAll { $0.id == choice.id }
    choices.append(choice)
  }
  private func save() {
    busy = true
    error = nil
    let accountID = appModel.accountID
    Task {
      defer { busy = false }
      do {
        var allocations: [JSONValue] = []
        guard accountID == appModel.accountID else { return }
        for choice in choices {
          guard
            let environment = appModel.cloud.environments.first(where: {
              $0.environment.environmentId == choice.environmentID
            })
          else { throw URLError(.notConnectedToInternet) }
          let snapshot = try await appModel.cloud.environmentRequest(
            environment: environment, method: "server.getProviderUsage",
            payload: .object([
              "instanceId": .string(choice.instanceID), "provider": .string(choice.provider),
              "forceRefresh": .bool(true),
            ]))
          allocations.append(
            .object([
              "snapshot": snapshot, "windowKey": .string(choice.windowKey),
              "authorizedPercent": .number(choice.percent),
            ]))
        }
        guard accountID == appModel.accountID, !Task.isCancelled else { return }
        var fields: [String: JSONValue] = [
          "companyId": .string(companyID), "budgetId": .string(renewal?.id ?? budgetID),
          "allocations": .array(allocations),
        ]
        if let renewal {
          fields["revision"] = .number(Double(renewal.number("revision")))
          if scheduleResume {
            fields["at"] = .number(resumeAt.timeIntervalSince1970 * 1000)
            fields["timeZone"] = .string(resumeZone)
          }
        } else {
          fields["title"] = .string(title)
          fields["scopes"] = .array(scopes)
        }
        try await appModel.cloud.orchestrators.changeAllowance(
          renewal == nil ? "create" : scheduleResume ? "scheduleResume" : "resume", fields)
        if accountID == appModel.accountID { dismiss() }
      } catch { if accountID == appModel.accountID { self.error = error.localizedDescription } }
    }
  }
}

extension JSONValue {
  fileprivate var numericValue: Double? {
    if case .number(let value) = self { return value }
    return nil
  }
}
