import Foundation
@testable import Pathway
import Testing

@MainActor
struct PathwayCompanyAdministrationTests {
    @Test func teamAssignmentsNeverGrantCompanyAdministration() throws {
        let role = try JSONDecoder().decode(PathwayCompanyAdminRole.self, from: Data(#"{"id":"admin","name":"Admin","description":"","permissions":["members.manage","roles.manage"],"seeded":true}"#.utf8))
        let teamGrant = try JSONDecoder().decode(PathwayCompanyAdminAssignment.self, from: Data(#"{"id":"a","membershipId":"me","roleId":"admin","scope":{"kind":"team","teamId":"team"}}"#.utf8))
        let companyGrant = try JSONDecoder().decode(PathwayCompanyAdminAssignment.self, from: Data(#"{"id":"b","membershipId":"me","roleId":"admin","scope":{"kind":"company"}}"#.utf8))
        #expect(PathwayCompanyAdministrationPermissions.companyPermissions(membershipID: "me", roles: [role], assignments: [teamGrant]) == [])
        #expect(PathwayCompanyAdministrationPermissions.companyPermissions(membershipID: "me", roles: [role], assignments: [companyGrant]) == ["members.manage", "roles.manage"])
        #expect(PathwayCompanyAdministrationPermissions.companyPermissions(membershipID: "someone-else", roles: [role], assignments: [companyGrant]) == [])
        #expect(PathwayCompanyAdministrationPermissions.companyPermissions(membershipID: "me", roles: [], assignments: [companyGrant]) == nil)
    }

    @Test func protectsTheLastActiveOwnerButDoesNotCountLockedOwners() throws {
        let owner = try JSONDecoder().decode(PathwayCompanyAdminMember.self, from: Data(#"{"id":"owner","displayName":"Owner","email":"owner@example.com","state":"active","isOwner":true,"teamIds":[]}"#.utf8))
        let locked = try JSONDecoder().decode(PathwayCompanyAdminMember.self, from: Data(#"{"id":"locked","displayName":"Locked","email":"locked@example.com","state":"locked","isOwner":true,"teamIds":[]}"#.utf8))
        #expect(PathwayCompanyAdministrationPermissions.isLastActiveOwner(owner, members: [owner, locked]))
        #expect(!PathwayCompanyAdministrationPermissions.isLastActiveOwner(locked, members: [owner, locked]))
    }

    @Test func mutationsAreBoundToTheirSelectedCompany() async {
        let company = PathwayCompany(id: "company-a", membershipId: "me", name: "A", workspaceKind: "organization", issueKeyPrefix: "A", lifecycleState: "active", syncVersion: 0, isOwner: true)
        var captured: [String: JSONValue] = [:]
        let model = PathwayCompanyAdministrationModel(company: company, request: { kind, name, fields in
            #expect(kind == "mutation")
            #expect(name == "companies:rename")
            captured = fields
            return .null
        }, entities: { _, _ in [] })
        let success = await model.mutate("companies:rename", fields: ["companyId": .string("wrong-company"), "name": .string("Renamed")], reload: false)
        #expect(success)
        #expect(captured["companyId"] == .string("company-a"))
    }
}
