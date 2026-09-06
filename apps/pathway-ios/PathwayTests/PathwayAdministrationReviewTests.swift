import Foundation
@testable import Pathway
import Testing

@MainActor
struct PathwayAdministrationReviewTests {
    private func company(owner: Bool = false) -> PathwayCompany {
        .init(id: "company", membershipId: "me", name: "Company", workspaceKind: "organization", issueKeyPrefix: "C", lifecycleState: "active", syncVersion: 1, isOwner: owner)
    }
    private var role: JSONValue {
        .object(["id": .string("manager"), "name": .string("Manager"), "description": .string(""), "permissions": .array([.string("company.manage")]), "seeded": .bool(false)])
    }
    private func assignment(scope: String = "company", member: String = "me") -> JSONValue {
        .object(["id": .string("grant"), "membershipId": .string(member), "roleId": .string("manager"), "scope": .object(["kind": .string(scope), "teamId": .string("team")])])
    }
    @Test func selfRoleAllowsAdministrationWithoutPrivilegedRoleListing() async {
        let replica = AdministrationReplicaFixture(["role": [role], "roleAssignment": [assignment()]])
        let model = PathwayCompanyAdministrationModel(company: company(), request: { _, method, _ in
            if method == "roles:list" { throw PathwayRPCError.remote("roles.read required") }
            return .array([])
        }, entities: { kind, companyID in
            #expect(companyID == "company")
            return replica.entities[kind] ?? []
        })
        #expect(model.allows("company.manage"))
        #expect(!model.allows("roles.read"))
        await model.load()
        #expect(model.roles.isEmpty)
        #expect(model.allows("company.manage"))
        replica.entities["role"] = []
        #expect(!model.allows("company.manage"))
        replica.entities["role"] = [role]
        replica.entities["roleAssignment"] = [assignment(scope: "team")]
        #expect(!model.allows("company.manage"))
        replica.entities["roleAssignment"] = [assignment(member: "someone-else")]
        #expect(!model.allows("company.manage"))
    }
    @Test func lastActiveOwnerCannotLeaveOrDispatchTheMutation() async {
        var writes = 0
        let model = PathwayCompanyAdministrationModel(company: company(owner: true), request: { _, _, _ in writes += 1; return .null }, entities: { _, _ in [] })
        let me = PathwayCompanyAdminMember(id: "me", displayName: "Me", email: "", state: "active", isOwner: true, teamIds: [])
        let locked = PathwayCompanyAdminMember(id: "other", displayName: "Other", email: "", state: "locked", isOwner: true, teamIds: [])
        #expect(!model.canLeave)
        model.members = [me, locked]
        #expect(!model.canLeave)
        #expect(await model.mutate("memberships:leave", reload: false) == false)
        #expect(writes == 0)
        model.members = [me, .init(id: "other", displayName: "Other", email: "", state: "active", isOwner: true, teamIds: [])]
        #expect(model.canLeave)
        #expect(await model.mutate("memberships:leave", reload: false))
        #expect(writes == 1)
        let nonOwner = PathwayCompanyAdministrationModel(company: company(), request: { _, _, _ in .null }, entities: { _, _ in [] })
        #expect(nonOwner.canLeave)
    }
    @Test func editingRootlessProjectsOmitsDirectoryChangesUntilOneIsChosen() {
        #expect(PathwayAdministrationProjectDirectory.canSave(root: "", isNew: false, existingRoot: nil))
        #expect(PathwayAdministrationProjectDirectory.fields(root: " \n", createDirectory: true).isEmpty)
        #expect(PathwayAdministrationProjectDirectory.fields(root: "/chosen", createDirectory: true) == ["workspaceRoot": .string("/chosen"), "createWorkspaceRootIfMissing": .bool(true)])
        #expect(!PathwayAdministrationProjectDirectory.canSave(root: "", isNew: true, existingRoot: nil))
        #expect(!PathwayAdministrationProjectDirectory.canSave(root: "", isNew: false, existingRoot: "/existing"))
        #expect(PathwayAdministrationProjectDirectory.canSave(root: "/chosen", isNew: false, existingRoot: nil))
    }
}

@MainActor
private final class AdministrationReplicaFixture {
    var entities: [String: [JSONValue]]
    init(_ entities: [String: [JSONValue]]) { self.entities = entities }
}
