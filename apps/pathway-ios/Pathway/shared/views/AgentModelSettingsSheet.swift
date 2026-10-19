import SwiftUI

/// Both composers edit a local selection and apply it only when Save succeeds.
struct AgentModelSettingsSheet: View {
    @Environment(\.dismiss) private var dismiss
    let providers: [PathwayServerProvider]
    let selection: PathwayModelSelection
    let runtimeMode: String
    let interactionMode: String
    var environmentID: String? = nil
    var lockReason: String? = nil
    var refresh: (() async -> Void)? = nil
    let save: (PathwayModelSelection, String, String) async throws -> Void

    @State private var draft: PathwayModelSelection?
    @State private var access = "full-access"
    @State private var mode = "default"
    @State private var expandedProviders: Set<String> = []
    @State private var query = ""
    @State private var isSaving = false
    @State private var isRefreshing = false
    @State private var errorMessage: String?

    private var current: PathwayModelSelection { draft ?? selection }
    private var provider: PathwayServerProvider? { providers.first { $0.id == current.instanceId } }
    private var selectedModel: PathwayServerModel? { provider?.models.first { $0.id == current.model } }

    var body: some View {
        NavigationStack {
            Form {
                if let lockReason {
                    Section { Text(lockReason).foregroundStyle(.secondary) }
                }
                if providers.isEmpty {
                    Section { Text("Connect to the environment to load its models and options.").foregroundStyle(.secondary) }
                }
                if let environmentID, query.isEmpty {
                    AgentModelSettingsFavourites(providers: providers, selection: current, environmentID: environmentID) { provider, model in
                        selectModel(provider, model)
                    }
                }
                ForEach(providers) { provider in
                    let matches = provider.models.filter {
                        query.isEmpty || $0.name.localizedStandardContains(query) || provider.name.localizedStandardContains(query)
                    }
                    if query.isEmpty || !matches.isEmpty {
                        Section {
                            DisclosureGroup(isExpanded: Binding(
                                get: { !query.isEmpty || expandedProviders.contains(provider.id) },
                                set: { if $0 { expandedProviders.insert(provider.id) } else { expandedProviders.remove(provider.id) } }
                            )) {
                                if let reason = provider.unavailableReason {
                                    Text(reason).font(.caption).foregroundStyle(.secondary)
                                }
                                ForEach(matches) { model in
                                    Button {
                                        selectModel(provider, model)
                                    } label: {
                                        HStack {
                                            Text(model.name).foregroundStyle(.primary)
                                            if model.isDefault {
                                                Text("Default").font(.caption.weight(.semibold))
                                                    .padding(.horizontal, 6).padding(.vertical, 3)
                                                    .background(.quaternary, in: .rect(cornerRadius: 6))
                                            }
                                            Spacer()
                                            if current.instanceId == provider.id && current.model == model.id {
                                                Image(systemName: "checkmark").foregroundStyle(.primary)
                                            }
                                        }
                                        .frame(minHeight: 32)
                                        .contentShape(Rectangle())
                                    }
                                    .disabled(provider.unavailableReason != nil)
                                    .accessibilityIdentifier("thread-settings-model-\(provider.id)-\(model.id)")
                                    .accessibilityValue(current.instanceId == provider.id && current.model == model.id ? "Selected" : "")
                                }
                            } label: {
                                HStack {
                                    Text(provider.name)
                                    Spacer()
                                    Text("\(provider.models.count)").foregroundStyle(.secondary)
                                }
                            }
                        }
                    }
                }
                Section("Options") {
                    ForEach(selectedModel?.optionDescriptors ?? []) { descriptor in
                        optionControl(descriptor)
                    }
                    Picker("Runtime", selection: $access) {
                        Text("Ask before changes").tag("approval-required")
                        Text("Accept file edits").tag("auto-accept-edits")
                        Text("Automatic").tag("auto")
                        Text("Full access").tag("full-access")
                    }
                    .accessibilityIdentifier("agent-thread-runtime-mode")
                    if provider?.showsInteractionMode == true {
                        Picker("Mode", selection: $mode) {
                            Text("Work").tag("default")
                            Text("Plan").tag("plan")
                        }
                        .accessibilityIdentifier("agent-thread-interaction-mode")
                    }
                }
                .pickerStyle(.navigationLink)
            }
            .disabled(isSaving || isRefreshing || lockReason != nil)
            .safeAreaInset(edge: .bottom) {
                HStack(spacing: 12) {
                    if let environmentID {
                        NavigationLink {
                            PathwayModelFavouritesSettings(providers: providers, environmentID: environmentID)
                        } label: {
                            Image(systemName: "star").frame(width: 44, height: 44)
                        }
                        .accessibilityLabel("Favourite models")
                    }
                    HStack {
                        Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
                        TextField("Find a model", text: $query)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .accessibilityIdentifier("thread-settings-model-search")
                    }
                    .padding(14)
                    .background(.regularMaterial, in: Capsule())
                }
                .padding()
                .background(.bar)
            }
            .navigationTitle("Thread settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }.disabled(isSaving)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") { commit() }
                        .disabled(isSaving || isRefreshing || lockReason != nil || selectedModel == nil || provider?.unavailableReason != nil)
                }
                if let refresh {
                    ToolbarItem(placement: .primaryAction) {
                        Button("Refresh models", systemImage: "arrow.clockwise") {
                            isRefreshing = true
                            Task { await refresh(); isRefreshing = false }
                        }
                        .disabled(isSaving || isRefreshing)
                    }
                }
            }
            .task {
                guard draft == nil else { return }
                draft = selection
                access = runtimeMode
                mode = interactionMode
                expandedProviders.insert(selection.instanceId)
                if let refresh { isRefreshing = true; await refresh(); isRefreshing = false }
            }
            .interactiveDismissDisabled(isSaving)
            .overlay { if isSaving || isRefreshing { ProgressView() } }
            .alert("Couldn't save settings", isPresented: Binding(
                get: { errorMessage != nil }, set: { if !$0 { errorMessage = nil } }
            )) { Button("OK", role: .cancel) { errorMessage = nil } }
            message: { Text(errorMessage ?? "") }
        }
        .presentationDetents([.large])
        .presentationDragIndicator(.visible)
    }

    @ViewBuilder private func optionControl(_ descriptor: PathwayProviderOptionDescriptor) -> some View {
        if descriptor.type == "boolean" {
            Toggle(descriptor.label, isOn: Binding(
                get: { optionValue(descriptor)?.boolValue ?? false },
                set: { setOption(descriptor.id, value: .bool($0)) }
            ))
        } else if !descriptor.choices.isEmpty {
            Picker(descriptor.label, selection: Binding(
                get: { optionValue(descriptor)?.stringValue ?? "" },
                set: { setOption(descriptor.id, value: .string($0)) }
            )) {
                ForEach(descriptor.choices) { choice in Text(choice.label).tag(choice.id) }
            }
        }
    }

    private func selectModel(_ provider: PathwayServerProvider, _ model: PathwayServerModel) {
        guard current.instanceId != provider.id || current.model != model.id else { return }
        draft = .init(instanceId: provider.id, model: model.id, options: nil)
        expandedProviders.insert(provider.id)
        if !provider.showsInteractionMode { mode = "default" }
    }

    private func optionValue(_ descriptor: PathwayProviderOptionDescriptor) -> JSONValue? {
        current.options?.first { $0.id == descriptor.id }?.value ?? descriptor.currentValue
            ?? (descriptor.choices.first(where: \.isDefault) ?? descriptor.choices.first).map { .string($0.id) }
    }

    private func setOption(_ id: String, value: JSONValue) {
        var options = current.options ?? []
        options.removeAll { $0.id == id }
        options.append(.init(id: id, value: value))
        draft = .init(instanceId: current.instanceId, model: current.model, options: options)
    }

    private func commit() {
        isSaving = true
        Task {
            defer { isSaving = false }
            do { try await save(current, access, mode); dismiss() }
            catch { errorMessage = error.localizedDescription }
        }
    }
}

