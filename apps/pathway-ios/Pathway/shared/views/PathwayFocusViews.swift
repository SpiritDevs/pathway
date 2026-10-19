import SwiftUI

struct PathwayFocusSettingsView: View {
    @Environment(PathwayAppModel.self) private var appModel
    @State private var ownedModel = PathwayFocusModel()
    @State private var editingFocus: PathwayFocus?
    @State private var creatingFocus = false
    private let providedModel: PathwayFocusModel?
    private var model: PathwayFocusModel { providedModel ?? ownedModel }

    init(model: PathwayFocusModel? = nil) {
        providedModel = model
    }

    var body: some View {
        List {
            Section {
                ForEach(model.focuses) { focus in
                    HStack {
                        Button { editingFocus = focus } label: {
                            Label { Text(focus.name) } icon: {
                                PathwayFocusIcon(name: focus.iconName)
                                    .foregroundStyle(PathwayFocusIcon.color(focus.accentColor))
                            }
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                        .buttonStyle(.plain)
                        .accessibilityHint("Edit Focus")
                        Menu {
                            Button("Move up", systemImage: "arrow.up") {
                                Task { await model.move(focus, offset: -1, cloud: appModel.cloud) }
                            }.disabled(model.focuses.first?.id == focus.id)
                            Button("Move down", systemImage: "arrow.down") {
                                Task { await model.move(focus, offset: 1, cloud: appModel.cloud) }
                            }.disabled(model.focuses.last?.id == focus.id)
                        } label: { Image(systemName: "ellipsis").frame(minWidth: 44, minHeight: 44) }
                        .accessibilityLabel("Reorder \(focus.name)")
                    }
                }
                Button("New Focus", systemImage: "plus") { creatingFocus = true }
            } footer: {
                Text("Choose a Focus to edit its name, projects, and appearance, or delete it.")
            }
            if let error = model.errorMessage { Text(error).foregroundStyle(.red) }
        }
        .navigationTitle("Focus Views")
        .sheet(item: $editingFocus) { PathwayFocusEditorView(model: model, focus: $0) }
        .sheet(isPresented: $creatingFocus) { PathwayFocusEditorView(model: model) }
        .task(id: appModel.localStorageDirectory) {
            if providedModel == nil { await model.observe(cloud: appModel.cloud, storageDirectory: appModel.localStorageDirectory) }
        }
    }
}

struct PathwayFocusEditorView: View {
    @Environment(PathwayAppModel.self) private var appModel
    @Environment(\.dismiss) private var dismiss
    let model: PathwayFocusModel
    var focus: PathwayFocus?
    @State private var name = ""
    @State private var iconName = "Briefcase"
    @State private var color = "#6366f1"
    @State private var selectedProjects: Set<String> = []
    @State private var includeConversations = false
    @State private var saving = false
    @State private var errorMessage: String?
    @State private var deleting = false

