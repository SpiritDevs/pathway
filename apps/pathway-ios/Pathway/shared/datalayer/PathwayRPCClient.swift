import Foundation

// Effect RPC framing, reconnect ownership, stream backpressure, and keepalive state form one
// transport state machine and must evolve together.
// swiftlint:disable file_length

enum PathwayRPCError: LocalizedError, Sendable {
    case disconnected
    case timedOut
    case protocolViolation(String)
    case remote(String)
    case rejected(message: String, detail: String)

    var errorDescription: String? {
        switch self {
        case .disconnected: "The Pathway environment disconnected."
        case .timedOut: "The environment did not respond in time. Check the latest state before retrying."
        case let .protocolViolation(message): message
        case let .remote(message): message
        case let .rejected(message, _): message
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
    var requiresSubscription = false
    var deadlineTask: Task<Void, Never>?
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
    private var subscriptionID: UUID?
    private var subscriptionTag: String?
    private var subscriptionPayload: JSONValue?
    private var subscriptionRequestID: Int?
    private var threadCompletionMarkerSupported = true
    private var subscriptionGate = PathwayRPCSubscriptionGate()
    private var subscriptionContinuation: AsyncThrowingStream<JSONValue, Error>.Continuation?
    private var subscriptionBufferingPolicy: AsyncThrowingStream<JSONValue, Error>.Continuation.BufferingPolicy = .bufferingOldest(256)

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
            payload: .object(["threadId": .string(threadID)])
        )
    }

    func subscribe(
        _ tag: String,
        payload: JSONValue
    ) -> AsyncThrowingStream<JSONValue, Error> {
        subscribe(tag, payload: payload, bufferingPolicy: .bufferingOldest(256))
    }

    func subscribe(
        _ tag: String,
        payload: JSONValue,
        bufferingPolicy: AsyncThrowingStream<JSONValue, Error>.Continuation.BufferingPolicy
    ) -> AsyncThrowingStream<JSONValue, Error> {
        subscriptionContinuation?.finish()
        let subscriptionID = UUID()
        self.subscriptionID = subscriptionID
        subscriptionTag = tag
        subscriptionPayload = payload
        subscriptionBufferingPolicy = bufferingPolicy
        let stream = AsyncThrowingStream<JSONValue, Error>(bufferingPolicy: bufferingPolicy) { continuation in
            subscriptionContinuation = continuation
            continuation.onTermination = { @Sendable _ in
                Task { await self.removeSubscription(id: subscriptionID) }
            }
        }
        yieldTransportState("connecting")
        start()
        if socket != nil {
            Task { await self.sendSubscription() }
        }
        return stream
    }

