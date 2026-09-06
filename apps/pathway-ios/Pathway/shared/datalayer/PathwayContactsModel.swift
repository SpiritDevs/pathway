import Foundation
import Observation

struct PathwayContact: Codable, Identifiable, Equatable {
    var id: String
    var name: String
    var role: String
    var company: String
    var email: String
    var phone: String
    var notes: String
    var favorite: Bool
    var createdAt: String
    var revision: Int
    static func draft() -> Self { .init(id: UUID().uuidString.lowercased(), name: "", role: "", company: "", email: "", phone: "", notes: "", favorite: false, createdAt: "", revision: 0) }
}

private struct PathwayContactPage: Decodable {
    let contacts: [PathwayContact]
    let cursor: String?
    let isDone: Bool
}

@MainActor @Observable
final class PathwayContactsModel {
    typealias Subscribe = @MainActor (String, JSONValue) -> AsyncThrowingStream<JSONValue, Error>
    private(set) var contacts: [PathwayContact] = []
    private(set) var companyID = ""
    private(set) var loading = false
    private(set) var writing = false
    private(set) var loadingMore = false
    private(set) var hasMore = false
    @ObservationIgnored private var firstPage: PathwayContactPage?
    @ObservationIgnored private var cursor: String?
    @ObservationIgnored private var pageGeneration = 0
    @ObservationIgnored private var search = ""
    @ObservationIgnored private var searchField = "name"
    @ObservationIgnored private var favoritesOnly = false
    var errorMessage: String?
    @ObservationIgnored private var observationGeneration = 0
    @ObservationIgnored private let request: PathwayIssuesModel.CloudRequest
    @ObservationIgnored private let subscribe: Subscribe
    init(request: @escaping PathwayIssuesModel.CloudRequest, subscribe: @escaping Subscribe) { self.request = request; self.subscribe = subscribe }
    static func canManage(companyID: String, companies: [PathwayCompany], entities: [PathwayIssueEntity]) -> Bool {
        guard let company = companies.first(where: { $0.id == companyID }),
              entities.contains(where: { $0.companyId == companyID && $0.kind == "membership" && $0.id == company.membershipId && $0.string("state") == "active" }) else { return false }
        if company.isOwner { return true }
        let roles = entities.filter { $0.companyId == companyID && $0.kind == "role" }
        return entities.contains { assignment in
            assignment.companyId == companyID && assignment.kind == "roleAssignment"
                && assignment.string("membershipId") == company.membershipId
                && assignment.fields["scope"]?.objectValue?["kind"] == .string("company")
                && roles.contains { role in
                    role.id == assignment.string("roleId")
                        && role.fields["permissions"]?.arrayValue?.contains(.string("projects.manage")) == true
                }
        }
    }

    func clear() {
        observationGeneration += 1; firstPage = nil; pageGeneration += 1; cursor = nil; hasMore = false; loadingMore = false; companyID = ""; contacts = []; loading = false; writing = false; errorMessage = nil
    }
    func observe(companyID: String, search: String = "", searchField: String = "name", favoritesOnly: Bool = false) async {
        observationGeneration += 1; let generation = observationGeneration
        self.companyID = companyID; self.search = search; self.searchField = searchField; self.favoritesOnly = favoritesOnly
        contacts = []; firstPage = nil; errorMessage = nil; loading = false; pageGeneration += 1; cursor = nil; hasMore = false; loadingMore = false
        guard !companyID.isEmpty else { return }
        loading = true
        do {
            for try await value in subscribe("contacts:list", listArguments()) {
                guard !Task.isCancelled, self.companyID == companyID, generation == observationGeneration else { return }
                let page = try decodePathwayPayload(PathwayContactPage.self, from: value)
                firstPage = page; contacts = page.contacts; cursor = page.cursor; hasMore = !page.isDone; loading = false; loadingMore = false; pageGeneration += 1
            }
        } catch {
            guard !Task.isCancelled, self.companyID == companyID, generation == observationGeneration else { return }
            contacts = []; firstPage = nil; errorMessage = error.localizedDescription; loading = false; loadingMore = false; hasMore = false; cursor = nil; pageGeneration += 1
        }
    }
    private func listArguments(cursor: String? = nil) -> JSONValue {
        var args: [String: JSONValue] = ["companyId": .string(companyID), "search": .string(search), "searchField": .string(searchField), "favoritesOnly": .bool(favoritesOnly)]
        if let cursor { args["cursor"] = .string(cursor) }
        return .object(args)
    }
    func loadMore() async throws {
        guard !loadingMore, hasMore, let cursor, !companyID.isEmpty else { return }
        let generation = observationGeneration, pageVersion = pageGeneration
        loadingMore = true
        defer { if generation == observationGeneration, pageVersion == pageGeneration { loadingMore = false } }
        let value: JSONValue
        do { value = try await request("query", "contacts:list", listArguments(cursor: cursor)) }
        catch {
            guard !Task.isCancelled, generation == observationGeneration, pageVersion == pageGeneration else { return }
            throw error
        }
        guard !Task.isCancelled, generation == observationGeneration, pageVersion == pageGeneration else { return }
        let page = try decodePathwayPayload(PathwayContactPage.self, from: value)
        let ids = Set(contacts.map(\.id))
        contacts += page.contacts.filter { !ids.contains($0.id) }
        self.cursor = page.cursor; hasMore = !page.isDone
    }
    func observeContact(companyID: String, contactID: String, receive: @MainActor (PathwayContact?) -> Void) async throws {
        for try await value in subscribe("contacts:get", .object(["companyId": .string(companyID), "id": .string(contactID)])) {
            guard !Task.isCancelled else { return }
            receive(try decodePathwayPayload(PathwayContact?.self, from: value))
        }
    }
    func save(_ contact: PathwayContact, companyID: String, requestID: String) async throws {
        var fields: [String: JSONValue] = ["companyId": .string(companyID), "id": .string(contact.id), "requestId": .string(requestID), "expectedRevision": contact.revision == 0 ? .null : .number(Double(contact.revision))]
        fields.merge(["name": .string(contact.name), "role": .string(contact.role), "company": .string(contact.company), "email": .string(contact.email), "phone": .string(contact.phone), "notes": .string(contact.notes), "favorite": .bool(contact.favorite)]) { _, new in new }
        let generation = observationGeneration
        _ = try await request("mutation", "contacts:upsert", .object(fields))
        guard generation == observationGeneration, self.companyID == companyID, let firstPage else { return }
        pageGeneration += 1; loadingMore = false
        contacts = firstPage.contacts; cursor = firstPage.cursor; hasMore = !firstPage.isDone
    }
    func remove(_ contact: PathwayContact, companyID: String) async throws {
        let generation = observationGeneration
        _ = try await request("mutation", "contacts:remove", .object(["companyId": .string(companyID), "id": .string(contact.id), "expectedRevision": .number(Double(contact.revision))]))
        guard generation == observationGeneration else { return }
        contacts.removeAll { $0.id == contact.id }
        if let firstPage {
            self.firstPage = .init(contacts: firstPage.contacts.filter { $0.id != contact.id }, cursor: firstPage.cursor, isDone: firstPage.isDone)
        }
    }
    @discardableResult func perform(_ operation: () async throws -> Void) async -> Bool {
        guard !writing else { return false }
        writing = true; errorMessage = nil
        defer { writing = false }
        do { try await operation(); return true } catch { errorMessage = error.localizedDescription; return false }
    }
}
