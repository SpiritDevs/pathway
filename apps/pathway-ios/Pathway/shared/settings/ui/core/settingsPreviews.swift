#if DEBUG
    import SwiftUI

    private struct SettingsDestinationPreview: View {
        let route: SettingsRoute

        var body: some View {
            NavigationStack {
                SettingsWorkspaceContentDestinationView(
                    route: route,
                    catalog: SettingsPreviewFixtures.catalog,
                    locale: SettingsPreviewFixtures.locale,
                    manageAddons: { _ in }
                )
            }
        }
    }

    #Preview("Settings — Loaded") {
        @Previewable @State var searchText = ""

        NavigationStack {
            SettingsRootContent(
                phase: .loaded,
                catalog: SettingsPreviewFixtures.catalog,
                destinations: SettingsPreviewFixtures.destinations,
                searchText: $searchText,
                locale: SettingsPreviewFixtures.locale,
                onSelect: { _ in },
                onRetry: {}
            )
        }
    }

    #Preview("Settings — Search") {
        @Previewable @State var searchText = "billing"

        NavigationStack {
            SettingsRootContent(
                phase: .loaded,
                catalog: SettingsPreviewFixtures.catalog,
                destinations: SettingsPreviewFixtures.destinations,
                searchText: $searchText,
                locale: SettingsPreviewFixtures.locale,
                onSelect: { _ in },
                onRetry: {}
            )
        }
    }

    #Preview("Settings — Loading") {
        NavigationStack {
            SettingsLoadingView()
                .navigationTitle("Settings")
        }
    }

    #Preview("Settings — Error") {
        SettingsErrorView(
            title: "Settings Unavailable",
            message: "Pathway could not load settings for this preview.",
            onRetry: {}
        )
    }

    #Preview("Settings — Empty Search") {
        SettingsEmptyView(isSearching: true)
    }

    #Preview("Settings — Locked Feature") {
        NavigationStack {
            SettingsLockedFeatureView(
                item: SettingsDestinationSearchItem(
                    route: .salesforce,
                    title: "Salesforce",
                    section: .advanced,
                    availability: .addonRequired(code: "salesforce")
                ),
                onOpenAddons: {}
            )
        }
    }

    #Preview("Device Settings") {
        let preferences = SettingsDevicePreferences(keyPrefix: "pathway.preview.device")

        NavigationStack {
            SettingsDeviceView(
                preferences: preferences,
                openNotificationSettings: {}
            )
        }
    }

    #Preview("My Profile") {
        NavigationStack {
            SettingsProfileView(
                service: SettingsPreviewProfileService(),
                roleNames: SettingsPreviewFixtures.catalog.roleNames,
                cloudFrontSignature: nil,
                onRequestBack: {},
                onDirtyStateChange: { _ in }
            )
        }
    }

    #Preview("Billing") {
        NavigationStack {
            SettingsBillingView(
                service: SettingsPreviewBillingService(),
                locale: SettingsPreviewFixtures.locale
            )
        }
    }

    #Preview("Add-ons") {
        NavigationStack {
            SettingsAddonsView(
                service: SettingsPreviewBillingService(),
                locale: SettingsPreviewFixtures.locale,
                deviceAuth: {},
                onSensitiveOperationStateChange: { _ in }
            )
        }
    }

    #Preview("Support") {
        NavigationStack {
            SettingsSupportView(
                catalog: SettingsPreviewFixtures.catalog,
                service: SettingsPreviewSupportService(),
                locale: SettingsPreviewFixtures.locale
            )
        }
    }

    #Preview("What's New") {
        NavigationStack {
            SettingsSupportView(
                catalog: SettingsPreviewFixtures.catalog,
                service: SettingsPreviewSupportService(),
                locale: SettingsPreviewFixtures.locale,
                initialSection: "news"
            )
        }
    }

    #Preview("About") {
        NavigationStack {
            SettingsAboutView(
                catalog: SettingsPreviewFixtures.catalog,
                locale: SettingsPreviewFixtures.locale,
                onOpenWhatsNew: {}
            )
        }
    }

    #Preview("Data Retention") {
        NavigationStack {
            SettingsDataRetentionView(
                catalog: SettingsPreviewFixtures.catalog,
                service: SettingsPreviewBillingService(),
                locale: SettingsPreviewFixtures.locale,
                deviceAuth: {},
                onCancellation: { _ in },
                onSensitiveOperationStateChange: { _ in }
            )
        }
    }

    #Preview("Log Out") {
        NavigationStack {
            SettingsLogoutView(logout: {})
        }
    }

    #Preview("Company") {
        SettingsDestinationPreview(route: .company)
    }

    #Preview("Security") {
        SettingsDestinationPreview(route: .security)
    }

    #Preview("Users") {
        SettingsDestinationPreview(route: .users)
    }

    #Preview("Teams") {
        SettingsDestinationPreview(route: .teams)
    }

    #Preview("Roles") {
        SettingsDestinationPreview(route: .roles)
    }

    #Preview("Fonts") {
        SettingsDestinationPreview(route: .fonts)
    }

    #Preview("Email Templates") {
        SettingsDestinationPreview(route: .emailTemplates)
    }

    #Preview("Email Setup") {
        SettingsDestinationPreview(route: .emailSetup)
    }

    #Preview("Delivery Rules") {
        SettingsDestinationPreview(route: .deliveryRules)
    }

    #Preview("Custom Data Items") {
        SettingsDestinationPreview(route: .customDataItems)
    }

    #Preview("API Credentials") {
        SettingsDestinationPreview(route: .api)
    }

    #Preview("Integrations") {
        SettingsDestinationPreview(route: .integrations)
    }

    #Preview("Salesforce") {
        SettingsDestinationPreview(route: .salesforce)
    }

    #Preview("Workspace — Add-on Required") {
        NavigationStack {
            SettingsWCLockedDestinationView(
                title: "Salesforce",
                addonCode: "salesforce",
                locale: SettingsPreviewFixtures.locale,
                manageAddons: { _ in }
            )
            .navigationTitle("Salesforce")
        }
    }

    #Preview("Workspace — Access Unavailable") {
        NavigationStack {
            SettingsWCAccessUnavailableView(
                title: "Company",
                locale: SettingsPreviewFixtures.locale
            )
            .navigationTitle("Company")
        }
    }
#endif
