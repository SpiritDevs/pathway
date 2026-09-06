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

@MainActor @Observable
final class PathwayContactsModel {
    typealias Subscribe = @MainActor (String, JSONValue) -> AsyncThrowingStream<JSONValue, Error>
    private(set) var contacts: [PathwayContact] = []
    private(set) var companyID = ""
    private(set) var loading = false
    private(set) var writing = false
    var errorMessage: String?
    @ObservationIgnored private var observationGeneration = 0
    @ObservationIgnored private let request: PathwayIssuesModel.CloudRequest
    @ObservationIgnored private let subscribe: Subscribe
    init(request: @escaping PathwayIssuesModel.CloudRequest, subscribe: @escaping Subscribe) { self.request = request; self.subscribe = subscribe }
    func clear() {
        observationGeneration += 1; companyID = ""; contacts = []; loading = false; writing = false; errorMessage = nil
    }
    func observe(companyID: String) async {
        observationGeneration += 1; let generation = observationGeneration
        self.companyID = companyID; contacts = []; errorMessage = nil
        guard !companyID.isEmpty else { return }
        loading = true
        do {
            for try await value in subscribe("contacts:list", .object(["companyId": .string(companyID)])) {
                guard !Task.isCancelled, self.companyID == companyID, generation == observationGeneration else { return }
                contacts = try decodePathwayPayload([PathwayContact].self, from: value); loading = false
            }
        } catch {
            guard !Task.isCancelled, self.companyID == companyID, generation == observationGeneration else { return }
            contacts = []; errorMessage = error.localizedDescription; loading = false
        }
    }
    func save(_ contact: PathwayContact, companyID: String, requestID: String) async throws {
        var fields: [String: JSONValue] = ["companyId": .string(companyID), "id": .string(contact.id), "requestId": .string(requestID), "expectedRevision": contact.revision == 0 ? .null : .number(Double(contact.revision))]
        fields.merge(["name": .string(contact.name), "role": .string(contact.role), "company": .string(contact.company), "email": .string(contact.email), "phone": .string(contact.phone), "notes": .string(contact.notes), "favorite": .bool(contact.favorite)]) { _, new in new }
        _ = try await request("mutation", "contacts:upsert", .object(fields))
    }
    func remove(_ contact: PathwayContact, companyID: String) async throws {
        _ = try await request("mutation", "contacts:remove", .object(["companyId": .string(companyID), "id": .string(contact.id), "expectedRevision": .number(Double(contact.revision))]))
    }
    @discardableResult func perform(_ operation: () async throws -> Void) async -> Bool {
        guard !writing else { return false }
        writing = true; errorMessage = nil
        defer { writing = false }
        do { try await operation(); return true } catch { errorMessage = error.localizedDescription; return false }
    }
}
