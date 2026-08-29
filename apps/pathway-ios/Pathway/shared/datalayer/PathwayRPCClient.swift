import Foundation

// Effect RPC framing, reconnect ownership, stream backpressure, and keepalive state form one
// transport state machine and must evolve together.
// swiftlint:disable file_length

enum PathwayRPCError: LocalizedError, Sendable {
    case disconnected
    case protocolViolation(String)
    case remote(String)

    var errorDescription: String? {
        switch self {
        case .disconnected: "The Pathway environment disconnected."
        case let .protocolViolation(message): message
        case let .remote(message): message
        }
    }
}

private struct PathwayRPCRequest: Encodable, Sendable {
    let envelopeTag = "Request"
    let id: Int
    let tag: String
    let payload: JSONValue
    let headers: [[String]] = []

    enum CodingKeys: String, CodingKey {
        case envelopeTag = "_tag"
        case id
        case tag
        case payload
        case headers
    }
}

private struct PathwayRPCControl: Encodable, Sendable {
    let envelopeTag: String
    let requestId: Int?

    enum CodingKeys: String, CodingKey {
        case envelopeTag = "_tag"
        case requestId
    }
}

private struct PathwayRPCCause: Decodable, Sendable {
    let error: JSONValue?
    let defect: JSONValue?
}

private struct PathwayRPCPendingRequest {
    let envelope: PathwayRPCRequest
    var sent = false
    let resume: @Sendable (Result<JSONValue, Error>) -> Void
}

private struct PathwayRPCExit: Decodable, Sendable {
    let envelopeTag: String
    let value: JSONValue?
    let cause: [PathwayRPCCause]?

    enum CodingKeys: String, CodingKey {
        case envelopeTag = "_tag"
        case value
        case cause
    }
}

private struct PathwayRPCResponse: Decodable, Sendable {
    let envelopeTag: String
    let requestId: Int?
    let values: [JSONValue]?
    let exit: PathwayRPCExit?
    let defect: JSONValue?

    enum CodingKeys: String, CodingKey {
        case envelopeTag = "_tag"
        case requestId
        case values
        case exit
        case defect
    }
}

