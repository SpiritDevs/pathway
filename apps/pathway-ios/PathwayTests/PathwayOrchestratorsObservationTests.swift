import Foundation
import Testing
@testable import Pathway

@MainActor
struct PathwayOrchestratorsObservationTests {
    @Test func conversationStreamsUpdateAndMarkMessagesRead() async {
        var subscribed = Set<String>()
        var readSequence: JSONValue?
        let model = PathwayOrchestratorsModel(request: { kind, name, args in
            #expect(kind == "mutation")
            #expect(name == "aiOrchestrators:markRead")
            readSequence = args.objectValue?["sequence"]
            return .null
        }, subscribe: { name, args in
            subscribed.insert(name)
            #expect(args.objectValue?["chatId"] == .string("chat"))
            return AsyncThrowingStream {
                let records = JSONValue.array([.object(["id": .string(name), "sequence": .number(7)])])
                $0.yield(name == "aiOrchestrators:messages"
                    ? .object(["messages": records, "nextBefore": .number(3)]) : records)
                $0.finish()
            }
        })
        await model.observeConversation("chat")
        #expect(subscribed == ["aiOrchestrators:messages", "aiOrchestrators:work", "aiOrchestrators:activity"])
        #expect(model.messages["chat"]?.first?.id == "aiOrchestrators:messages")
        #expect(model.work["chat"]?.first?.id == "aiOrchestrators:work")
        #expect(model.activity["chat"]?.first?.id == "aiOrchestrators:activity")
        #expect(model.nextBefore["chat"] == 3)
        #expect(readSequence == .number(7))
        #expect(model.visibleConversationID == nil)
    }

    @Test(arguments: [false, true]) func cancellationAndAccountResetDiscardLateValues(resetAccount: Bool) async {
        let ready = AsyncStream<Void>.makeStream()
        let terminated = AsyncStream<Void>.makeStream()
        var streams: [AsyncThrowingStream<JSONValue, Error>.Continuation] = []
        let model = PathwayOrchestratorsModel(request: { _, _, _ in
            Issue.record("Stale messages must not be marked read")
            return .null
        }, subscribe: { _, _ in
            let stream = AsyncThrowingStream<JSONValue, Error>.makeStream()
            stream.continuation.onTermination = { _ in terminated.continuation.yield(()) }
            streams.append(stream.continuation)
            if streams.count == 3 { ready.continuation.yield(()) }
            return stream.stream
        })
        let observation = Task { await model.observeConversation("chat") }
        var starts = ready.stream.makeAsyncIterator()
        _ = await starts.next()
        #expect(model.visibleConversationID == "chat")
        if resetAccount { model.stop(clear: true) }
        else { observation.cancel() }
        for stream in streams {
            stream.yield(.object(["messages": .array([.object(["id": .string("stale"), "sequence": .number(9)])])]))
            if resetAccount { stream.finish() }
        }
        await observation.value
        var ends = terminated.stream.makeAsyncIterator()
        for _ in 0..<3 { _ = await ends.next() }
        #expect(model.messages.isEmpty)
        #expect(model.work.isEmpty)
        #expect(model.activity.isEmpty)
        #expect(model.errorMessage == nil)
        #expect(model.visibleConversationID == nil)
        ready.continuation.finish()
        terminated.continuation.finish()
    }
}
