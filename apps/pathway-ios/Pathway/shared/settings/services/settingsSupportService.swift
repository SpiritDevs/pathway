@preconcurrency import ConvexMobile
import Foundation

struct SettingsSupportMessage: Decodable, Equatable, Identifiable, Sendable {
    let id: String
    let conversationId: String
    let parentMessageId: String?
    let type: String
    let ownerId: String
    let ownerType: String
    let content: String
    let attachmentIds: [String]
    let tagIds: [String]
    let ticketId: String?
    let createdAt: Double
    let modifiedAt: Double?
    let sentAt: Double?
    let deliveryStatusByUser: [String: String]?
    let editedAt: Double?
    let deletedAt: Double?

    private enum CodingKeys: String, CodingKey {
        case id = "_id"
        case conversationId
        case parentMessageId
        case type
        case ownerId
        case ownerType
        case content
        case attachmentIds
        case tagIds
        case ticketId
        case createdAt
        case modifiedAt
        case sentAt
        case deliveryStatusByUser
        case editedAt
        case deletedAt
    }
}

struct SettingsSupportConversation: Decodable, Equatable, Identifiable, Sendable {
    let id: String
    let title: String
    let subject: String?
    let ownerId: String
    let companyId: String
    let userIds: [String]
    let adminIds: [String]
    let assignedAdminId: String?
    let lastActivity: Double
    let status: String
    let createdAt: Double
    let recentMessages: [SettingsSupportMessage]?

    private enum CodingKeys: String, CodingKey {
        case id = "_id"
        case title
        case subject
        case ownerId
        case companyId
        case userIds
        case adminIds
        case assignedAdminId
        case lastActivity
        case status
        case createdAt
        case recentMessages
    }
}

struct SettingsSupportTicket: Decodable, Equatable, Identifiable, Sendable {
    let id: String
    let conversationId: String?
    let title: String
    let description: String
    let ticketType: String
    let status: String
    let priority: String?
    let effortEstimate: String?
    let ownerId: String
    let companyId: String?
    let assignedToId: String?
    let dueDate: Double?
    let attachmentIds: [String]
    let createdAt: Double
    let updatedAt: Double

    private enum CodingKeys: String, CodingKey {
        case id = "_id"
        case conversationId
        case title
        case description
        case ticketType
        case status
        case priority
        case effortEstimate
        case ownerId
        case companyId
        case assignedToId
        case dueDate
        case attachmentIds
        case createdAt
        case updatedAt
    }
}

struct SettingsNewsPost: Decodable, Equatable, Identifiable, Sendable {
    let id: String
    let title: String
    let summary: String?
    let contentHtml: String
    let imageUrl: String?
    let category: String
    let publishedAt: Double
    let authorId: String?
    let linkUrl: String?
    let isPublished: Bool
    let createdAt: Double
    let updatedAt: Double

    private enum CodingKeys: String, CodingKey {
        case id = "_id"
        case title
        case summary
        case contentHtml
        case imageUrl
        case category
        case publishedAt
        case authorId
        case linkUrl
        case isPublished
        case createdAt
        case updatedAt
    }
}

@MainActor
protocol SettingsSupportServicing: AnyObject {
    func loadConversations(userID: String, now: Date, limit: Int) async throws
        -> [SettingsSupportConversation]
    func observeMessages(
        conversationID: String,
        now: Date,
        receiveValue: @MainActor @escaping ([SettingsSupportMessage]) -> Void
    ) async throws
    func startConversation(userID: String, companyID: String, message: String) async throws
        -> String
    func sendMessage(conversationID: String, userID: String, content: String) async throws
        -> String
    func markRead(conversationID: String, userID: String, messageIDs: [String]) async throws
    func loadTickets(userID: String, companyID: String, limit: Int) async throws
        -> [SettingsSupportTicket]
    func loadNews(now: Date, category: String?, limit: Int) async throws -> [SettingsNewsPost]
    func searchNews(_ query: String, now: Date, limit: Int) async throws -> [SettingsNewsPost]
}

@MainActor
final class SettingsSupportService: SettingsSupportServicing {
    private let transport: any SettingsRemoteTransporting

    init(transport: any SettingsRemoteTransporting) {
        self.transport = transport
    }

    convenience init(convex: ConvexClientWithAuth<PathwayAuthSession>) {
        self.init(transport: SettingsRemoteTransport(convex: convex))
    }

    func loadConversations(
        userID: String,
        now: Date = .now,
        limit: Int = 50
    ) async throws -> [SettingsSupportConversation] {
        let request = Self.conversationsRequest(
            userID: userID,
            now: now,
            limit: Self.boundedLimit(limit, maximum: 50)
        )
        return try await transport.queryOnce(request.function, arguments: request.arguments)
    }

