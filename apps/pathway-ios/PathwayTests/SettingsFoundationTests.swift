import Foundation
@testable import Pathway
import Testing

struct SettingsFoundationTests {
    @Test func decodesTheMobileSettingsCatalogContract() throws {
        let catalog = try JSONDecoder().decode(
            MobileSettingsCatalog.self,
            from: Data(Self.catalogJSON.utf8)
        )

        #expect(catalog.schemaVersion == 1)
        #expect(catalog.identity.displayName == "Corey Baines")
        #expect(catalog.identity.initials == "CB")
        #expect(catalog.identity.profileColor == "violet")
        #expect(catalog.workspace.effectiveCompanyScope == .organization)
        #expect(catalog.workspace.accountStatus == .paymentDue)
        #expect(catalog.roleNames == ["Administrator", "Consultant"])
        #expect(catalog.permissions.manageCompanySettings)
        #expect(catalog.entitlements.planCode == "business")
        #expect(catalog.lifecycle.canCloseCompany)
        #expect(catalog.destinations[0].availability == .available)
        #expect(catalog.destinations[1].availability == .addonRequired(code: "QCFONTBOOK"))
    }

    @Test func routeMappingIsStableAndExcludesWorkflows() {
        let destination = MobileSettingsCatalog.Destination(
            id: "email_templates",
            section: .contentAndDelivery,
            availability: .available
        )
        let unknown = MobileSettingsCatalog.Destination(
            id: "workflows",
            section: .advanced,
            availability: .available
        )

        #expect(SettingsRoute(destination: destination) == .emailTemplates)
        #expect(SettingsRoute(destination: unknown) == nil)
        #expect(!SettingsRoute.allCases.map(\.rawValue).contains("workflows"))
        #expect(SettingsRoute.allCases.map(\.rawValue) == [
            "profile", "device", "company", "security", "users", "teams", "roles",
            "fonts", "email_templates", "billing", "addons", "salesforce", "email_setup",
            "delivery_rules", "custom_data_items", "api", "integrations", "support", "about",
            "data_retention", "logout"
        ])
    }

    @Test func destinationSearchUsesTitlesAndKeywordsAndPreservesLocks() {
        let destinations = [
            MobileSettingsCatalog.Destination(
                id: "billing",
                section: .billingAndAddons,
                availability: .available
            ),
            MobileSettingsCatalog.Destination(
                id: "fonts",
                section: .contentAndDelivery,
                availability: .addonRequired(code: "QCFONTBOOK")
            ),
            MobileSettingsCatalog.Destination(
                id: "about",
                section: .supportAndAbout,
                availability: .available
            ),
            MobileSettingsCatalog.Destination(
                id: "workflows",
                section: .advanced,
                availability: .available
            )
        ]

        let billing = SettingsDestinationSearchIndex.items(
            destinations: destinations,
            matching: "payment method",
            locale: Locale(identifier: "en")
        )
        let about = SettingsDestinationSearchIndex.items(
            destinations: destinations,
            matching: "WHAT'S NEW",
            locale: Locale(identifier: "en")
        )
        let fonts = SettingsDestinationSearchIndex.items(
            destinations: destinations,
            matching: "typeface",
            locale: Locale(identifier: "en")
        )
        let all = SettingsDestinationSearchIndex.items(
            destinations: destinations,
            matching: "",
            locale: Locale(identifier: "en")
        )

        #expect(billing.map(\.route) == [.billing])
        #expect(about.map(\.route) == [.about])
        #expect(fonts.first?.availability == .addonRequired(code: "QCFONTBOOK"))
        #expect(all.map(\.route) == [.billing, .fonts, .about])
    }

    @Test @MainActor func devicePreferencesPersistOnlySupportedLocalChoices() throws {
        let suiteName = "SettingsFoundationTests.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }

        let preferences = SettingsDevicePreferences(defaults: defaults, keyPrefix: "test")
        preferences.setAppearance(.dark)
        preferences.setAppLanguage(code: "FR")

        let restored = SettingsDevicePreferences(defaults: defaults, keyPrefix: "test")
        #expect(restored.appearance == .dark)
        #expect(restored.appLanguageCode == "fr")
        #expect(SettingsDevicePreferences.supportedLanguageCodes.count == 41)

        restored.setAppLanguage(code: "unsupported")
        #expect(restored.appLanguageCode == "fr")
        restored.setAppLanguage(code: nil)
        #expect(restored.appLanguageCode == nil)
    }

    @Test @MainActor func featureStoreStartsOneLiveSubscriptionAndPublishesCatalog() async {
        let client = TestSettingsCatalogClient()
        let store = SettingsFeatureStore(
            client: client,
            devicePreferences: SettingsDevicePreferences(keyPrefix: "test.store")
        )

        store.start()
        store.start()
        await client.waitUntilObservationCount(1)
        client.send(Self.makeCatalog(), toObservationAt: 0)

        #expect(client.observationCount == 1)
        #expect(store.phase == .loaded)
        #expect(store.catalog?.identity.email == "corey@example.com")

        store.searchText = "close account"
        #expect(store.destinations.map(\.route) == [.dataRetention])
        store.reset()
        #expect(store.phase == .idle)
        #expect(store.catalog == nil)
        #expect(store.searchText.isEmpty)
    }

    @Test @MainActor func featureStoreSurfacesSubscriptionErrorsAndCanRetry() async {
        let client = TestSettingsCatalogClient()
        let store = SettingsFeatureStore(
            client: client,
            devicePreferences: SettingsDevicePreferences(keyPrefix: "test.error")
        )

        store.start()
        await client.waitUntilObservationCount(1)
        client.fail(TestCatalogError.offline, observationAt: 0)
        await Self.waitUntil { store.errorMessage != nil }

        #expect(store.phase == .failed(message: "Settings are offline."))
        #expect(store.errorMessage == "Settings are offline.")

        store.retry()
        await client.waitUntilObservationCount(2)
        #expect(client.observationCount == 2)
        store.stop()
    }

    @Test @MainActor func unsupportedCatalogSchemaFailsWithoutPublishingRoutes() async {
        let client = TestSettingsCatalogClient()
        let store = SettingsFeatureStore(
            client: client,
            devicePreferences: SettingsDevicePreferences(keyPrefix: "test.schema")
        )

        store.start()
        await client.waitUntilObservationCount(1)
        client.send(Self.makeCatalog(schemaVersion: 2), toObservationAt: 0)

        #expect(store.catalog == nil)
        #expect(store.destinations.isEmpty)
        #expect(store.errorMessage != nil)
        store.stop()
    }

    @Test @MainActor func resetRejectsCallbacksFromThePreviousCompanySubscription() async {
        let client = TestSettingsCatalogClient()
        let store = SettingsFeatureStore(
            client: client,
            devicePreferences: SettingsDevicePreferences(keyPrefix: "test.generation")
        )

        store.start()
        await client.waitUntilObservationCount(1)
        store.reset()
        store.start()
        await client.waitUntilObservationCount(2)

        client.send(Self.makeCatalog(schemaVersion: 2), toObservationAt: 0)
        #expect(store.phase == .loading)
        #expect(store.catalog == nil)

        client.send(Self.makeCatalog(), toObservationAt: 1)
        #expect(store.phase == .loaded)
        store.stop()
    }

    @Test @MainActor func droppingFeatureStoreCancelsItsLiveSubscription() async {
        let client = TestSettingsCatalogClient()
        weak var weakStore: SettingsFeatureStore?
        var store: SettingsFeatureStore? = SettingsFeatureStore(
            client: client,
            devicePreferences: SettingsDevicePreferences(keyPrefix: "test.deinit")
        )
        weakStore = store

        store?.start()
        await client.waitUntilObservationCount(1)
        store = nil
        await Self.waitUntil {
            weakStore == nil && client.cancellationCount == 1
        }
    }

    private static func makeCatalog(schemaVersion: Int = 1) -> MobileSettingsCatalog {
        MobileSettingsCatalog(
            schemaVersion: schemaVersion,
            identity: .init(
                userId: "user-id",
                email: "corey@example.com",
                firstName: "Corey",
                lastName: "Baines",
                displayName: "Corey Baines",
                profileImage: nil,
                profileColor: "violet"
            ),
            workspace: .init(
                companyId: "company-id",
                companyName: "Pathway",
                membershipId: "membership-id",
                ownerUserId: "user-id",
                accountStatus: .active,
                storageLocation: "ap-southeast-2",
                effectiveCompanyScope: .organization,
                isOrganizationAdmin: true,
                isOwner: true,
                primaryTeamId: nil,
                treatTeamsAsCompanies: false
            ),
            roleNames: ["Administrator"],
            permissions: .init(
                manageSecurityAndSessions: true,
                manageUserAccounts: true,
                manageTeams: true,
                manageRoles: true,
                organizationAdmin: true,
                restrictUserManageToTeam: false,
                manageSubscriptions: true,
                manageBillingConfiguration: true,
                manageAddressBookContacts: true,
                manageDataItems: true,
                manageFontBook: true,
                manageCompanySettings: true,
                manageWorkflows: true,
                canAccessDevCenter: true
            ),
            entitlements: .init(
                activeAddonCodes: [],
                planCode: "business",
                planName: "Business",
                subscriptionStatus: "active"
            ),
            lifecycle: .init(canManage: true, canCloseCompany: true, isOwner: true),
            destinations: [
                .init(id: "profile", section: .personal, availability: .available),
                .init(id: "data_retention", section: .dataAndSession, availability: .available),
                .init(id: "logout", section: .dataAndSession, availability: .available)
            ]
        )
    }

    @MainActor
    private static func waitUntil(
        timeout: Duration = .seconds(1),
        _ condition: @MainActor () -> Bool
    ) async {
        let clock = ContinuousClock()
        let deadline = clock.now.advanced(by: timeout)
        while !condition(), clock.now < deadline {
            try? await Task.sleep(for: .milliseconds(1))
        }
        #expect(condition())
    }

    private static let catalogJSON = #"""
    {
      "schemaVersion": 1,
      "identity": {
        "userId": "user-id",
        "email": "corey@example.com",
        "firstName": "Corey",
        "lastName": "Baines",
        "displayName": "Corey Baines",
        "profileImage": "avatar.png",
        "profileColor": "violet"
      },
      "workspace": {
        "companyId": "company-id",
        "companyName": "Pathway",
        "membershipId": "membership-id",
        "ownerUserId": "user-id",
        "accountStatus": "payment_due",
        "storageLocation": "ap-southeast-2",
        "effectiveCompanyScope": "organization",
        "isOrganizationAdmin": true,
        "isOwner": true,
        "primaryTeamId": "team-id",
        "treatTeamsAsCompanies": false
      },
      "roleNames": ["Administrator", "Consultant"],
      "permissions": {
        "manageSecurityAndSessions": true,
        "manageUserAccounts": true,
        "manageTeams": true,
        "manageRoles": true,
        "organizationAdmin": true,
        "restrictUserManageToTeam": false,
        "manageSubscriptions": true,
        "manageBillingConfiguration": true,
        "manageAddressBookContacts": true,
        "manageDataItems": true,
        "manageFontBook": true,
        "manageCompanySettings": true,
        "manageWorkflows": true,
        "canAccessDevCenter": true
      },
      "entitlements": {
        "activeAddonCodes": ["QCUSERMANAGEMENT"],
        "planCode": "business",
        "planName": "Business",
        "subscriptionStatus": "active"
      },
      "lifecycle": {
        "canManage": true,
        "canCloseCompany": true,
        "isOwner": true
      },
      "destinations": [
        {
          "id": "profile",
          "section": "personal",
          "availability": { "status": "available" }
        },
        {
          "id": "fonts",
          "section": "content_and_delivery",
          "availability": {
            "status": "locked",
            "reason": "addon_required",
            "addonCode": "QCFONTBOOK"
          }
        }
      ]
    }
    """#
}

@MainActor
private final class TestSettingsCatalogClient: SettingsCatalogStreaming {
    private struct Observation {
        let receiveValue: @MainActor (MobileSettingsCatalog) -> Void
        var continuation: CheckedContinuation<Void, any Error>?
    }

    private(set) var observationCount = 0
    private(set) var cancellationCount = 0
    private var observations: [Observation] = []
    private var observationWaiters: [(count: Int, continuation: CheckedContinuation<Void, Never>)] = []
    private var cancelledBeforeRegistration: Set<Int> = []

    func waitUntilObservationCount(_ count: Int) async {
        guard observationCount < count else { return }
        await withCheckedContinuation { continuation in
            observationWaiters.append((count, continuation))
        }
    }

    func send(_ catalog: MobileSettingsCatalog, toObservationAt index: Int) {
        observations[index].receiveValue(catalog)
    }

    func fail(_ error: any Error, observationAt index: Int) {
        observations[index].continuation?.resume(throwing: error)
        observations[index].continuation = nil
    }

    func observeCatalog(
        receiveValue: @MainActor @escaping (MobileSettingsCatalog) -> Void
    ) async throws {
        let index = observationCount
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                observations.append(Observation(
                    receiveValue: receiveValue,
                    continuation: continuation
                ))
                observationCount += 1
                resumeObservationWaiters()
                if cancelledBeforeRegistration.remove(index) != nil {
                    cancelObservation(at: index)
                }
            }
        } onCancel: {
            Task { @MainActor [weak self] in
                self?.cancelObservation(at: index)
            }
        }
    }

    private func resumeObservationWaiters() {
        let ready = observationWaiters.filter { observationCount >= $0.count }
        observationWaiters.removeAll { observationCount >= $0.count }
        for waiter in ready {
            waiter.continuation.resume()
        }
    }

    private func cancelObservation(at index: Int) {
        guard observations.indices.contains(index) else {
            cancelledBeforeRegistration.insert(index)
            return
        }
        guard let continuation = observations[index].continuation else { return }
        observations[index].continuation = nil
        cancellationCount += 1
        continuation.resume(throwing: CancellationError())
    }
}

private enum TestCatalogError: LocalizedError {
    case offline

    var errorDescription: String? { "Settings are offline." }
}
