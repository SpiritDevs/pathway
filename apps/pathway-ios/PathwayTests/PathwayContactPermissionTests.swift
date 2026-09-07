import Foundation
@testable import Pathway
import Testing

@MainActor
struct PathwayContactPermissionTests {
    private func company(owner: Bool = false, id: String = "company-a") -> PathwayCompany {
        .init(id: id, membershipId: "me", name: "Company", workspaceKind: "organization", issueKeyPrefix: "A", lifecycleState: "active", syncVersion: 1, isOwner: owner)
    }
    private func member(state: String = "active", companyID: String = "company-a", id: String = "me") -> PathwayIssueEntity {
        .init(companyId: companyID, kind: "membership", fields: ["id": .string(id), "state": .string(state)])
    }
    private func role(companyID: String = "company-a", permission: String = "projects.manage") -> PathwayIssueEntity {
        .init(companyId: companyID, kind: "role", fields: ["id": .string("role"), "permissions": .array([.string(permission)])])
    }
    private func grant(companyID: String = "company-a", membershipID: String = "me", scope: String = "company") -> PathwayIssueEntity {
        .init(companyId: companyID, kind: "roleAssignment", fields: ["id": .string("grant"), "membershipId": .string(membershipID), "roleId": .string("role"), "scope": .object(["kind": .string(scope), "teamId": .string("team")])])
    }
    private func allowed(owner: Bool = false, _ entities: [PathwayIssueEntity]) -> Bool {
        PathwayContactsModel.canManage(companyID: "company-a", companies: [company(owner: owner)], entities: entities)
    }

    @Test func activeOwnersAndCompanyContactManagersCanWrite() {
        #expect(allowed(owner: true, [member()]))
        #expect(allowed([member(), role(), grant()]))
        #expect(!allowed([member()]))
        #expect(!allowed([member(), role(permission: "issues.update"), grant()]))
    }

    @Test func teamGrantsAndOtherMembersGrantsDoNotAllowContactWrites() {
        #expect(!allowed([member(), role(), grant(scope: "team")]))
        #expect(!allowed([member(), role(), grant(membershipID: "someone-else")]))
    }

    @Test func inactiveOrMissingMembershipBlocksOwnersAndManagers() {
        for state in ["locked", "left"] {
            #expect(!allowed(owner: true, [member(state: state)]))
            #expect(!allowed([member(state: state), role(), grant()]))
        }
        #expect(!allowed(owner: true, []))
        #expect(!allowed([role(), grant()]))
        #expect(!allowed([member(id: "someone-else"), role(), grant()]))
    }

    @Test func missingCompanyOrRoleDataDoesNotGrantWriteAccess() {
        #expect(!PathwayContactsModel.canManage(companyID: "company-a", companies: [], entities: [member(), role(), grant()]))
        #expect(!allowed([member(), grant()]))
    }

    @Test func anotherCompanyCannotSupplyOwnersMembershipsRolesOrAssignments() {
        #expect(!PathwayContactsModel.canManage(companyID: "company-a", companies: [company(owner: true, id: "company-b")], entities: [member()]))
        #expect(!allowed(owner: true, [member(companyID: "company-b")]))
        #expect(!allowed([member(), role(companyID: "company-b"), grant()]))
        #expect(!allowed([member(), role(), grant(companyID: "company-b")]))
    }
}
