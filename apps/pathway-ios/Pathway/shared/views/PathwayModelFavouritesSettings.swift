import SwiftUI

struct PathwayModelFavourite: Codable, Equatable {
    let provider: String
    let model: String
}

struct PathwayModelFavouritesSettings: View {
    let providers: [PathwayServerProvider]
    @AppStorage private var storedFavourites: Data

    init(providers: [PathwayServerProvider], environmentID: String) {
        self.providers = providers
        _storedFavourites = AppStorage(wrappedValue: Data(), "thread-model-favourites.\(environmentID)")
    }

    private var favourites: [PathwayModelFavourite] {
        (try? JSONDecoder().decode([PathwayModelFavourite].self, from: storedFavourites)) ?? []
    }

    var body: some View {
        List {
            ForEach(providers) { provider in
                Section(provider.name) {
                    ForEach(provider.models) { model in
                        let item = PathwayModelFavourite(provider: provider.id, model: model.id)
                        Button {
                            let enabled = !favourites.contains(item)
                            var updated = favourites.filter { $0 != item }
                            if enabled { updated.append(item) }
                            if let data = try? JSONEncoder().encode(updated) { storedFavourites = data }
                        } label: {
                            Label(model.name, systemImage: favourites.contains(item) ? "star.fill" : "star")
                        }
                        .accessibilityValue(favourites.contains(item) ? "Favourite" : "Not favourite")
                        .accessibilityIdentifier("model-favourite-\(provider.id)-\(model.id)")
                    }
                }
            }
            Section {
                Text("Favourites are saved on this device for this environment and appear at the top of the model picker.")
                    .foregroundStyle(.secondary)
            }
        }
        .navigationTitle("Favourite models")
        .navigationBarTitleDisplayMode(.inline)
    }
}

struct PathwayModelFavouritesEnvironments: View {
    @Environment(PathwayAppModel.self) private var appModel

    var body: some View {
        List {
            ForEach(appModel.cloud.environments.filter { $0.environment.state == "active" }) { environment in
                if let connect = appModel.connect {
                    NavigationLink(environment.environment.label) {
                        PathwayEnvironmentModelFavourites(environment: environment, connect: connect)
                    }
                }
            }
        }
        .overlay {
            if appModel.cloud.environments.isEmpty {
                ContentUnavailableView("No environments", systemImage: "desktopcomputer", description: Text("Connect an environment to choose its favourite models."))
            }
        }
        .navigationTitle("Choose environment")
    }
}

private struct PathwayEnvironmentModelFavourites: View {
    let environment: PathwayCompanyEnvironment
    let connect: PathwayConnectClient
    @State private var providers: [PathwayServerProvider] = []
    @State private var loaded = false
    @State private var error: String?

    var body: some View {
        Group {
            if loaded {
                PathwayModelFavouritesSettings(providers: providers, environmentID: environment.environment.environmentId)
            } else if let error {
                ContentUnavailableView("Couldn't load models", systemImage: "wifi.exclamationmark", description: Text(error))
            } else { ProgressView("Loading models…") }
        }
        .task {
            let rpc = PathwayRPCClient { try await connect.prepare(environment: environment).webSocketURL }
            do {
                let stream = await rpc.subscribe("subscribeServerConfig", payload: .object([:]))
                for try await value in stream {
                    guard !Task.isCancelled else { break }
                    let object = value.objectValue ?? [:]
                    let config = object["config"]?.objectValue ?? object["payload"]?.objectValue
                    if let values = config?["providers"]?.arrayValue {
                        providers = values.compactMap(PathwayAgentThreadModel.provider)
                        loaded = true
                        error = nil
                    }
                }
            } catch is CancellationError {
            } catch { self.error = error.localizedDescription }
            await rpc.stop()
        }
    }
}