    func observeMessages(
        conversationID: String,
        now: Date = .now,
        receiveValue: @MainActor @escaping ([SettingsSupportMessage]) -> Void
    ) async throws {
        let request = Self.messagesRequest(conversationID: conversationID, now: now)
        try await transport.observe(
            request.function,
            arguments: request.arguments,
            receiveValue: receiveValue
        )
    }

    func startConversation(
        userID: String,
        companyID: String,
        message: String
    ) async throws -> String {
        let request = Self.startConversationRequest(
            userID: userID,
            companyID: companyID,
            message: message
        )
        return try await transport.act(request.function, arguments: request.arguments)
    }

    func sendMessage(
        conversationID: String,
        userID: String,
        content: String
    ) async throws -> String {
        let request = Self.sendMessageRequest(
            conversationID: conversationID,
            userID: userID,
            content: content
        )
        return try await transport.act(request.function, arguments: request.arguments)
    }

    func markRead(
        conversationID: String,
        userID: String,
        messageIDs: [String]
    ) async throws {
        for batch in messageIDs.chunked(maximumCount: 100) {
            let request = Self.markReadRequest(
                conversationID: conversationID,
                userID: userID,
                messageIDs: batch
            )
            let _: String? = try await transport.mutate(
                request.function,
                arguments: request.arguments
            )
        }
    }

    func loadTickets(
        userID: String,
        companyID: String,
        limit: Int = 20
    ) async throws -> [SettingsSupportTicket] {
        let request = SettingsRemoteRequest(
            .query,
            "tickets:getTicketsByOwner",
            arguments: [
                "ownerId": userID,
                "companyId": companyID,
                "limit": Double(Self.boundedLimit(limit, maximum: 50))
            ]
        )
        return try await transport.queryOnce(request.function, arguments: request.arguments)
    }

    func loadNews(
        now: Date = .now,
        category: String? = nil,
        limit: Int = 20
    ) async throws -> [SettingsNewsPost] {
        var arguments: [String: ConvexEncodable?] = [
            "limit": Double(Self.boundedLimit(limit, maximum: 50)),
            "nowMs": now.timeIntervalSince1970 * 1_000
        ]
        if let category { arguments["category"] = category }
        return try await transport.queryOnce(
            "news:listPosts",
            arguments: arguments
        )
    }

    func searchNews(
        _ query: String,
        now: Date = .now,
        limit: Int = 20
    ) async throws -> [SettingsNewsPost] {
        try await transport.queryOnce(
            "news:searchPosts",
            arguments: [
                "query": query,
                "limit": Double(Self.boundedLimit(limit, maximum: 50)),
                "nowMs": now.timeIntervalSince1970 * 1_000
            ]
        )
    }

    static func conversationsRequest(
        userID: String,
        now: Date,
        limit: Int
    ) -> SettingsRemoteRequest {
        SettingsRemoteRequest(
            .query,
            "conversations:getConversations",
            arguments: [
                "adminId": userID,
                "filter": "byUser",
                "filterUserId": userID,
                "limit": Double(limit),
                "nowMs": now.timeIntervalSince1970 * 1_000
            ]
        )
    }

    static func messagesRequest(conversationID: String, now: Date) -> SettingsRemoteRequest {
        SettingsRemoteRequest(
            .query,
            "messages:getMessages",
            arguments: [
                "conversationId": conversationID,
                "limit": Double(100),
                "nowMs": now.timeIntervalSince1970 * 1_000
            ]
        )
    }

    static func startConversationRequest(
        userID: String,
        companyID: String,
        message: String
    ) -> SettingsRemoteRequest {
        SettingsRemoteRequest(
            .action,
            "conversations:createConversationWithMessage",
            arguments: [
                "ownerId": userID,
                "companyId": companyID,
                "content": message
            ]
        )
    }

    static func sendMessageRequest(
        conversationID: String,
        userID: String,
        content: String
    ) -> SettingsRemoteRequest {
        SettingsRemoteRequest(
            .action,
            "conversations:sendUserMessageWithSlackNotify",
            arguments: [
                "conversationId": conversationID,
                "ownerId": userID,
                "content": content,
                "acknowledgeUnread": true
            ]
        )
    }

    static func markReadRequest(
        conversationID: String,
        userID: String,
        messageIDs: [String]
    ) -> SettingsRemoteRequest {
        let ids: [ConvexEncodable?] = messageIDs.map { $0 as ConvexEncodable }
        return SettingsRemoteRequest(
            .mutation,
            "messages:markMessagesRead",
            arguments: [
                "conversationId": conversationID,
                "userId": userID,
                "messageIds": ids
            ]
        )
    }

    private static func boundedLimit(_ value: Int, maximum: Int) -> Int {
        min(max(value, 1), maximum)
    }
}

private extension Array {
    func chunked(maximumCount: Int) -> [[Element]] {
        guard maximumCount > 0, !isEmpty else { return [] }
        return stride(from: 0, to: count, by: maximumCount).map { start in
            Array(self[start..<Swift.min(start + maximumCount, count)])
        }
    }
}