    var body: some View {
        NavigationStack {
            Form {
                Section("Focus") {
                    TextField("Name", text: $name)
                    Picker("Icon", selection: $iconName) {
                        ForEach(PathwayFocusIconCatalog.options) { option in
                            Label(option.label, image: PathwayFocusIconCatalog.assetName(for: option.name)).tag(option.name)
                        }
                        if !PathwayFocusIconCatalog.options.contains(where: { $0.name == iconName }) {
                            Label("Current icon", image: PathwayFocusIconCatalog.assetName(for: iconName)).tag(iconName)
                        }
                    }
                    Picker("Color", selection: $color) {
                        Text("Indigo").tag("#6366f1")
                        Text("Blue").tag("#3b82f6")
                        Text("Green").tag("#22c55e")
                        Text("Orange").tag("#f97316")
                        Text("Pink").tag("#ec4899")
                    }
                }
                Section("Projects") {
                    Toggle("Conversations", isOn: $includeConversations)
                    ForEach(appModel.cloud.environmentBindings) { binding in
                        let key = "\(binding.binding.environmentId):\(binding.binding.localProjectId)"
                        Toggle(isOn: Binding(get: { selectedProjects.contains(key) }, set: { if $0 { selectedProjects.insert(key) } else { selectedProjects.remove(key) } })) {
                            VStack(alignment: .leading) {
                                Text(appModel.cloud.projectName(companyId: binding.companyId, projectId: binding.binding.cloudProjectId) ?? binding.binding.localProjectId)
                                Text(appModel.cloud.environmentLabel(companyId: binding.companyId, environmentId: binding.binding.environmentId) ?? binding.binding.environmentId)
                                    .font(.caption).foregroundStyle(.secondary)
                            }
                        }
                    }
                }
                if focus != nil { Button("Delete Focus", role: .destructive) { deleting = true } }
                if let errorMessage { Text(errorMessage).foregroundStyle(.red) }
            }
            .navigationTitle(focus == nil ? "New Focus" : "Edit Focus")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(saving) }
                ToolbarItem(placement: .confirmationAction) { Button("Save") { Task { await save() } }.disabled(saving || name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty) }
            }
            .task {
                name = focus?.name ?? ""; color = focus?.accentColor ?? "#6366f1"
                iconName = focus?.iconName ?? "Briefcase"
                includeConversations = focus?.includeConversations ?? false
                selectedProjects = Set(model.assignments.filter { $0.focusId == focus?.id }.map(\.projectKey))
            }
            .confirmationDialog("Delete this Focus?", isPresented: $deleting, titleVisibility: .visible) {
                Button("Delete Focus", role: .destructive) {
                    Task {
                        guard let focus else { return }
                        do {
                            _ = try await appModel.cloud.request(kind: "mutation", name: "focuses:remove", arguments: .object(["focusId": .string(focus.id)]))
                            if model.selectedID == focus.id { model.selectedID = "all" }
                            dismiss()
                        } catch { errorMessage = error.localizedDescription }
                    }
                }
            } message: { Text("Projects and threads remain available in All threads.") }
        }
    }

    private func save() async {
        saving = true; defer { saving = false }
        do {
            if let focus {
                _ = try await appModel.cloud.request(kind: "mutation", name: "focuses:update", arguments: .object(["focusId": .string(focus.id), "name": .string(name), "iconName": .string(iconName), "accentColor": .string(color), "includeConversations": .bool(includeConversations)]))
                let original = Set(model.assignments.filter { $0.focusId == focus.id }.map(\.projectKey))
                for key in original.subtracting(selectedProjects).sorted() {
                    _ = try await appModel.cloud.request(kind: "mutation", name: "focuses:unassignProject", arguments: .object(["projectKey": .string(key)]))
                }
                for key in selectedProjects.subtracting(original).sorted() {
                    _ = try await appModel.cloud.request(kind: "mutation", name: "focuses:assignProject", arguments: .object(["focusId": .string(focus.id), "projectKey": .string(key)]))
                }
            } else {
                _ = try await appModel.cloud.request(kind: "mutation", name: "focuses:create", arguments: .object([
                    "id": .string(UUID().uuidString.lowercased()), "name": .string(name), "iconName": .string(iconName),
                    "accentColor": .string(color), "projectKeys": .array(selectedProjects.sorted().map(JSONValue.string)),
                    "includeConversations": .bool(includeConversations)
                ]))
            }
            dismiss()
        } catch { errorMessage = error.localizedDescription }
    }
}

struct PathwayFocusNotificationsView: View {
    @Environment(PathwayAppModel.self) private var appModel
    @Environment(\.dismiss) private var dismiss
    let model: PathwayFocusModel
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            List {
                if let errorMessage { Text(errorMessage).foregroundStyle(.red) }
                ForEach(model.notifications) { notification in
                    Button {
                        guard let thread = appModel.cloud.threads.first(where: { $0.threadId == notification.threadId && $0.environmentId == notification.environmentId }) else {
                            errorMessage = "This thread is no longer available in your connected workspaces."; return
                        }
                        model.selectedID = model.notificationFocusID(notification)
                        appModel.pendingThreadRoute = .init(companyId: thread.companyId, environmentId: thread.environmentId, threadId: thread.threadId)
                        dismiss()
                    } label: {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(notification.title).font(.headline)
                            Text(model.notificationFocusName(notification)).font(.caption).foregroundStyle(.secondary)
                            Text(appModel.cloud.threads.first { $0.threadId == notification.threadId && $0.environmentId == notification.environmentId }?.shell.title ?? "Agent thread")
                            Text(Date(timeIntervalSince1970: notification.createdAt / 1000), style: .relative).font(.caption).foregroundStyle(.secondary)
                        }
                    }
                }
            }
            .overlay { if model.notifications.isEmpty { ContentUnavailableView("No notifications", systemImage: "bell") } }
            .navigationTitle("Notifications")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Mark all read") { Task {
                        do { _ = try await appModel.cloud.request(kind: "mutation", name: "focusNotifications:markAllRead", arguments: .object([:])) }
                        catch { errorMessage = error.localizedDescription }
                    } }.disabled(model.unreadCount == 0)
                }
            }
        }
    }
}
