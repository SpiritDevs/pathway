//
//  PathwayTests.swift
//  PathwayTests
//
//  Created by Corey Baines on 20/11/2024.
//

import Foundation
@testable import Pathway
import Testing

struct PathwayTests {
    @Test(arguments: [
        "person@example.com",
        "first.last+tag@subdomain.example.co.uk",
        "USER@EXAMPLE.COM"
    ])
    func acceptsValidEmailAddresses(email: String) {
        #expect(isValidEmail(email))
    }

    @Test(arguments: [
        "",
        "missing-at.example.com",
        "missing-domain@",
        "missing-tld@example"
    ])
    func rejectsInvalidEmailAddresses(email: String) {
        #expect(!isValidEmail(email))
    }

    @Test(arguments: ["Password1!", "LongerPassword9&"])
    func acceptsValidPasswords(password: String) {
        #expect(isValidPassword(password))
    }

    @Test(arguments: ["password1!", "Password!", "Password1", "Short1!"])
    func rejectsInvalidPasswords(password: String) {
        #expect(!isValidPassword(password))
    }

    @Test func decodesConvexLoginResult() throws {
        let data = Data(#"{"success":true,"companyIds":["company-id"],"sessionToken":"sid_test"}"#.utf8)
        let result = try JSONDecoder().decode(LoginActionResult.self, from: data)

        #expect(result.success)
        #expect(result.companyIds == ["company-id"])
        #expect(result.sessionToken == "sid_test")
    }

    @Test func decodesNativeCompanyPickerContext() throws {
        let data = Data(#"{"email":"person@example.com","companies":[{"accountStatus":"active","companyId":"company-id","lastSelectedAt":1234,"name":"Acme Travel","primaryTeamName":"Operations","roleNames":["Consultant"]}]}"#.utf8)
        let context = try JSONDecoder().decode(NativeCompanyPickerContext.self, from: data)

        #expect(context.email == "person@example.com")
        #expect(context.companies.first?.name == "Acme Travel")
        #expect(context.companies.first?.metadata == "Operations · Consultant")
        #expect(context.companies.first?.isSelectable == true)
    }

    @Test func decodesMobileDashboardProfile() throws {
        let data = Data(#"{"userData":{"id":"user-id","email":"corey@example.com","firstName":"Corey","lastName":"Baines","profileImage":"avatar.png","profileColor":"blue"},"companyData":{"id":"company-id","name":"Pathway","storageLocation":"ap-southeast-2"}}"#.utf8)
        let bootstrap = try JSONDecoder().decode(MobileDashboardBootstrap.self, from: data)

        #expect(bootstrap.userData.displayName == "Corey Baines")
        #expect(bootstrap.userData.initials == "CB")
        #expect(bootstrap.userData.profileImage == "avatar.png")
        #expect(bootstrap.userData.profileColor == "blue")
        #expect(bootstrap.companyData.storageLocation == "ap-southeast-2")
    }

    @Test func buildsSignedProfileImageURL() throws {
        let user = MobileDashboardBootstrap.UserData(
            id: "user-id",
            email: "corey@example.com",
            firstName: "Corey",
            lastName: "Baines",
            profileImage: "avatar.png",
            profileColor: "blue",
            userType: nil
        )
        let signature = CompanyAssetCloudFrontSignature(
            baseUrl: "https://assets.example.com",
            keyPairId: "key-id",
            policy: "policy-value",
            signature: "signature-value"
        )

        let url = try #require(user.profileImageURL(
            companyID: "company-id",
            cloudFrontSignature: signature
        ))
        let components = try #require(URLComponents(url: url, resolvingAgainstBaseURL: false))
        let queryItems = Dictionary(uniqueKeysWithValues: (components.queryItems ?? []).compactMap { item in
            item.value.map { (item.name, $0) }
        })

        #expect(components.path == "/company/company-id/user/user-id/profile/avatar.png")
        #expect(queryItems["Policy"] == "policy-value")
        #expect(queryItems["Key-Pair-Id"] == "key-id")
        #expect(queryItems["Signature"] == "signature-value")
    }

    @Test(arguments: ["admin", "system_admin", "super_admin"])
    func adminUserTypesCanApproveDashboardAuthorization(userType: String) throws {
        let data = Data(
            #"{"userData":{"id":"user-id","email":"admin@example.com","userType":"\#(userType)"},"companyData":{"id":"company-id","name":"Pathway","storageLocation":"ap-southeast-2"}}"#.utf8
        )
        let bootstrap = try JSONDecoder().decode(MobileDashboardBootstrap.self, from: data)

        #expect(bootstrap.userData.canApproveAdminAuthorization)
    }

    @Test(arguments: ["normal", "demo"])
    func nonAdminUserTypesCannotApproveDashboardAuthorization(userType: String) throws {
        let data = Data(
            #"{"userData":{"id":"user-id","email":"person@example.com","userType":"\#(userType)"},"companyData":{"id":"company-id","name":"Pathway","storageLocation":"ap-southeast-2"}}"#.utf8
        )
        let bootstrap = try JSONDecoder().decode(MobileDashboardBootstrap.self, from: data)

        #expect(!bootstrap.userData.canApproveAdminAuthorization)
    }

    @Test func missingUserTypeRemainsBackwardCompatibleAndIneligible() throws {
        let data = Data(
            #"{"userData":{"id":"user-id","email":"person@example.com"},"companyData":{"id":"company-id","name":"Pathway","storageLocation":"ap-southeast-2"}}"#.utf8
        )
        let bootstrap = try JSONDecoder().decode(MobileDashboardBootstrap.self, from: data)

        #expect(bootstrap.userData.userType == nil)
        #expect(!bootstrap.userData.canApproveAdminAuthorization)
    }

    @Test func decodesAdminAuthorizationRequestMetadata() throws {
        let data = Data(
            #"{"requestId":"request-id","browser":"Safari 19","os":"macOS 26","ipAddress":"203.0.113.7","requestedAt":1000000,"expiresAt":1300000}"#.utf8
        )
        let request = try JSONDecoder().decode(AdminAuthorizationRequest.self, from: data)

        #expect(request.requestId == "request-id")
        #expect(request.browser == "Safari 19")
        #expect(request.os == "macOS 26")
        #expect(request.ipAddress == "203.0.113.7")
        #expect(request.requestedDate == Date(timeIntervalSince1970: 1_000))
        #expect(request.expiresDate == Date(timeIntervalSince1970: 1_300))
    }

    @Test func pendingAuthorizationSelectionIgnoresExpiredAndHonorsNotificationRequest() {
        let now = Date(timeIntervalSince1970: 1_000)
        let expired = makeAdminAuthorizationRequest(id: "expired", requestedAt: 800, expiresAt: 900)
        let oldest = makeAdminAuthorizationRequest(id: "oldest", requestedAt: 900, expiresAt: 1_200)
        let notificationTarget = makeAdminAuthorizationRequest(id: "target", requestedAt: 950, expiresAt: 1_300)

        let selected = [expired, oldest, notificationTarget].selectedAdminAuthorizationRequest(
            preferredRequestID: "target",
            now: now
        )

        #expect(selected?.requestId == "target")
    }

    @Test func notificationForMissingRequestDoesNotSubstituteAnotherRequest() {
        let now = Date(timeIntervalSince1970: 1_000)
        let newer = makeAdminAuthorizationRequest(id: "newer", requestedAt: 950, expiresAt: 1_300)
        let older = makeAdminAuthorizationRequest(id: "older", requestedAt: 900, expiresAt: 1_200)

        let selected = [newer, older].selectedAdminAuthorizationRequest(
            preferredRequestID: "missing",
            now: now
        )

        #expect(selected == nil)
    }

    @Test func emptyPendingAuthorizationUpdateDismissesFirstWinsSheet() {
        let requests: [AdminAuthorizationRequest] = []

        #expect(requests.selectedAdminAuthorizationRequest(preferredRequestID: "request-id") == nil)
    }

    @Test(arguments: ["approved", "denied", "expired", "cancelled", "closed"])
    func decodesTerminalAdminAuthorizationDecision(status: String) throws {
        let data = Data(#"{"accepted":false,"status":"\#(status)"}"#.utf8)
        let result = try JSONDecoder().decode(AdminAuthorizationDecisionResult.self, from: data)

        #expect(result.status.rawValue == status)
    }

    @Test func formatsAPNsDeviceTokenWithoutLeakingBinaryDescription() {
        #expect(Data([0x00, 0x0F, 0xA5, 0xFF]).apnsTokenString == "000fa5ff")
    }

    private func makeAdminAuthorizationRequest(
        id: String,
        requestedAt: TimeInterval,
        expiresAt: TimeInterval
    ) -> AdminAuthorizationRequest {
        AdminAuthorizationRequest(
            requestId: id,
            purpose: nil,
            targetUserName: nil,
            targetUserEmail: nil,
            browser: nil,
            os: nil,
            ipAddress: nil,
            requestedAt: requestedAt * 1_000,
            expiresAt: expiresAt * 1_000
        )
    }
}
