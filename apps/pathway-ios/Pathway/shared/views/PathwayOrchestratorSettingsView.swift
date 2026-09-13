import SwiftUI

enum PathwayOrchestratorSettingsPage: String, CaseIterable, Identifiable {
  case overview = "Overview"
  case instructions = "Instructions"
  case models = "Models"
  case environments = "Environments"
  case responsibilities = "Responsibilities"
  case permissions = "Permissions"
  case memory = "Memory"
  case notifications = "Notifications"
  case workLimits = "Work limits"
  var id: Self { self }
}

struct PathwayOrchestratorSettingsView: View {
  let page: PathwayOrchestratorSettingsPage
  @Environment(PathwayAppModel.self) private var appModel
  @State private var selectedID = ""
  @State private var draft: [String: JSONValue] = [:]
  @State private var revision = 0
  @State private var saving = false
  @State private var error: String?
  @State private var saved = false
  @State private var memories: [PathwayOrchestratorRecord] = []
  @State private var editingMemory: PathwayOrchestratorRecord?
  @State private var addingMemory = false
  @State private var newName = ""
  @State private var confirmingDelete = false
  @State private var choices: [String: JSONValue] = [:]
  private var model: PathwayOrchestratorsModel { appModel.cloud.orchestrators }
  private var contact: PathwayOrchestratorRecord? { model.contacts.first { $0.id == selectedID } }
  private var models: [PathwayOrchestratorRecord] {
    PathwayOrchestratorRecord.records(draft["models"] ?? .array([]))
  }
  private var members: [PathwayOrchestratorRecord] {
    (choices["members"]?.arrayValue ?? []).compactMap { value in
      guard let fields = value.objectValue, let id = fields["subject"]?.stringValue else {
        return nil
      }
      return .init(id: id, fields: fields)
    }
  }
  var body: some View {
    Form {
      Section {
        Picker("Orchestrator", selection: $selectedID) {
          Text("Choose orchestrator").tag("")
          ForEach(model.contacts.filter { $0.flag("canManage") }) {
            Text($0.string("name")).tag($0.id)
          }
        }
      }
      if let error { Text(error).foregroundStyle(.red) }
      if saved { Text("Settings saved.").foregroundStyle(.secondary) }
      if contact != nil && !draft.isEmpty {
        contents
        if page != .memory {
          Section {
            Button("Save changes") { save() }.disabled(saving)
            Button("Reload saved settings") { load() }.disabled(saving)
          }
        }
      }
      if page == .overview { creation }
    }
    .navigationTitle(page.rawValue)
    .disabled(saving)
    .toolbar { if page == .models { EditButton() } }
    .task(id: appModel.accountID) {
      if let id = appModel.accountID {
        model.start(accountID: id, companyIDs: appModel.cloud.companies.map(\.id))
      }
      chooseInitial()
    }
    .onChange(of: model.contacts.map(\.id)) { chooseInitial() }
    .onChange(of: selectedID) { load() }
    .task(id: draft["companyId"]?.stringValue) { await loadChoices() }
    .sheet(item: $editingMemory) { memory in
      if let contact = model.contacts.first(where: { $0.id == memory.string("orchestratorId") }) {
        PathwayOrchestratorMemoryEditor(orchestrator: contact, memory: memory) {
          Task { await loadMemories() }
        }
      }
    }
    .sheet(isPresented: $addingMemory) {
      if let contact {
        PathwayOrchestratorMemoryEditor(orchestrator: contact) { Task { await loadMemories() } }
      }
    }
    .confirmationDialog(
      "Delete this orchestrator and its saved memory? Shared conversations retain their history. Outstanding work will be stopped.",
      isPresented: $confirmingDelete, titleVisibility: .visible
    ) { Button("Delete orchestrator", role: .destructive) { status("deleted", stop: true) } }
  }
  @ViewBuilder private var contents: some View {
    switch page {
    case .overview:
      Section("Identity") {
        TextField("Name", text: text("name"))
        Picker("Colour", selection: text("color")) {
          ForEach(["violet", "blue", "green", "orange", "pink"], id: \.self) {
            Text($0.capitalized).tag($0)
          }
        }
        Picker("Role", selection: text("kind")) {
          Text("Personal assistant").tag("personal")
          Text("Project coordinator").tag("project")
          Text("Custom").tag("custom")
        }
        Picker("Workspace", selection: nullableText("companyId")) {
          Text("Personal").tag("")
          ForEach(appModel.cloud.companies) { Text($0.name).tag($0.id) }
        }
        if !(draft["companyId"]?.stringValue ?? "").isEmpty {
          Picker("Project", selection: nullableText("projectId")) {
            Text("All authorized projects").tag("")
            ForEach(PathwayOrchestratorRecord.records(choices["projects"] ?? .array([]))) {
              Text($0.string("name")).tag($0.id)
            }
          }
          Toggle("Share with workspace", isOn: flag("shared"))
        }
      }
      Section("Activity") {
        Text(contact?.string("status").capitalized ?? "")
        Button(contact?.string("status") == "active" ? "Pause new work" : "Resume") {
          status(contact?.string("status") == "active" ? "paused" : "active")
        }
        Button("Stop work", role: .destructive) { status("paused", stop: true) }
        Button(contact?.string("status") == "archived" ? "Unarchive" : "Archive") {
          status(contact?.string("status") == "archived" ? "active" : "archived")
        }
        Button("Delete orchestrator", role: .destructive) { confirmingDelete = true }
      }
    case .instructions:
      Section("Persona") { TextEditor(text: text("persona")).frame(minHeight: 110) }
      Section("System instructions") {
        TextEditor(text: text("instructions")).frame(minHeight: 260)
      }
      Text(
        "These instructions shape how your orchestrator coordinates and communicates. Implementation work is delegated to agent threads."
      ).font(.footnote).foregroundStyle(.secondary)
    case .models:
      Section {
        ForEach(models) { choice in
          NavigationLink {
            PathwayOrchestratorModelEditor(choice: choice) { updated in replaceModel(updated) }
          } label: {
            VStack(alignment: .leading) {
              Text(choice.fields["selection"]?.objectValue?["model"]?.stringValue ?? "Choose model")
              Text(environmentLabel(choice.string("environmentId"))).font(.caption).foregroundStyle(
                .secondary)
            }
          }
        }.onMove { from, to in
          var items = draft["models"]?.arrayValue ?? []
          items.move(fromOffsets: from, toOffset: to)
          draft["models"] = .array(items)
        }
        .onDelete { offsets in
          var items = draft["models"]?.arrayValue ?? []
          items.remove(atOffsets: offsets)
          draft["models"] = .array(items)
        }
        Button("Add model choice") {
          var items = draft["models"]?.arrayValue ?? []
          items.append(
            .object([
              "id": .string(UUID().uuidString.lowercased()),
              "environmentId": .string(
                appModel.cloud.environments.first?.environment.environmentId ?? ""),
              "selection": .object([
                "instanceId": .string("codex"), "model": .string("gpt-6-astra"),
                "options": .array([
                  .object(["id": .string("reasoningEffort"), "value": .string("high")])
                ]),
              ]),
            ]))
          draft["models"] = .array(items)
        }
      } header: {
        Text("Model order")
      } footer: {
        Text(
          "The default is GPT-6 Astra with high reasoning. Use Edit to reorder fallback choices. The same model can run on another eligible environment before trying the next choice."
        )
      }
    case .environments:
      Section("Eligible environments") {
        Toggle("All authorized environments", isOn: flag("allEnvironments"))
        if draft["allEnvironments"]?.boolValue != true {
          ForEach(appModel.cloud.environments) { environment in
            Toggle(
              environment.environment.label,
              isOn: membership("environmentIds", environment.environment.environmentId))
          }
        }
      }
      Text(
        "Cloud retains conversations and memory. Reasoning queues when no eligible host is available. An offline host may still be executing accepted work."
      ).font(.footnote).foregroundStyle(.secondary)
    case .responsibilities:
      Section("Standing responsibilities") {
        TextEditor(text: text("responsibilities")).frame(minHeight: 240)
      }
      Picker(
        "Review responsibilities",
        selection: Binding(
          get: { draft["reviewIntervalMinutes"]?.intValue ?? 0 },
          set: { draft["reviewIntervalMinutes"] = .number(Double($0)) })
      ) {
        Text("On events only").tag(0)
        Text("Every 15 minutes").tag(15)
        Text("Every hour").tag(60)
        Text("Every 4 hours").tag(240)
        Text("Every day").tag(1440)
      }
      Toggle("Act proactively", isOn: flag("proactive"))
    case .permissions:
      Section("Actions") {
        ForEach(Self.capabilities, id: \.0) { capability, label in
          Toggle(label, isOn: membership("capabilities", capability))
        }
      }
      if draft["shared"]?.boolValue == true {
        Section("Who can direct this orchestrator") {
          ForEach(members.filter { $0.id != contact?.string("ownerSubject") }) { member in
            Toggle(member.string("name"), isOn: membership("directorSubjects", member.id))
          }
        }
        Section("Who can manage its settings") {
          ForEach(members.filter { $0.id != contact?.string("ownerSubject") }) { member in
            Toggle(member.string("name"), isOn: membership("managerSubjects", member.id))
          }
        }
      }
    case .memory:
      Toggle("Remember useful information automatically", isOn: flag("rememberAutomatically"))
      Button("Save memory preference") { save() }
      Section("Saved memories") {
        ForEach(memories) { memory in
          Button {
            editingMemory = memory
          } label: {
            VStack(alignment: .leading, spacing: 6) {
              Text(memory.string("text")).foregroundStyle(.primary)
              Text(memory.string("source")).font(.caption).foregroundStyle(.secondary)
            }
          }
        }
        Button("Add memory") { addingMemory = true }
      }
      Text(
        "Memories retain useful facts and preferences with their sources. Forgetting prevents automatic relearning from older messages."
      ).font(.footnote).foregroundStyle(.secondary)
    case .notifications:
      Section("Updates") {
        Toggle("Proactive updates", isOn: flag("proactive"))
        Toggle("Alert for urgent developments", isOn: flag("notifyUrgent"))
        Toggle("Batch routine completions", isOn: flag("batchCompletions"))
      }
      Text("System alerts also follow your notification and quiet-hours preferences.").font(
        .footnote
      ).foregroundStyle(.secondary)
    case .workLimits:
      Section("Delegated assignments") {
        Stepper(
          "Up to \(draft["maxAssignments"]?.intValue ?? 4) active assignments",
          value: Binding(
            get: { draft["maxAssignments"]?.intValue ?? 4 },
            set: { draft["maxAssignments"] = .number(Double($0)) }), in: 1...32)
      }
      Text(
        "Additional assignments wait in the queue. Pausing stops new work; Stop work requests interruption and shows when a host has not confirmed it."
      ).font(.footnote).foregroundStyle(.secondary)
      Section {
        Text("Manage conversation allowances in Settings → Providers, under the provider instance.")
          .font(.footnote).foregroundStyle(.secondary)
      }
    }
  }
  private var creation: some View {
    Section("New orchestrator") {
      TextField("Name", text: $newName)
      Button("Create orchestrator") {
        guard var config = model.contacts.first?.configuration else { return }
        config["name"] = .string(newName)
        config["kind"] = .string("custom")
        config["companyId"] = .null
        config["projectId"] = .null
        config["shared"] = .bool(false)
        config["directorSubjects"] = .array([])
        config["managerSubjects"] = .array([])
        saving = true
        Task {
          defer { saving = false }
          do {
            let value = try await model.mutate("create", ["config": .object(config)])
            selectedID = value.stringValue ?? ""
            newName = ""
          } catch { self.error = error.localizedDescription }
        }
      }.disabled(
        newName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || model.contacts.isEmpty)
    }
  }
  private func chooseInitial() {
    if !model.contacts.contains(where: { $0.id == selectedID && $0.flag("canManage") }) {
      selectedID = ""
      draft = [:]
      memories = []
      editingMemory = nil
    }
    if selectedID.isEmpty, let first = model.contacts.first(where: { $0.flag("canManage") }) {
      selectedID = first.id
      load()
    } else if draft.isEmpty {
      load()
    }
  }
  private func load() {
    memories = []
    editingMemory = nil
    addingMemory = false
    guard let contact else {
      draft = [:]
      return
    }
    draft = contact.configuration
    revision = contact.number("revision")
    saved = false
    error = nil
    if page == .memory { Task { await loadMemories() } }
  }
  private func save() {
    saving = true
    saved = false
    Task {
      defer { saving = false }
      do {
        _ = try await model.mutate(
          "configure",
          [
            "id": .string(selectedID), "revision": .number(Double(revision)),
            "config": .object(draft),
          ])
        revision += 1
        saved = true
      } catch { self.error = error.localizedDescription }
    }
  }
  private func status(_ status: String, stop: Bool = false) {
    saving = true
    Task {
      defer { saving = false }
      do {
        try await model.mutate(
          "setStatus",
          ["id": .string(selectedID), "status": .string(status), "stopWork": .bool(stop)])
        if status == "deleted" {
          selectedID = ""
          draft = [:]
          memories = []
        } else {
          revision += 1
        }
      } catch { self.error = error.localizedDescription }
    }
  }
  private func loadMemories() async {
    let id = selectedID
    guard !id.isEmpty else {
      memories = []
      return
    }
    do {
      let value = try await model.query("memories", ["orchestratorId": .string(id)])
      guard id == selectedID, !Task.isCancelled else { return }
      memories = PathwayOrchestratorRecord.records(value)
    } catch {
      if id == selectedID && !Task.isCancelled {
        memories = []
        self.error = error.localizedDescription
      }
    }
  }
  private func loadChoices() async {
    choices = [:]
    guard let companyID = draft["companyId"]?.stringValue else { return }
    do {
      let value = try await model.query("configurationChoices", ["companyId": .string(companyID)])
      guard draft["companyId"] == .string(companyID), !Task.isCancelled else { return }
      choices = value.objectValue ?? [:]
    } catch { if !Task.isCancelled { self.error = error.localizedDescription } }
  }
  private func text(_ key: String) -> Binding<String> {
    .init(
      get: { draft[key]?.stringValue ?? "" },
      set: {
        draft[key] = .string($0)
        saved = false
      })
  }
  private func nullableText(_ key: String) -> Binding<String> {
    .init(
      get: { draft[key]?.stringValue ?? "" },
      set: {
        draft[key] = $0.isEmpty ? .null : .string($0)
        if key == "companyId" {
          draft["projectId"] = .null
          draft["directorSubjects"] = .array([])
          draft["managerSubjects"] = .array([])
          if $0.isEmpty { draft["shared"] = .bool(false) }
        }
      })
  }
  private func flag(_ key: String) -> Binding<Bool> {
    .init(
      get: { draft[key]?.boolValue ?? false },
      set: {
        draft[key] = .bool($0)
        saved = false
      })
  }
  private func membership(_ key: String, _ id: String) -> Binding<Bool> {
    .init(
      get: { draft[key]?.arrayValue?.contains(.string(id)) ?? false },
      set: { enabled in
        var values = draft[key]?.arrayValue ?? []
        values.removeAll { $0 == .string(id) }
        if enabled { values.append(.string(id)) }
        draft[key] = .array(values)
        saved = false
      })
  }
  private func environmentLabel(_ id: String) -> String {
    appModel.cloud.environments.first { $0.environment.environmentId == id }?.environment.label
      ?? "Choose environment"
  }
  private func replaceModel(_ choice: PathwayOrchestratorRecord) {
    var values = draft["models"]?.arrayValue ?? []
    if let index = values.firstIndex(where: { $0.objectValue?["id"]?.stringValue == choice.id }) {
      values[index] = .object(choice.fields)
    }
    draft["models"] = .array(values)
    saved = false
  }
  static let capabilities = [
    ("projects.read", "Read projects"), ("tasks.read", "Read tasks"),
    ("tasks.manage", "Manage tasks"), ("threads.read", "Read agent threads"),
    ("threads.delegate", "Delegate work"), ("threads.control", "Control delegated work"),
    ("mail.read", "Read authorized mail"), ("mail.send", "Send authorized mail"),
    ("time.read", "Read time tracking"), ("time.manage", "Manage time tracking"),
    ("environments.read", "Inspect environments"),
    ("orchestrators.message", "Contact other orchestrators"), ("memory.manage", "Manage memory"),
    ("schedules.manage", "Manage schedules"),
  ]
}

