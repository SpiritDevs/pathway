#if !os(visionOS)
import Combine
import Foundation
import Testing
@testable import Pathway

@MainActor
struct PathwayConvexSubscriptionTests {
    private enum SubscriptionError: Error, Equatable { case rejected }

    @Test func backgroundFailureReachesMainActorConsumer() async {
        let publisher = PathwayConvexClient.erasingSubscriptionErrors(Self.backgroundResult(.failure(.rejected)))
        do {
            for try await _ in publisher.values { Issue.record("A failed subscription must not emit a value") }
            Issue.record("Expected the subscription error")
        } catch {
            MainActor.assertIsolated()
            #expect(error as? SubscriptionError == .rejected)
        }
    }

    @Test func backgroundValueIsPreserved() async throws {
        let publisher = PathwayConvexClient.erasingSubscriptionErrors(Self.backgroundResult(.success(42)))
        var values: [Int] = []
        for try await value in publisher.values { values.append(value) }
        MainActor.assertIsolated()
        #expect(values == [42])
    }

    private nonisolated static func backgroundResult(_ result: Result<Int, SubscriptionError>) -> AnyPublisher<Int, SubscriptionError> {
        result.publisher
            .receive(on: DispatchQueue(label: "pathway-test-convex-callback"))
            .eraseToAnyPublisher()
    }
}
#endif
