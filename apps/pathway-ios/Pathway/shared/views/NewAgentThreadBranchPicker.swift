import SwiftUI

struct NewAgentThreadBranchPicker: View {
    @Environment(\.dismiss) private var dismiss
    @Bindable var model: PathwayAgentThreadCreationModel
    @State private var query = ""
    @State private var refs: [String] = []
    @State private var nextCursor: Int?
    @State private var isLoading = false
    @State private var errorMessage: String?
    @State private var isRepository = true

    var body: some View {
        NavigationStack {
            List {
                Section("Base branch or ref") {
                    TextField("Branch, tag, or commit", text: $model.baseReference)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                    TextField("New branch name (optional)", text: $model.branch)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                    Toggle("Start from origin", isOn: $model.startFromOrigin)
                }
                if let errorMessage { Section { Text(errorMessage).foregroundStyle(.red) } }
                if !isRepository {
                    Section {
                        Text("This project is not a source-control repository.")
                        Button("Use current checkout") { model.workspaceMode = "local"; dismiss() }
                    }
                }
                Section("Available branches") {
                    ForEach(refs, id: \.self) { name in
                        Button { model.baseReference = name; dismiss() } label: {
                            HStack {
                                Text(name).foregroundStyle(.primary)
                                Spacer()
                                if name == model.baseReference { Image(systemName: "checkmark") }
                            }.frame(minHeight: 44)
                        }
                    }
                    if isLoading { ProgressView("Loading branches…") }
                    else if let nextCursor { Button("Load more") { Task { await load(cursor: nextCursor) } } }
                    else if refs.isEmpty && isRepository && errorMessage == nil { Text("No matching branches").foregroundStyle(.secondary) }
                }
            }
            .searchable(text: $query, prompt: "Search branches")
            .navigationTitle("Choose base branch")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .task(id: query) { await load(cursor: nil) }
        }
    }

    private func load(cursor: Int?) async {
        let search = String(query.trimmingCharacters(in: .whitespacesAndNewlines).prefix(256))
        if cursor == nil { refs = []; nextCursor = nil }
        isLoading = true; errorMessage = nil
        do {
            if cursor == nil { try await Task.sleep(for: .milliseconds(200)) }
            var fields: [String: JSONValue] = ["cwd": .string(model.workspaceRoot), "limit": .number(100), "refKind": .string("all")]
            if !search.isEmpty { fields["query"] = .string(search) }
            if let cursor { fields["cursor"] = .number(Double(cursor)) }
            let value = try await model.request("vcs.listRefs", payload: .object(fields))
            try Task.checkCancellation()
            guard search == String(query.trimmingCharacters(in: .whitespacesAndNewlines).prefix(256)) else { return }
            isRepository = value.objectValue?["isRepo"]?.boolValue ?? true
            let page = value.objectValue?["refs"]?.arrayValue?.compactMap { $0.objectValue?["name"]?.stringValue } ?? []
            refs = (refs + page).reduce(into: []) { names, name in if !names.contains(name) { names.append(name) } }
            nextCursor = value.objectValue?["nextCursor"]?.intValue
            isLoading = false
        } catch is CancellationError {} catch { errorMessage = error.localizedDescription; isLoading = false }
    }
}