struct NewAgentModelSettingsSheet: View {
    @Bindable var model: PathwayAgentThreadCreationModel

    var body: some View {
        AgentModelSettingsSheet(
            providers: model.providers,
            selection: .init(instanceId: model.selectedProviderID, model: model.selectedModelID,
                             options: model.optionValues.map { .init(id: $0.key, value: $0.value) }),
            runtimeMode: model.runtimeMode, interactionMode: model.interactionMode,
            environmentID: model.environmentID
        ) { selection, access, mode in
            model.pinPlacement()
            model.selectedProviderID = selection.instanceId
            model.selectedModelID = selection.model
            for option in selection.options ?? [] { model.optionValues[option.id] = option.value }
            model.runtimeMode = access
            model.interactionMode = mode
        }
    }
}

private struct AgentModelSettingsFavourites: View {
    let providers: [PathwayServerProvider]
    let selection: PathwayModelSelection
    let select: (PathwayServerProvider, PathwayServerModel) -> Void
    @AppStorage private var storedFavourites: Data

    init(providers: [PathwayServerProvider], selection: PathwayModelSelection, environmentID: String,
         select: @escaping (PathwayServerProvider, PathwayServerModel) -> Void) {
        self.providers = providers
        self.selection = selection
        self.select = select
        _storedFavourites = AppStorage(wrappedValue: Data(), "thread-model-favourites.\(environmentID)")
    }

    var body: some View {
        let favourites = (try? JSONDecoder().decode([PathwayModelFavourite].self, from: storedFavourites)) ?? []
        if !favourites.isEmpty {
            Section("Favourites") {
                ForEach(providers) { provider in
                    ForEach(provider.models.filter { favourites.contains(.init(provider: provider.id, model: $0.id)) }) { model in
                        Button { select(provider, model) } label: {
                            HStack {
                                Label(model.name, systemImage: "star.fill")
                                Text(provider.name).foregroundStyle(.secondary)
                                Spacer()
                                if selection.instanceId == provider.id && selection.model == model.id {
                                    Image(systemName: "checkmark")
                                }
                            }
                            .foregroundStyle(.primary)
                        }
                        .disabled(provider.unavailableReason != nil)
                        .accessibilityIdentifier("thread-settings-favourite-\(provider.id)-\(model.id)")
                    }
                }
            }
        }
    }
}
