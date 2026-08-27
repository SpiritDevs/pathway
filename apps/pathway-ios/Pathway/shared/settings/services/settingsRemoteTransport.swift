@preconcurrency import ConvexMobile
import Foundation

enum SettingsRemoteMethod: String, Equatable, Sendable {
    case query
    case mutation
    case action
}

/// A testable description of one existing Convex settings operation.
struct SettingsRemoteRequest {
    let method: SettingsRemoteMethod
    let function: String
    let arguments: [String: ConvexEncodable?]?

    init(
        _ method: SettingsRemoteMethod,
        _ function: String,
        arguments: [String: ConvexEncodable?]? = nil
    ) {
        self.method = method
        self.function = function
        self.arguments = arguments
    }
}

@MainActor
protocol SettingsRemoteTransporting: AnyObject {
    func queryOnce<Value: Decodable>(
        _ function: String,
        arguments: [String: ConvexEncodable?]?
    ) async throws -> Value

    func mutate<Value: Decodable>(
        _ function: String,
        arguments: sending [String: ConvexEncodable?]?
    ) async throws -> Value

    func act<Value: Decodable>(
        _ function: String,
        arguments: sending [String: ConvexEncodable?]?
    ) async throws -> Value

    func observe<Value: Decodable>(
        _ function: String,
        arguments: [String: ConvexEncodable?]?,
        receiveValue: @MainActor @escaping (Value) -> Void
    ) async throws
}

@MainActor
final class SettingsRemoteTransport: SettingsRemoteTransporting {
    private let convex: ConvexClientWithAuth<PathwayAuthSession>

    init(convex: ConvexClientWithAuth<PathwayAuthSession>) {
        self.convex = convex
    }

    func queryOnce<Value: Decodable>(
        _ function: String,
        arguments: [String: ConvexEncodable?]? = nil
    ) async throws -> Value {
        let values = convex.subscribe(
            to: function,
            with: arguments,
            yielding: Value.self
        ).values

        for try await value in values {
            try Task.checkCancellation()
            return value
        }
        throw CancellationError()
    }

    func mutate<Value: Decodable>(
        _ function: String,
        arguments: sending [String: ConvexEncodable?]? = nil
    ) async throws -> Value {
        try await convex.mutation(function, with: arguments)
    }

    func act<Value: Decodable>(
        _ function: String,
        arguments: sending [String: ConvexEncodable?]? = nil
    ) async throws -> Value {
        try await convex.action(function, with: arguments)
    }

    func observe<Value: Decodable>(
        _ function: String,
        arguments: [String: ConvexEncodable?]? = nil,
        receiveValue: @MainActor @escaping (Value) -> Void
    ) async throws {
        let values = convex.subscribe(
            to: function,
            with: arguments,
            yielding: Value.self
        ).values

        for try await value in values {
            try Task.checkCancellation()
            receiveValue(value)
        }
    }
}
