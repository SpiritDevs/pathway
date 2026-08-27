@preconcurrency import ConvexMobile
import Foundation

@MainActor
protocol SettingsCatalogStreaming: AnyObject {
    func observeCatalog(
        receiveValue: @MainActor @escaping (MobileSettingsCatalog) -> Void
    ) async throws
}

@MainActor
final class ConvexSettingsCatalogClient: SettingsCatalogStreaming {
    static let catalogFunction = "functions/settings/mobileCatalog:getMobileSettingsCatalog"

    private let convex: ConvexClientWithAuth<PathwayAuthSession>

    init(convex: ConvexClientWithAuth<PathwayAuthSession>) {
        self.convex = convex
    }

    func observeCatalog(
        receiveValue: @MainActor @escaping (MobileSettingsCatalog) -> Void
    ) async throws {
        let updates = convex.subscribe(
            to: Self.catalogFunction,
            yielding: MobileSettingsCatalog.self
        ).values

        for try await catalog in updates {
            try Task.checkCancellation()
            receiveValue(catalog)
        }
    }
}
