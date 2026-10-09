import Foundation
import Observation
import Testing
@testable import Pathway

@MainActor struct PathwayOrchestratorAvatarTests {
    @Test func personalAvatarReceivesLiveAppearanceUpdatesAndClearsOnAccountChange() async {
        let updates = AsyncThrowingStream<JSONValue, Error>.makeStream()
        let subscribed = AsyncStream<Void>.makeStream()
        let model = PathwayOrchestratorsModel(
            request: { _, _, _ in .null },
            subscribe: { name, _ in
                if name == "aiOrchestrators:list" {
                    subscribed.continuation.yield(())
                    return updates.stream
                }
                return AsyncThrowingStream { $0.yield(.array([])) }
            }
        )
        defer { model.stop(clear: true) }
        model.start(accountID: "owner", companyIDs: [])
        var subscriptions = subscribed.stream.makeAsyncIterator()
        _ = await subscriptions.next()

        let original = contact(color: "blue", shape: "round", eyes: "oval")
        await receive(.array([.object(original.fields)]), in: model, through: updates.continuation)
        #expect(model.personalContact == original)

        let edited = contact(color: "pink", shape: "flower", eyes: "wide")
        await receive(.array([.object(edited.fields)]), in: model, through: updates.continuation)
        #expect(model.personalContact == edited)
        #expect(model.personalContact?.configuration["avatar"] == edited.fields["avatar"])
        #expect(model.personalContact?.configuration["personality"] == edited.fields["personality"])

        model.start(accountID: "other-owner", companyIDs: [])
        #expect(model.personalContact == nil)
    }

    @Test func phoneSettingsPreserveSavedAppearanceAndPersonality() {
        let record = contact(color: "cyan", shape: "pebble", eyes: "soft")
        var editedSettings = record.configuration
        editedSettings["name"] = .string("New name")
        #expect(editedSettings["color"] == record.fields["color"])
        #expect(editedSettings["avatar"] == record.fields["avatar"])
        #expect(editedSettings["personality"] == record.fields["personality"])
        #expect(editedSettings["ownerSubject"] == nil)
    }

    @Test func conversationAvatarsIncludeSharedBotsAndFollowLiveEditsInParticipantOrder() async {
        let updates = AsyncThrowingStream<JSONValue, Error>.makeStream()
        let subscribed = AsyncStream<Void>.makeStream()
        let model = PathwayOrchestratorsModel(
            request: { _, _, _ in .null },
            subscribe: { name, _ in
                if name == "aiOrchestrators:conversationAvatars" {
                    subscribed.continuation.yield(())
                    return updates.stream
                }
                return AsyncThrowingStream { $0.yield(.array([])) }
            }
        )
        defer { model.stop(clear: true) }
        model.start(accountID: "owner", companyIDs: [])
        var subscriptions = subscribed.stream.makeAsyncIterator()
        _ = await subscriptions.next()
        let chat = PathwayOrchestratorRecord(id: "group", fields: [
            "orchestratorIds": .array([.string("personal"), .string("shared-bot")])
        ])
        let personal = contact(color: "blue", shape: "round", eyes: "oval")
        var bot = contact(color: "amber", shape: "round", eyes: "oval").fields
        bot["id"] = .string("shared-bot")
        bot.removeValue(forKey: "ownerSubject")
        bot.removeValue(forKey: "kind")
        await receiveAvatars([bot, personal.fields], in: model, through: updates.continuation)
        #expect(model.contacts.isEmpty)
        #expect(model.avatarContacts(for: chat).map(\.id) == ["personal", "shared-bot"])
        #expect(model.avatarContacts(for: chat).map { $0.string("color") } == ["blue", "amber"])

        bot["color"] = .string("pink")
        bot["avatar"] = .object(["shape": .string("flower"), "eyes": .string("wide")])
        await receiveAvatars([personal.fields, bot], in: model, through: updates.continuation)
        #expect(model.avatarContacts(for: chat).last?.fields["avatar"] == bot["avatar"])
        #expect(model.avatarContacts(for: chat).last?.string("color") == "pink")

        model.start(accountID: "other-owner", companyIDs: [])
        #expect(model.avatarContacts(for: chat).isEmpty)
    }

    private func receiveAvatars(
        _ fields: [[String: JSONValue]],
        in model: PathwayOrchestratorsModel,
        through continuation: AsyncThrowingStream<JSONValue, Error>.Continuation
    ) async {
        await withCheckedContinuation { receipt in
            withObservationTracking {
                _ = model.conversationAvatars
            } onChange: {
                receipt.resume()
            }
            continuation.yield(.array(fields.map(JSONValue.object)))
        }
    }

    private func receive(
        _ value: JSONValue,
        in model: PathwayOrchestratorsModel,
        through continuation: AsyncThrowingStream<JSONValue, Error>.Continuation
    ) async {
        await withCheckedContinuation { receipt in
            withObservationTracking {
                _ = model.personalContact
            } onChange: {
                receipt.resume()
            }
            continuation.yield(value)
        }
    }

    private func contact(color: String, shape: String, eyes: String) -> PathwayOrchestratorRecord {
        .init(id: "personal", fields: [
            "id": .string("personal"), "name": .string("Robin"), "ownerSubject": .string("owner"),
            "kind": .string("personal"), "status": .string("active"), "createdAt": .number(1),
            "companyId": .null, "shared": .bool(false), "color": .string(color),
            "avatar": .object(["shape": .string(shape), "eyes": .string(eyes)]),
            "personality": .object([
                "shared": .object(["energy": .number(25), "curiosity": .number(45)]),
                "avatar": .object(["energy": .number(70)])
            ])
        ])
    }
}