// swiftlint:disable type_body_length
actor PathwayRPCClient {
    typealias EndpointProvider = @Sendable () async throws -> URL

    private let endpointProvider: EndpointProvider
    private let session: URLSession
    private var socket: URLSessionWebSocketTask?
    private var connectionID: UUID?
    private var loopTask: Task<Void, Never>?
    private var keepaliveTask: Task<Void, Never>?
    private var awaitingKeepaliveResponse = false
    private var desired = false
    private var nextRequestID = 1
    private var pending: [Int: PathwayRPCPendingRequest] = [:]
    private var subscriptionTag: String?
    private var subscriptionPayload: JSONValue?
    private var subscriptionRequestID: Int?
    private var subscriptionContinuation: AsyncThrowingStream<JSONValue, Error>.Continuation?

    init(
        session: URLSession = .shared,
        endpointProvider: @escaping EndpointProvider
    ) {
        self.session = session
        self.endpointProvider = endpointProvider
    }

    deinit {
        loopTask?.cancel()
        keepaliveTask?.cancel()
        socket?.cancel(with: .goingAway, reason: nil)
    }

    func subscribeToThread(_ threadID: String) -> AsyncThrowingStream<JSONValue, Error> {
        subscribe(
            "orchestration.subscribeThread",
            payload: .object([
                "threadId": .string(threadID),
                "requestCompletionMarker": .bool(true)
            ])
        )
    }

    func subscribe(
        _ tag: String,
        payload: JSONValue
    ) -> AsyncThrowingStream<JSONValue, Error> {
        subscriptionContinuation?.finish()
        subscriptionTag = tag
        subscriptionPayload = payload
        let stream = AsyncThrowingStream<JSONValue, Error>(bufferingPolicy: .bufferingOldest(256)) { continuation in
            subscriptionContinuation = continuation
            continuation.onTermination = { @Sendable _ in
                Task { await self.removeSubscription() }
            }
        }
        start()
        if socket != nil {
            Task { await self.sendSubscription() }
        }
        return stream
    }

    func request(_ tag: String, payload: JSONValue) async throws -> JSONValue {
        start()
        let id = allocateRequestID()
        let envelope = PathwayRPCRequest(id: id, tag: tag, payload: payload)
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                guard !Task.isCancelled else {
                    continuation.resume(throwing: CancellationError())
                    return
                }
                pending[id] = PathwayRPCPendingRequest(
                    envelope: envelope,
                    resume: { continuation.resume(with: $0) }
                )
                if socket != nil {
                    Task { await self.sendPending(id) }
                }
            }
        } onCancel: {
            Task { await self.cancelPending(id) }
        }
    }

    func stop() {
        desired = false
        loopTask?.cancel()
        loopTask = nil
        keepaliveTask?.cancel()
        keepaliveTask = nil
        awaitingKeepaliveResponse = false
        socket?.cancel(with: .goingAway, reason: nil)
        socket = nil
        connectionID = nil
        subscriptionRequestID = nil
        subscriptionContinuation?.finish()
        subscriptionContinuation = nil
        for request in pending.values {
            request.resume(.failure(PathwayRPCError.disconnected))
        }
        pending.removeAll()
    }

    private func start() {
        desired = true
        guard loopTask == nil else { return }
        loopTask = Task { [weak self] in
            await self?.connectionLoop()
        }
    }

    private func connectionLoop() async {
        var failureCount = 0
        while desired, !Task.isCancelled {
            let id = UUID()
            do {
                let url = try await endpointProvider()
                guard desired, !Task.isCancelled else { return }
                let task = session.webSocketTask(with: url)
                task.resume()
                install(task, id: id)
                try await receiveLoop(task, id: id)
                failureCount = 0
            } catch is CancellationError {
                break
            } catch {
                disconnect(id: id)
                guard desired, !Task.isCancelled else { break }
                failureCount += 1
                let delay = min(5.0, 0.35 * pow(1.7, Double(failureCount - 1)))
                try? await Task.sleep(for: .seconds(delay * Double.random(in: 0.5 ... 1)))
            }
        }
        loopTask = nil
    }

    private func install(_ task: URLSessionWebSocketTask, id: UUID) {
        socket?.cancel(with: .goingAway, reason: nil)
        socket = task
        connectionID = id
        awaitingKeepaliveResponse = false
        keepaliveTask?.cancel()
        keepaliveTask = Task { [weak self] in
            await self?.keepaliveLoop(connectionID: id)
        }
        subscriptionRequestID = nil
        for pendingID in pending.keys {
            pending[pendingID]?.sent = false
            Task { await self.sendPending(pendingID) }
        }
        Task { await self.sendSubscription() }
    }

    private func receiveLoop(_ task: URLSessionWebSocketTask, id: UUID) async throws {
        while desired, connectionID == id, !Task.isCancelled {
            let message = try await task.receive()
            let data: Data
            switch message {
            case let .data(value): data = value
            case let .string(value):
                guard let value = value.data(using: .utf8) else {
                    throw PathwayRPCError.protocolViolation("Pathway sent invalid text.")
                }
                data = value
            @unknown default:
                throw PathwayRPCError.protocolViolation("Pathway sent an unknown message.")
            }
            try await handle(data, connectionID: id)
        }
    }

    // swiftlint:disable:next cyclomatic_complexity
    private func handle(_ data: Data, connectionID: UUID) async throws {
        guard self.connectionID == connectionID else { return }
        let response = try JSONDecoder().decode(PathwayRPCResponse.self, from: data)
        awaitingKeepaliveResponse = false
        switch response.envelopeTag {
        case "Pong":
            return
        case "Chunk":
            guard response.requestId == subscriptionRequestID else { return }
            for value in response.values ?? [] {
                if case .dropped = subscriptionContinuation?.yield(value) {
                    throw PathwayRPCError.protocolViolation(
                        "The live thread produced events faster than the app could display them."
                    )
                }
            }
            try await sendControl("Ack", requestID: response.requestId)
        case "Exit":
            guard let requestID = response.requestId, let exit = response.exit else { return }
            if pending[requestID] != nil {
                complete(
                    requestID,
                    result: exit.envelopeTag == "Success"
                        ? .success(exit.value ?? .null)
                        : .failure(PathwayRPCError.remote(Self.remoteMessage(exit)))
                )
            } else if requestID == subscriptionRequestID {
                subscriptionRequestID = nil
                if exit.envelopeTag != "Success" {
                    throw PathwayRPCError.remote(Self.remoteMessage(exit))
                }
            }
        case "Defect", "ClientProtocolError":
            throw PathwayRPCError.remote(response.defect?.displayString ?? "Pathway RPC failed.")
        default:
            throw PathwayRPCError.protocolViolation("Unknown Pathway RPC response.")
        }
    }

    private func disconnect(id: UUID) {
        guard connectionID == id else { return }
        socket?.cancel(with: .goingAway, reason: nil)
        socket = nil
        connectionID = nil
        keepaliveTask?.cancel()
        keepaliveTask = nil
        awaitingKeepaliveResponse = false
        subscriptionRequestID = nil
        let sentIDs = pending.compactMap { $0.value.sent ? $0.key : nil }
        for id in sentIDs {
            complete(id, result: .failure(PathwayRPCError.disconnected))
        }
    }

    private func sendPending(_ id: Int) async {
        guard
            let socket,
            let connectionID,
            var request = pending[id],
            !request.sent
        else { return }
        request.sent = true
        pending[id] = request
        do {
            try await socket.send(.data(JSONEncoder.pathwayRPC.encode(request.envelope)))
        } catch {
            complete(id, result: .failure(PathwayRPCError.disconnected))
            disconnect(id: connectionID)
        }
    }

    private func sendSubscription() async {
        guard
            let subscriptionTag,
            let subscriptionPayload,
            let socket,
            let connectionID,
            subscriptionRequestID == nil
        else { return }
        let requestID = allocateRequestID()
        subscriptionRequestID = requestID
        let request = PathwayRPCRequest(
            id: requestID,
            tag: subscriptionTag,
            payload: subscriptionPayload
        )
        do {
            try await socket.send(.data(JSONEncoder.pathwayRPC.encode(request)))
        } catch {
            subscriptionRequestID = nil
            disconnect(id: connectionID)
        }
    }

    private func sendControl(_ tag: String, requestID: Int?) async throws {
        guard let socket, let connectionID else { throw PathwayRPCError.disconnected }
        do {
            try await socket.send(
                .data(JSONEncoder.pathwayRPC.encode(
                    PathwayRPCControl(envelopeTag: tag, requestId: requestID)
                ))
            )
        } catch {
            disconnect(id: connectionID)
            throw PathwayRPCError.disconnected
        }
    }

    private func keepaliveLoop(connectionID: UUID) async {
        while desired, self.connectionID == connectionID, !Task.isCancelled {
            do {
                try await Task.sleep(for: .seconds(5))
            } catch {
                return
            }
            guard desired, self.connectionID == connectionID else { return }
            if awaitingKeepaliveResponse {
                disconnect(id: connectionID)
                return
            }
            awaitingKeepaliveResponse = true
            do {
                try await sendControl("Ping", requestID: nil)
            } catch {
                return
            }
        }
    }

    private func removeSubscription() async {
        if let subscriptionRequestID {
            try? await sendControl("Interrupt", requestID: subscriptionRequestID)
        }
        subscriptionRequestID = nil
        subscriptionContinuation = nil
        subscriptionTag = nil
        subscriptionPayload = nil
    }

    private func cancelPending(_ id: Int) {
        guard let request = pending.removeValue(forKey: id) else { return }
        if request.sent {
            Task { try? await self.sendControl("Interrupt", requestID: id) }
        }
        request.resume(.failure(CancellationError()))
    }

    private func complete(_ id: Int, result: Result<JSONValue, Error>) {
        pending.removeValue(forKey: id)?.resume(result)
    }

    private func allocateRequestID() -> Int {
        defer { nextRequestID += 1 }
        return nextRequestID
    }

    private static func remoteMessage(_ exit: PathwayRPCExit) -> String {
        exit.cause?.compactMap { $0.error?.displayString ?? $0.defect?.displayString }.first
            ?? "The Pathway environment rejected the request."
    }
}

// swiftlint:enable type_body_length

private extension JSONEncoder {
    static let pathwayRPC: JSONEncoder = {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return encoder
    }()
}

// swiftlint:enable file_length
