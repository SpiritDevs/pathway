import Foundation
import Testing
@testable import Pathway

@MainActor
struct PathwayThreadSubscriptionLifetimeTests {
    @Test func browserKeepsTheSubscriptionUntilItsDestinationDisappears() async {
        var starts = 0
        var stops = 0
        let lifetime = PathwayThreadSubscriptionLifetime(start: { starts += 1 }, stop: { stops += 1 })
        lifetime.retain(.conversation)
        lifetime.retain(.browser)
        lifetime.release(.conversation)
        #expect(starts == 1)
        #expect(stops == 0)
        #expect(lifetime.pendingStop == nil)
        lifetime.release(.browser)
        await lifetime.pendingStop?.value
        #expect(stops == 1)
    }

    @Test func returningFromTheBrowserHandsOwnershipBackWithoutDisconnecting() async {
        var starts = 0
        var stops = 0
        let lifetime = PathwayThreadSubscriptionLifetime(start: { starts += 1 }, stop: { stops += 1 })
        lifetime.retain(.browser)
        lifetime.release(.browser)
        lifetime.retain(.conversation)
        await lifetime.pendingStop?.value
        #expect(starts == 1)
        #expect(stops == 0)
        lifetime.release(.conversation)
        await lifetime.pendingStop?.value
        #expect(stops == 1)
    }

    @Test func reappearingDuringShutdownWaitsBeforeRestarting() async {
        var starts = 0
        let started = AsyncStream<Void>.makeStream()
        var finishStop: CheckedContinuation<Void, Never>?
        let lifetime = PathwayThreadSubscriptionLifetime(start: { starts += 1 }, stop: {
            await withCheckedContinuation { continuation in
                finishStop = continuation
                started.continuation.yield(())
            }
        })
        lifetime.retain(.browser)
        lifetime.release(.browser)
        var events = started.stream.makeAsyncIterator()
        _ = await events.next()
        lifetime.retain(.conversation)
        #expect(starts == 1)
        finishStop?.resume()
        await lifetime.pendingStop?.value
        #expect(starts == 2)
        lifetime.release(.conversation)
        _ = await events.next()
        finishStop?.resume()
        await lifetime.pendingStop?.value
        started.continuation.finish()
    }

    @Test func discardingAnActiveNavigationStackStopsItsSubscription() async {
        let stopped = AsyncStream<Void>.makeStream()
        var lifetime: PathwayThreadSubscriptionLifetime? = PathwayThreadSubscriptionLifetime(start: {}, stop: { stopped.continuation.yield(()) })
        lifetime?.retain(.browser)
        lifetime = nil
        var events = stopped.stream.makeAsyncIterator()
        _ = await events.next()
        stopped.continuation.finish()
    }
    @Test func queuePromotionRestartsOnlyWhileAnOwnerRemains() async {
        var starts = 0
        var stops = 0
        let lifetime = PathwayThreadSubscriptionLifetime(start: { starts += 1 }, stop: { stops += 1 })
        lifetime.retain(.conversation)
        lifetime.restart()
        lifetime.restart()
        await lifetime.pendingStop?.value
        #expect(starts == 2)
        #expect(stops == 1)
        lifetime.restart()
        lifetime.release(.conversation)
        await lifetime.pendingStop?.value
        #expect(starts == 2)
        #expect(stops == 2)
    }

}