private struct PathwayOrchestratorModelEditor: View {
  let choice: PathwayOrchestratorRecord
  let onSave: (PathwayOrchestratorRecord) -> Void
  @Environment(PathwayAppModel.self) private var appModel
  @Environment(\.dismiss) private var dismiss
  @State private var environmentID: String
  @State private var selection: JSONValue
  @State private var providers: [JSONValue] = []
  @State private var error: String?
  init(choice: PathwayOrchestratorRecord, onSave: @escaping (PathwayOrchestratorRecord) -> Void) {
    self.choice = choice
    self.onSave = onSave
    _environmentID = State(initialValue: choice.string("environmentId"))
    _selection = State(initialValue: choice.fields["selection"] ?? .null)
  }
  var body: some View {
    Form {
      Picker("Environment", selection: $environmentID) {
        Text("Choose environment").tag("")
        ForEach(appModel.cloud.environments) {
          Text($0.environment.label).tag($0.environment.environmentId)
        }
      }
      PathwayIssueModelSelectionPicker(selection: $selection, providers: providers)
      if let error { Text(error).font(.footnote).foregroundStyle(.secondary) }
      Button("Use this choice") {
        var fields = choice.fields
        fields["environmentId"] = .string(environmentID)
        fields["selection"] = selection
        onSave(.init(id: choice.id, fields: fields))
        dismiss()
      }.disabled(
        environmentID.isEmpty || (selection.objectValue?["model"]?.stringValue ?? "").isEmpty)
    }
    .navigationTitle("Model choice")
    .task(id: environmentID) {
      providers = []
      error = nil
      guard
        let environment = appModel.cloud.environments.first(where: {
          $0.environment.environmentId == environmentID
        })
      else { return }
      do {
        let value = try await appModel.cloud.environmentRequest(
          environment: environment, method: "server.getConfig", payload: .object([:]))
        guard !Task.isCancelled else { return }
        providers = (value.objectValue?["providers"]?.arrayValue ?? []).filter {
          ["codex", "claudeAgent", "opencode"].contains(
            $0.objectValue?["driver"]?.stringValue ?? "")
        }
      } catch {
        if !Task.isCancelled {
          self.error = "Model availability could not be refreshed. The saved choice is retained."
        }
      }
    }
  }
}

