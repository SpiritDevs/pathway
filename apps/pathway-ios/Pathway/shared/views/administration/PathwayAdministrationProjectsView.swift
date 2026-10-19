import SwiftUI

struct PathwayAdministrationProjectsView: View {
    let client: PathwayAdministrationClient
    @State private var projects: [PathwayAdministrationProject] = []
    @State private var error: String?
    @State private var deleting: PathwayAdministrationProject?
    var body: some View {
        List {
            if let error { Text(error).foregroundStyle(.red) }
            ForEach(projects) { project in
                NavigationLink {
                    PathwayAdministrationProjectEditor(client: client, project: project)
                } label: {
                    VStack(alignment: .leading) { Text(project.title); Text(project.workspaceRoot ?? "No workspace directory").font(.caption).foregroundStyle(.secondary) }
                }.swipeActions { Button("Remove", role: .destructive) { deleting = project } }
            }
            if projects.isEmpty { Text("No projects on this environment") }
        }.navigationTitle("Projects")
            .toolbar { NavigationLink { PathwayAdministrationProjectEditor(client: client) } label: { Image(systemName: "plus") }.accessibilityLabel("Add project") }
            .task { await load() }.refreshable { await load() }
            .confirmationDialog("Remove project from this environment?", isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } })) {
                Button("Remove project", role: .destructive) { if let deleting { self.deleting = nil; Task { await remove(deleting) } } }
                Button("Cancel", role: .cancel) { deleting = nil }
            } message: { Text("The server will check whether the project can be removed. Files in its directory are preserved.") }
    }
    private func load() async { do { projects = try await client.projects(); error = nil } catch { self.error = error.localizedDescription } }
    private func remove(_ project: PathwayAdministrationProject) async {
        do { _ = try await client.run("projects.mutate", ["type": .string("project.delete"), "projectId": .string(project.id), "commandId": .string(UUID().uuidString)]); await load() }
        catch { self.error = error.localizedDescription }
    }
}

struct PathwayAdministrationProjectRoute: View {
    let client: PathwayAdministrationClient
    let projectID: String
    @State private var project: PathwayAdministrationProject?
    @State private var error: String?
    @State private var loaded = false

    var body: some View {
        Group {
            if let project {
                PathwayAdministrationProjectEditor(client: client, project: project)
            } else if let error {
                ContentUnavailableView {
                    Label("Project unavailable", systemImage: "folder.badge.questionmark")
                } description: { Text(error) } actions: {
                    Button("Retry") { Task { await load() } }
                }
            } else if loaded {
                ContentUnavailableView("Project removed", systemImage: "folder.badge.questionmark",
                    description: Text("This project is no longer available on the selected environment."))
            } else { ProgressView("Loading project…") }
        }
        .task(id: projectID) { await load() }
    }

    private func load() async {
        do {
            let projects = try await client.projects()
            try Task.checkCancellation()
            project = projects.first { $0.id == projectID }; error = nil; loaded = true
        } catch is CancellationError {} catch { self.error = error.localizedDescription }
    }
}

