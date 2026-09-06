import Foundation
@testable import Pathway
import Testing

@MainActor
struct PathwayCompanyAdministrationTests {
    @Test func archivedTeamsAndInactiveMembersCanRemoveExistingMemberships() {
        let archived = PathwayCompanyAdminTeam(id: "team", name: "Team", description: "", memberCount: 1, archivedAt: 1)
        let activeTeam = PathwayCompanyAdminTeam(id: "team", name: "Team", description: "", memberCount: 1, archivedAt: nil)
        for state in ["active", "locked", "left"] {
            let existing = PathwayCompanyAdminMember(id: "member", displayName: "", email: "", state: state, isOwner: false, teamIds: ["team"])
            let unassigned = PathwayCompanyAdminMember(id: "member", displayName: "", email: "", state: state, isOwner: false, teamIds: [])
            #expect(existing.canChangeMembership(in: archived))
            #expect(existing.canChangeMembership(in: activeTeam))
            #expect(!unassigned.canChangeMembership(in: archived))
            #expect(unassigned.canChangeMembership(in: activeTeam) == (state == "active"))
        }
    }

    @Test func invitationResendBecomesAvailableAtTheDeliveryDeadline() {
        let delivery = 1_000_000.0
        let invitation = PathwayCompanyAdminInvitation(id: "invite", email: "", state: "pending", expiresAt: 0, lastDeliveryAt: delivery, teamIds: [], roleIds: [])
        let deadline = Date(timeIntervalSince1970: (delivery + 60_000) / 1000)
        #expect(invitation.resendAvailableAt == deadline)
        #expect(!invitation.canResend(at: deadline.addingTimeInterval(-0.001)))
        #expect(invitation.canResend(at: deadline))
        #expect(invitation.canResend(at: deadline.addingTimeInterval(1)))
        for state in ["accepted", "revoked"] {
            let unavailable = PathwayCompanyAdminInvitation(id: "invite", email: "", state: state, expiresAt: 0, lastDeliveryAt: nil, teamIds: [], roleIds: [])
            #expect(!unavailable.canResend(at: deadline))
        }
        let unsent = PathwayCompanyAdminInvitation(id: "invite", email: "", state: "pending", expiresAt: 0, lastDeliveryAt: nil, teamIds: [], roleIds: [])
        #expect(unsent.canResend(at: deadline))
    }

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
