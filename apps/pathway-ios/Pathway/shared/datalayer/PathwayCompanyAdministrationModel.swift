import Foundation
import Observation

typealias PathwayCompanyAdministrationRequest = @MainActor (String, String, [String: JSONValue]) async throws -> JSONValue
typealias PathwayCompanyAdministrationEntities = @MainActor (String, String) -> [JSONValue]

struct PathwayCompanyAdminMember: Decodable, Identifiable {
    let id: String
    let displayName: String
    let email: String
    let state: String
    let isOwner: Bool
    let teamIds: [String]
}
struct PathwayCompanyAdminTeam: Decodable, Identifiable {
    let id: String
    let name: String
    let description: String
    let memberCount: Int
    let archivedAt: Double?
}
struct PathwayCompanyAdminRole: Decodable, Identifiable {
    let id: String
    let name: String
    let description: String
    let permissions: [String]
    let seeded: Bool
}
struct PathwayCompanyAdminAssignment: Decodable, Identifiable {
    let id: String
    let membershipId: String
    let roleId: String
    let scope: Scope
    struct Scope: Decodable { let kind: String; let teamId: String? }
}
struct PathwayCompanyAdminInvitation: Decodable, Identifiable {
    let id: String
    let email: String
    let state: String
    let expiresAt: Double
    let lastDeliveryAt: Double?
    let teamIds: [String]
    let roleIds: [String]
    var canResend: Bool { state != "accepted" && state != "revoked" && Date().timeIntervalSince1970 * 1000 - (lastDeliveryAt ?? 0) >= 60_000 }
}

/// Company administrative grants never flow from a team-scoped assignment.
enum PathwayCompanyAdministrationPermissions {
    static func companyPermissions(membershipID: String, roles: [PathwayCompanyAdminRole], assignments: [PathwayCompanyAdminAssignment]) -> Set<String>? {
        let mine = assignments.filter { $0.membershipId == membershipID && $0.scope.kind == "company" }
        let byID = Dictionary(uniqueKeysWithValues: roles.map { ($0.id, $0) })
        guard mine.allSatisfy({ byID[$0.roleId] != nil }) else { return nil }
        return Set(mine.flatMap { byID[$0.roleId]?.permissions ?? [] })
    }
    static func isLastActiveOwner(_ member: PathwayCompanyAdminMember, members: [PathwayCompanyAdminMember]) -> Bool {
        member.isOwner && member.state == "active" && members.filter { $0.isOwner && $0.state == "active" }.count <= 1
    }
}

@MainActor @Observable
final class PathwayCompanyAdministrationModel {
    var company: PathwayCompany
    private let request: PathwayCompanyAdministrationRequest
    private let entities: PathwayCompanyAdministrationEntities
    var members: [PathwayCompanyAdminMember] = []
    var teams: [PathwayCompanyAdminTeam] = []
    var roles: [PathwayCompanyAdminRole] = []
    var invitations: [PathwayCompanyAdminInvitation] = []
    var permissionCatalog: [String] = []
    var errors: [String] = []
    var notice: String?
    var busy = false
    private var rolesLoaded = false

    init(company: PathwayCompany, request: @escaping PathwayCompanyAdministrationRequest, entities: @escaping PathwayCompanyAdministrationEntities) {
        self.company = company; self.request = request; self.entities = entities
    }
    var isOrganization: Bool { company.workspaceKind == "organization" }
    var assignments: [PathwayCompanyAdminAssignment] {
        entities("roleAssignment", company.id).compactMap { value in
            guard let data = try? JSONEncoder().encode(value) else { return nil }
            return try? JSONDecoder().decode(PathwayCompanyAdminAssignment.self, from: data)
        }
    }
    var offlineDays: Int? {
        entities("companySettings", company.id).first?.objectValue?["offlineAccessDays"]?.intValue
            ?? entities("company", company.id).first?.objectValue?["offlineAccessDays"]?.intValue
    }
    func allows(_ permission: String) -> Bool {
        if company.isOwner { return true }
        guard rolesLoaded, let permissions = PathwayCompanyAdministrationPermissions.companyPermissions(membershipID: company.membershipId, roles: roles, assignments: assignments) else { return false }
        return permissions.contains(permission)
    }
    func load() async {
        guard !busy else { return }; busy = true; defer { busy = false }
        errors = []
        do { roles = try await query("roles:list"); rolesLoaded = true } catch { errors.append(error.localizedDescription) }
        do { members = try await query("memberships:list") } catch { errors.append(error.localizedDescription) }
        do { teams = try await query("teams:list") } catch { errors.append(error.localizedDescription) }
        do { invitations = try await query("invitations:list") } catch { errors.append(error.localizedDescription) }
        do {
            let result = try await request("query", "roles:availablePermissions", [:])
            permissionCatalog = try JSONDecoder().decode([String].self, from: JSONEncoder().encode(result))
        } catch { errors.append(error.localizedDescription) }
    }
    func mutate(_ method: String, fields: [String: JSONValue] = [:], kind: String = "mutation", reload: Bool = true) async -> Bool {
        guard !busy else { return false }; busy = true; errors = []; notice = nil
        do {
            var payload = fields; payload["companyId"] = .string(company.id)
            _ = try await request(kind, method, payload)
            busy = false; notice = "Saved"
            if reload { await load() }
            return true
        } catch { busy = false; errors = [error.localizedDescription]; return false }
    }
    private func query<T: Decodable>(_ method: String) async throws -> T {
        let result = try await request("query", method, ["companyId": .string(company.id)])
        return try JSONDecoder().decode(T.self, from: JSONEncoder().encode(result))
    }
}
