import Foundation
import Observation

enum SettingsCatalogPhase: Equatable, Sendable {
    case idle
    case loading
    case loaded
    case failed(message: String)
}

@MainActor
@Observable
final class SettingsFeatureStore {
    private(set) var catalog: MobileSettingsCatalog?
    private(set) var phase: SettingsCatalogPhase = .idle
    var searchText = ""

    @ObservationIgnored private let client: any SettingsCatalogStreaming
    @ObservationIgnored private let devicePreferences: SettingsDevicePreferences
    @ObservationIgnored private var subscriptionTask: Task<Void, Never>?
    @ObservationIgnored private var subscriptionID: UUID?

    init(
        client: any SettingsCatalogStreaming,
        devicePreferences: SettingsDevicePreferences
    ) {
        self.client = client
        self.devicePreferences = devicePreferences
    }

    deinit {
        subscriptionTask?.cancel()
    }

    var destinations: [SettingsDestinationSearchItem] {
        guard let catalog else { return [] }
        return SettingsDestinationSearchIndex.items(
            destinations: catalog.destinations,
            matching: searchText,
            locale: devicePreferences.locale
        )
    }

    var isLoading: Bool { phase == .loading }

    var errorMessage: String? {
        guard case let .failed(message) = phase else { return nil }
        return message
    }

    /// Idempotently starts the feature's one live settings-catalog subscription.
    func start() {
        guard subscriptionTask == nil else { return }
        if catalog == nil {
            phase = .loading
        }

        let id = UUID()
        let client = client
        subscriptionID = id
        subscriptionTask = Task { [weak self, client] in
            defer { self?.finishSubscription(id: id) }

            do {
                try await client.observeCatalog { [weak self] catalog in
                    self?.receive(catalog, subscriptionID: id)
                }
            } catch is CancellationError {
                return
            } catch {
                guard !Task.isCancelled else { return }
                self?.receive(error: error, subscriptionID: id)
            }
        }
    }

    func stop() {
        subscriptionTask?.cancel()
        subscriptionTask = nil
        subscriptionID = nil
        if catalog == nil {
            phase = .idle
        }
    }

    func retry() {
        stop()
        start()
    }

    /// Clears account-scoped data. Call this whenever the authenticated user or
    /// active company changes so stale identity and permission data cannot leak
    /// into the next settings presentation.
    func reset() {
        stop()
        catalog = nil
        searchText = ""
        phase = .idle
    }

    private func receive(_ value: MobileSettingsCatalog, subscriptionID id: UUID) {
        guard subscriptionID == id else { return }
        guard value.schemaVersion == MobileSettingsCatalog.supportedSchemaVersion else {
            catalog = nil
            phase = .failed(
                message: "This version of Pathway cannot read the latest settings catalog."
            )
            return
        }

        catalog = value
        phase = .loaded
    }

    private func receive(error: any Error, subscriptionID id: UUID) {
        guard subscriptionID == id else { return }
        phase = .failed(message: error.localizedDescription)
    }

    private func finishSubscription(id: UUID) {
        guard subscriptionID == id else { return }
        subscriptionTask = nil
        subscriptionID = nil
    }
}