private struct PathwayOrchestratorMemoryEditor: View {
  let orchestrator: PathwayOrchestratorRecord
  let memory: PathwayOrchestratorRecord?
  let onSaved: () -> Void
  @Environment(PathwayAppModel.self) private var appModel
  @Environment(\.dismiss) private var dismiss
  @State private var text: String
  @State private var scope: String
  @State private var confirmSharing = false
  @State private var saving = false
  @State private var error: String?
  init(
    orchestrator: PathwayOrchestratorRecord, memory: PathwayOrchestratorRecord? = nil,
    onSaved: @escaping () -> Void
  ) {
    self.orchestrator = orchestrator
    self.memory = memory
    self.onSaved = onSaved
    _text = State(initialValue: memory?.string("text") ?? "")
    _scope = State(initialValue: memory?.string("scope") ?? "orchestrator")
  }
  private var shared: Bool { orchestrator.flag("shared") || scope == "project" }
  var body: some View {
    NavigationStack {
      Form {
        TextEditor(text: $text).frame(minHeight: 160)
        Picker("Remember for", selection: $scope) {
          Text("This orchestrator").tag("orchestrator")
          if !orchestrator.flag("shared") { Text("All my private orchestrators").tag("personal") }
          if !orchestrator.string("projectId").isEmpty { Text("This project").tag("project") }
        }
        if shared { Toggle("This memory may be shared with the workspace", isOn: $confirmSharing) }
        if let memory {
          Text(memory.string("source")).font(.footnote).foregroundStyle(.secondary)
          Button("Forget memory", role: .destructive) { perform(forget: true) }
        }
        if let error { Text(error).foregroundStyle(.red) }
      }.navigationTitle(memory == nil ? "Add memory" : "Edit memory").toolbar {
        ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
        ToolbarItem(placement: .confirmationAction) {
          Button("Save") { perform(forget: false) }.disabled(
            saving || text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
              || (shared && !confirmSharing))
        }
      }.disabled(saving)
    }
  }
  private func perform(forget: Bool) {
    saving = true
    Task {
      defer { saving = false }
      do {
        var fields: [String: JSONValue] = ["orchestratorId": .string(orchestrator.id)]
        if let memory { fields["id"] = .string(memory.id) }
        if !forget {
          fields["text"] = .string(text)
          fields["scope"] = .string(scope)
          fields["confirmSharing"] = .bool(confirmSharing)
        }
        try await appModel.cloud.orchestrators.mutate(
          forget ? "forgetMemory" : "saveMemory", fields)
        onSaved()
        dismiss()
      } catch { self.error = error.localizedDescription }
    }
  }
}