struct PathwayAdministrationProjectEditor: View {
    let client: PathwayAdministrationClient
    var project: PathwayAdministrationProject?
    @Environment(\.dismiss) private var dismiss
    @State private var title = ""
    @State private var root = ""
    @State private var createDirectory = false
    @State private var mode = ""
    @State private var instanceID = ""
    @State private var model = ""
    @State private var scripts: [PathwayAdministrationScript] = []
    @State private var providers: [PathwayAdministrationProvider] = []
    @State private var folders: [Folder] = []
    @State private var busy = false
    @State private var error: String?
    @State private var initialized = false
    @State private var newProjectID = UUID().uuidString
    @State private var commandID = UUID().uuidString
    private struct Folder: Decodable, Identifiable { let name: String; let fullPath: String; var id: String { fullPath } }
    private struct Browse: Decodable { let parentPath: String; let entries: [Folder] }
    private var models: [PathwayAdministrationProvider.Model] { providers.first { $0.id == instanceID }?.models ?? [] }
    var body: some View {
        Form {
            if let error { Text(error).foregroundStyle(.red) }
            Section("Project") {
                TextField("Title", text: $title)
                TextField("Directory on the environment", text: $root).autocorrectionDisabled().textInputAutocapitalization(.never)
                Toggle("Create directory if missing", isOn: $createDirectory)
                Button("Browse directories") { Task { await browse() } }.disabled(root.isEmpty)
                ForEach(folders) { folder in Button(folder.fullPath) { root = folder.fullPath; folders = [] } }
            }
            Section("Defaults") {
                Picker("Workspace", selection: $mode) { Text("Environment default").tag(""); Text("Local checkout").tag("local"); Text("Worktree").tag("worktree") }
                Picker("Provider", selection: $instanceID) { Text("No project default").tag(""); ForEach(providers) { Text($0.name).tag($0.id) } }
                if !instanceID.isEmpty {
                    Picker("Model", selection: $model) { Text("Choose model").tag(""); ForEach(models) { Text($0.name).tag($0.slug) } }
                }
            }
            Section("Scripts") {
                ForEach($scripts) { $script in
                    NavigationLink(script.name.isEmpty ? "New script" : script.name) {
                        Form {
                            TextField("Name", text: $script.name)
                            TextField("Command", text: $script.command, axis: .vertical).autocorrectionDisabled().textInputAutocapitalization(.never)
                            Picker("Icon", selection: $script.icon) { ForEach(["play", "test", "lint", "configure", "build", "debug"], id: \.self) { Text($0.capitalized).tag($0) } }
                            Toggle("Run when creating a worktree", isOn: $script.runOnWorktreeCreate)
                            TextField("Preview URL (optional)", text: Binding(get: { script.previewUrl ?? "" }, set: { script.previewUrl = $0.isEmpty ? nil : $0 })).autocorrectionDisabled().textInputAutocapitalization(.never)
                            Toggle("Open preview automatically", isOn: Binding(get: { script.autoOpenPreview ?? false }, set: { script.autoOpenPreview = $0 }))
                        }.navigationTitle("Script")
                    }
                }.onDelete { scripts.remove(atOffsets: $0) }
                Button("Add script") { scripts.append(.init(id: UUID().uuidString, name: "", command: "", icon: "play", runOnWorktreeCreate: false)) }
            }
            Button(project == nil ? "Add project" : "Save project") { Task { await save() } }
                .disabled(title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !PathwayAdministrationProjectDirectory.canSave(root: root, isNew: project == nil, existingRoot: project?.workspaceRoot) || (!instanceID.isEmpty && model.isEmpty) || scripts.contains { $0.name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || $0.command.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty })
        }.navigationTitle(project == nil ? "Add project" : "Project settings").disabled(busy)
            .task {
                guard !initialized else { return }; initialized = true
                if let project {
                    title = project.title; root = project.workspaceRoot ?? ""; scripts = project.scripts; mode = project.defaultThreadEnvMode ?? ""
                    instanceID = project.defaultModelSelection?.objectValue?["instanceId"]?.stringValue ?? ""
                    model = project.defaultModelSelection?.objectValue?["model"]?.stringValue ?? ""
                }
                do { let config: PathwayAdministrationConfig = try await client.call("server.getConfig"); providers = config.providers; if project == nil && root.isEmpty { root = config.cwd } }
                catch { self.error = error.localizedDescription }
            }
    }
    private func browse() async {
        busy = true; defer { busy = false }
        do { let result: Browse = try await client.call("filesystem.browse", ["partialPath": .string(root)]); folders = result.entries; error = nil }
        catch { self.error = error.localizedDescription }
    }
    private func save() async {
        busy = true; defer { busy = false }
        do {
            let encodedScripts = try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(scripts))
            var selection: JSONValue = .null
            if !instanceID.isEmpty {
                selection = project?.defaultModelSelection?.objectValue?["instanceId"]?.stringValue == instanceID && project?.defaultModelSelection?.objectValue?["model"]?.stringValue == model ? (project?.defaultModelSelection ?? .null) : .object(["instanceId": .string(instanceID), "model": .string(model)])
            }
            var payload: [String: JSONValue] = ["type": .string(project == nil ? "project.create" : "project.update"), "commandId": .string(commandID), "projectId": .string(project?.id ?? newProjectID), "title": .string(title), "defaultModelSelection": selection, "scripts": encodedScripts]
            payload.merge(PathwayAdministrationProjectDirectory.fields(root: root, createDirectory: createDirectory)) { _, new in new }
            if project != nil { payload["defaultThreadEnvMode"] = mode.isEmpty ? .null : .string(mode) }
            _ = try await client.run("projects.mutate", payload)
            if project == nil && !mode.isEmpty {
                _ = try await client.run("projects.mutate", ["type": .string("project.update"), "commandId": .string(UUID().uuidString), "projectId": .string(newProjectID), "defaultThreadEnvMode": .string(mode)])
            }
            dismiss()
        } catch { self.error = error.localizedDescription }
    }
}

enum PathwayAdministrationProjectDirectory {
    static func canSave(root: String, isNew: Bool, existingRoot: String?) -> Bool {
        !root.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || (!isNew && existingRoot == nil)
    }
    static func fields(root: String, createDirectory: Bool) -> [String: JSONValue] {
        let root = root.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !root.isEmpty else { return [:] }
        return ["workspaceRoot": .string(root), "createWorkspaceRootIfMissing": .bool(createDirectory)]
    }
}