    func request(_ tag: String, payload: JSONValue, requiresSubscription: Bool = false, waitForSubscription: Bool = true, timeout: Duration = .seconds(30)) async throws -> JSONValue {
        // Never retain a stale approval or mutation until a later connection becomes ready.
        if requiresSubscription, !waitForSubscription, !subscriptionGate.allowsRequest(requiresSubscription: true) {
            throw PathwayRPCError.disconnected
        }
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
                    requiresSubscription: requiresSubscription,
                    deadlineTask: Task { [weak self] in
                        do { try await Task.sleep(for: timeout) } catch { return }
                        await self?.expirePending(id)
                    },
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
        subscriptionGate.reset()
        yieldTransportState("disconnected")
        subscriptionContinuation?.finish()
        subscriptionContinuation = nil
        subscriptionID = nil
        subscriptionTag = nil
        subscriptionPayload = nil
        for request in pending.values {
            request.deadlineTask?.cancel()
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
            var installed = false
            do {
                let url = try await endpointProvider()
                guard desired, !Task.isCancelled else { return }
                let task = session.webSocketTask(with: url)
                // Thread subscriptions include the initial history in one frame. Match the
                // native cloud transport's limit so larger histories can finish loading.
                task.maximumMessageSize = 16 * 1024 * 1024
                task.resume()
                install(task, id: id)
                installed = true
                try await receiveLoop(task, id: id)
                failureCount = 0
            } catch is CancellationError {
                break
            } catch {
                guard desired, !Task.isCancelled else { break }
                if connectionID == id {
                    disconnect(id: id, error: error.localizedDescription)
                } else if !installed {
                    yieldTransportState("disconnected", error: error.localizedDescription)
                }
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
        subscriptionGate.reset()
        yieldTransportState("connecting")
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
            let values = response.values ?? []
            let legacySnapshot = subscriptionTag == "orchestration.subscribeThread"
                && !threadCompletionMarkerSupported
                && values.contains { $0.objectValue?["kind"]?.stringValue == "snapshot" }
            let acknowledged = subscriptionTag != "orchestration.subscribeThread"
                || legacySnapshot
                || values.contains { $0.objectValue?["kind"]?.stringValue == "synchronized" }
            var becameReady = false
            if acknowledged, subscriptionGate.receiveChunk(requestID: response.requestId) {
                becameReady = true
                for id in pending.keys { Task { await self.sendPending(id) } }
            }
            for value in values { try yieldSubscriptionValue(value) }
            if legacySnapshot, becameReady {
                // Older servers complete their initial load with a full snapshot.
                // Normalize that boundary only after the snapshot reaches the consumer.
                try yieldSubscriptionValue(.object(["kind": .string("synchronized")]))
            }
            try await sendControl("Ack", requestID: response.requestId)
        case "Exit":
            guard let requestID = response.requestId, let exit = response.exit else { return }
            if pending[requestID] != nil {
                complete(
                    requestID,
                    result: exit.envelopeTag == "Success"
                        ? .success(exit.value ?? .null)
                        : .failure(Self.remoteError(exit))
                )
            } else if requestID == subscriptionRequestID {
                subscriptionRequestID = nil
                subscriptionGate.reset()
                yieldTransportState("disconnected")
                if exit.envelopeTag != "Success" {
                    let error = Self.remoteError(exit)
                    let waiting = pending.filter { $0.value.requiresSubscription }.map(\.key)
                    for id in waiting { complete(id, result: .failure(error)) }
                    throw error
                }
            }
        case "Defect", "ClientProtocolError":
            throw PathwayRPCError.remote(response.defect?.displayString ?? "Pathway RPC failed.")
        default:
            throw PathwayRPCError.protocolViolation("Unknown Pathway RPC response.")
        }
    }

    private func disconnect(id: UUID, error: String? = nil) {
        guard connectionID == id else { return }
        socket?.cancel(with: .goingAway, reason: nil)
        socket = nil
        connectionID = nil
        keepaliveTask?.cancel()
        keepaliveTask = nil
        awaitingKeepaliveResponse = false
        subscriptionRequestID = nil
        subscriptionGate.reset()
        yieldTransportState("disconnected", error: error)
        for id in Array(pending.keys) {
            complete(id, result: .failure(PathwayRPCError.disconnected))
        }
    }

    private func sendPending(_ id: Int) async {
        guard
            let socket,
            let connectionID,
            var request = pending[id],
            !request.sent,
            subscriptionGate.allowsRequest(requiresSubscription: request.requiresSubscription)
        else { return }
        request.sent = true
        pending[id] = request
        do {
            try await socket.send(.data(JSONEncoder.pathwayRPC.encode(request.envelope)))
        } catch {
            complete(id, result: .failure(PathwayRPCError.disconnected))
            disconnect(id: connectionID, error: error.localizedDescription)
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
        subscriptionGate.open(requestID: requestID)
        do {
            var payload = subscriptionPayload
            if subscriptionTag == "orchestration.subscribeThread" {
                let config = try await request("server.getConfig", payload: .object([:]))
                guard self.connectionID == connectionID, subscriptionRequestID == requestID else { return }
                threadCompletionMarkerSupported = config.objectValue?["threadResumeCompletionMarker"]?.boolValue == true
                if threadCompletionMarkerSupported, var fields = payload.objectValue {
                    fields["requestCompletionMarker"] = .bool(true)
                    payload = .object(fields)
                }
                try yieldSubscriptionValue(.object(["_pathwayServerConfig": config]))
            }
            let request = PathwayRPCRequest(id: requestID, tag: subscriptionTag, payload: payload)
            try await socket.send(.data(JSONEncoder.pathwayRPC.encode(request)))
        } catch {
            guard self.connectionID == connectionID, subscriptionRequestID == requestID else { return }
            disconnect(id: connectionID, error: error.localizedDescription)
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
            disconnect(id: connectionID, error: error.localizedDescription)
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

    private func removeSubscription(id: UUID) async {
        guard subscriptionID == id else { return }
        let previousRequestID = subscriptionRequestID
        subscriptionID = nil
        subscriptionRequestID = nil
        subscriptionGate.reset()
        yieldTransportState("disconnected")
        subscriptionContinuation = nil
        subscriptionTag = nil
        subscriptionPayload = nil
        if let previousRequestID { try? await sendControl("Interrupt", requestID: previousRequestID) }
    }

    private func cancelPending(_ id: Int) {
        guard let request = pending.removeValue(forKey: id) else { return }
        request.deadlineTask?.cancel()
        if request.sent {
            Task { try? await self.sendControl("Interrupt", requestID: id) }
        }
        request.resume(.failure(CancellationError()))
    }

    private func complete(_ id: Int, result: Result<JSONValue, Error>) {
        guard let request = pending.removeValue(forKey: id) else { return }
        request.deadlineTask?.cancel()
        request.resume(result)
    }

    private func expirePending(_ id: Int) {
        guard let request = pending[id] else { return }
        if request.sent { Task { try? await self.sendControl("Interrupt", requestID: id) } }
        complete(id, result: .failure(PathwayRPCError.timedOut))
    }

    /// Transport changes share the subscription queue so an old snapshot cannot overwrite
    /// a newer disconnect notification in the consumer.
    private func yieldTransportState(_ state: String, error: String? = nil) {
        guard let subscriptionContinuation else { return }
        pathwayRPCYieldTransportState(state, error: error, to: subscriptionContinuation, policy: subscriptionBufferingPolicy)
    }

    private func yieldSubscriptionValue(_ value: JSONValue) throws {
        if let result = subscriptionContinuation?.yield(value),
           pathwayRPCBufferOverflowIsFatal(result, policy: subscriptionBufferingPolicy) {
            throw PathwayRPCError.protocolViolation(
                "The live thread produced events faster than the app could display them."
            )
        }
    }

    private func allocateRequestID() -> Int {
        defer { nextRequestID += 1 }
        return nextRequestID
    }

    private static func remoteMessage(_ exit: PathwayRPCExit) -> String {
        exit.cause?.compactMap { $0.error?.displayString ?? $0.defect?.displayString }.first
            ?? "The Pathway environment rejected the request."
    }

    private static func remoteError(_ exit: PathwayRPCExit) -> PathwayRPCError {
        let message = remoteMessage(exit)
        if let detail = exit.cause?.compactMap({ $0.error?.objectValue?["detail"]?.stringValue }).first {
            return .rejected(message: message, detail: detail)
        }
        return .remote(message)
    }
}

/// Frame streams deliberately replace old images; conversation streams must recover lost events.
func pathwayRPCBufferOverflowIsFatal(
    _ result: AsyncThrowingStream<JSONValue, Error>.Continuation.YieldResult,
    policy: AsyncThrowingStream<JSONValue, Error>.Continuation.BufferingPolicy
) -> Bool {
    guard case .dropped = result else { return false }
    if case .bufferingNewest = policy { return false }
    return true
}

func pathwayRPCYieldTransportState(
    _ state: String,
    error: String? = nil,
    to continuation: AsyncThrowingStream<JSONValue, Error>.Continuation,
    policy: AsyncThrowingStream<JSONValue, Error>.Continuation.BufferingPolicy
) {
    var value: [String: JSONValue] = ["_pathwayTransport": .string(state)]
    if let error { value["_pathwayTransportError"] = .string(error) }
    let result = continuation.yield(.object(value))
    if pathwayRPCBufferOverflowIsFatal(result, policy: policy) {
        continuation.finish(throwing: PathwayRPCError.disconnected)
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

/// An issue RPC can run only after this socket has acknowledged the current subscription.
struct PathwayRPCSubscriptionGate {
    private var requestID: Int?
    private var ready = false

    mutating func open(requestID: Int) {
        self.requestID = requestID
        ready = false
    }

    mutating func reset() {
        requestID = nil
        ready = false
    }

    /// Returns true once, so stream chunks do not repeatedly reschedule pending requests.
    mutating func receiveChunk(requestID: Int?) -> Bool {
        guard let requestID, requestID == self.requestID, !ready else { return false }
        ready = true
        return true
    }

    func allowsRequest(requiresSubscription: Bool) -> Bool {
        !requiresSubscription || ready
    }
}
