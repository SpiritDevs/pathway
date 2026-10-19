import SwiftUI

struct AgentThreadModelMenuContent: View {
    let providers: [PathwayServerProvider]
    let selection: PathwayModelSelection
    let onSelect: (String, String) -> Void
    @AppStorage private var storedFavourites: Data


    init(providers: [PathwayServerProvider], selection: PathwayModelSelection,
         environmentID: String, onSelect: @escaping (String, String) -> Void) {
        self.providers = providers
        self.selection = selection
        self.onSelect = onSelect
        _storedFavourites = AppStorage(wrappedValue: Data(), "thread-model-favourites.\(environmentID)")
    }

    private var favourites: [PathwayModelFavourite] {
        (try? JSONDecoder().decode([PathwayModelFavourite].self, from: storedFavourites)) ?? []
    }

    private func isFavourite(_ provider: PathwayServerProvider, _ model: PathwayServerModel) -> Bool {
        favourites.contains(PathwayModelFavourite(provider: provider.id, model: model.id))
    }

    var body: some View {
        Section("Favourites") {
            if !providers.contains(where: { provider in provider.models.contains { isFavourite(provider, $0) } }) {
                Text("Choose favourites in Settings")
            }
            ForEach(providers) { provider in
                ForEach(provider.models.filter { isFavourite(provider, $0) }) { model in
                    modelButton(provider, model, showProvider: true)
                }
            }
        }
        Section("Providers") {
            ForEach(providers) { provider in
                Menu {
                    if let reason = provider.unavailableReason {
                        Text(reason)
                    }
                    let remaining = provider.models.filter { !isFavourite(provider, $0) }
                    if provider.models.isEmpty { Text("No models reported by this environment") }
                    else if remaining.isEmpty { Text("All models are in Favourites") }
                    ForEach(remaining) { model in
                        modelButton(provider, model)
                    }
                } label: {
                    Text(provider.name + (provider.unavailableReason == nil ? "" : " · Not set up"))
                }
            }
        }
    }

    private func modelButton(_ provider: PathwayServerProvider, _ model: PathwayServerModel,
                             showProvider: Bool = false) -> some View {
        Button { onSelect(provider.id, model.id) } label: {
            let title = model.name + (showProvider ? " · \(provider.name)" : "")
            if showProvider {
                Label(title + (provider.unavailableReason == nil ? "" : " · Not set up"), systemImage: "star.fill")
            } else if provider.unavailableReason != nil {
                Label(title + " · Not set up", systemImage: "exclamationmark.circle")
            } else if selection.instanceId == provider.id && selection.model == model.id {
                Label(title, systemImage: "checkmark")
            } else { Text(title) }
        }
        .disabled(provider.unavailableReason != nil)
        .accessibilityValue(selection.instanceId == provider.id && selection.model == model.id ? "Selected" : "")
    }
}
