#if DEBUG
    import Foundation

    enum SettingsPreviewFixtures {
        static let locale = Locale(identifier: "en_AU")
        static let timestamp = 1_783_000_000.0

        static let catalog = MobileSettingsCatalog(
            schemaVersion: MobileSettingsCatalog.supportedSchemaVersion,
            identity: .init(
                userId: "preview-user",
                email: "corey@example.com",
                firstName: "Corey",
                lastName: "Baines",
                displayName: "Corey Baines",
                profileImage: nil,
                profileColor: "violet"
            ),
            workspace: .init(
                companyId: "preview-company",
                companyName: "Pathway Preview",
                membershipId: "preview-membership",
                ownerUserId: "preview-user",
                accountStatus: .active,
                storageLocation: "australia_southeast",
                effectiveCompanyScope: .organization,
                isOrganizationAdmin: true,
                isOwner: true,
                primaryTeamId: "preview-team",
                treatTeamsAsCompanies: false
            ),
            roleNames: ["Owner", "Administrator"],
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
                activeAddonCodes: ["salesforce", "custom_branding"],
                planCode: "professional",
                planName: "Professional",
                subscriptionStatus: "active"
            ),
            lifecycle: .init(canManage: true, canCloseCompany: true, isOwner: true),
            destinations: previewDestinations
        )

        static let destinations = SettingsDestinationSearchIndex.items(
            destinations: catalog.destinations,
            matching: "",
            locale: locale
        )

        static let billing = SettingsBillingSnapshot(
            companyData: .init(
                id: "preview-company",
                name: "Pathway Preview",
                accountStatus: "active",
                subscriptionPlan: "professional",
                hasActivePaymentMethod: true,
                hasPaidBillingHistory: true,
                storageLocation: "australia_southeast",
                details: .init(
                    phone: "+61 2 5550 0100",
                    abnacn: "12 345 678 901",
                    billingEmails: ["accounts@example.com"],
                    trialExpiryDate: nil,
                    nextTrialReminderAt: nil
                )
            ),
            plan: .init(
                billingStatus: "active",
                currencyCode: "AUD",
                currencySymbol: "$",
                nextInvoiceDate: timestamp + 864_000,
                plan: "professional",
                planId: "plan-professional",
                planInterval: "monthly",
                planName: "Professional"
            ),
            permissions: .init(
                manageSubscriptions: true,
                manageBillingConfiguration: true
            ),
            subscriptionDetails: [],
            usersTotal: .init(total: 14)
        )

        static let invoices = [
            SettingsBillingInvoice(
                id: "invoice-1",
                invoiceNumber: "INV-1042",
                billingMonthKey: "2026-07",
                currencyCode: "AUD",
                amountDueMinorUnits: 0,
                subtotalMinorUnits: 18000,
                taxMinorUnits: 1800,
                totalMinorUnits: 19800,
                status: "paid",
                dueAt: timestamp - 172_800,
                issuedAt: timestamp - 604_800,
                paidAt: timestamp - 259_200
            ),
            SettingsBillingInvoice(
                id: "invoice-2",
                invoiceNumber: "INV-1031",
                billingMonthKey: "2026-06",
                currencyCode: "AUD",
                amountDueMinorUnits: 0,
                subtotalMinorUnits: 18000,
                taxMinorUnits: 1800,
                totalMinorUnits: 19800,
                status: "paid",
                dueAt: timestamp - 2_764_800,
                issuedAt: timestamp - 3_196_800,
                paidAt: timestamp - 2_937_600
            )
        ]

        static let pauseState = SettingsAccountPauseState(
            canManageSubscriptions: true,
            companyName: "Pathway Preview",
            nextChargeAt: timestamp + 864_000,
            pauseEndsAt: nil,
            pausePendingAt: nil,
            pausedAt: nil,
            previewPauseEndsAt: timestamp + 7_776_000,
            previewPauseMonths: 3,
            previewPausePendingAt: timestamp,
            status: "active"
        )
    }

    extension SettingsPreviewFixtures {
        static let installedAddons: [SettingsMarketplaceAddon] = decode(
            """
            [
              {
                "id": "addon-1",
                "addonCode": "salesforce",
                "name": "Salesforce",
                "subtitle": "Connect Pathway documents to Salesforce.",
                "developer": "Pathway",
                "categoryKey": "integrations",
                "categoryName": "Integrations",
                "iconMode": "symbol",
                "iconKey": "cloud",
                "iconUrl": null,
                "priceLabel": "$49 / month",
                "subscribed": true,
                "suspended": false,
                "included": false,
                "tierCount": 1,
                "currentTierLabel": "Professional",
                "sortOrder": 1
              },
              {
                "id": "addon-2",
                "addonCode": "custom_branding",
                "name": "Custom Branding",
                "subtitle": "Use company colours and branded document themes.",
                "developer": "Pathway",
                "categoryKey": "content",
                "categoryName": "Content",
                "iconMode": "symbol",
                "iconKey": "paintpalette",
                "iconUrl": null,
                "priceLabel": "Included",
                "subscribed": true,
                "suspended": false,
                "included": true,
                "tierCount": 1,
                "currentTierLabel": "Included",
                "sortOrder": 2
              }
            ]
            """
        )

        static let addonSnapshot = SettingsAddonSnapshot(
            availableAddonPlans: [],
            company: .init(subscriptionPlan: "professional", trialExpiresAt: nil),
            subscriptions: [
                .init(
                    id: "subscription-1",
                    addon: "salesforce",
                    planId: "salesforce-professional",
                    status: "active",
                    effectiveDate: timestamp + 2_592_000,
                    tierLabel: "Professional",
                    pendingChange: nil
                )
            ],
            currentPlan: .init(
                planId: "plan-professional",
                plan: "professional",
                planName: "Professional",
                nextInvoiceDate: timestamp + 864_000
            )
        )

        static let profile = SettingsProfileSnapshot(
            user: .init(
                id: "preview-user",
                email: "corey@example.com",
                firstName: "Corey",
                lastName: "Baines",
                emailVerified: "verified",
                pendingEmail: nil,
                sendMagicLinkEmail: true
            ),
            profile: .init(
                profileImage: nil,
                profileColor: "#4F46E5",
                officePhone: "+61 2 5550 0100",
                phone: "+61 400 000 000",
                address: "Sydney NSW, Australia",
                whatsapp: "+61 400 000 000",
                slack: "@corey",
                microsoftTeams: "corey@example.com",
                birthday: nil,
                workAnniversary: nil,
                timezone: "Australia/Sydney",
                locale: "en_AU",
                dateFormat: "dd/MM/yyyy",
                workingStatus: "available",
                twentyFourHourTime: false,
                firstDayOfWeek: "monday",
                disabledActivityIndicator: false
            ),
            company: .init(
                id: "preview-company",
                name: "Pathway Preview",
                storageLocation: "Australia Southeast",
                locale: "en_AU",
                timezone: "Australia/Sydney",
                dateFormat: "dd/MM/yyyy"
            ),
            notificationPreferences: [:],
            companyList: [
                .init(id: "preview-company", name: "Pathway Preview", active: true)
            ]
        )
    }

    extension SettingsPreviewFixtures {
        static let messages = [
            SettingsSupportMessage(
                id: "message-1",
                conversationId: "conversation-1",
                parentMessageId: nil,
                type: "message",
                ownerId: "preview-user",
                ownerType: "user",
                content: "Could you help me update our document branding?",
                attachmentIds: [],
                tagIds: [],
                ticketId: nil,
                createdAt: timestamp - 3600,
                modifiedAt: nil,
                sentAt: timestamp - 3600,
                deliveryStatusByUser: nil,
                editedAt: nil,
                deletedAt: nil
            ),
            SettingsSupportMessage(
                id: "message-2",
                conversationId: "conversation-1",
                parentMessageId: nil,
                type: "message",
                ownerId: "support-agent",
                ownerType: "admin",
                content: "Absolutely — I can walk you through the branding settings.",
                attachmentIds: [],
                tagIds: [],
                ticketId: nil,
                createdAt: timestamp - 1800,
                modifiedAt: nil,
                sentAt: timestamp - 1800,
                deliveryStatusByUser: nil,
                editedAt: nil,
                deletedAt: nil
            )
        ]

        static let conversations = [
            SettingsSupportConversation(
                id: "conversation-1",
                title: "Document branding",
                subject: "Help with document branding",
                ownerId: "preview-user",
                companyId: "preview-company",
                userIds: ["preview-user"],
                adminIds: ["support-agent"],
                assignedAdminId: "support-agent",
                lastActivity: timestamp - 1800,
                status: "active",
                createdAt: timestamp - 86400,
                recentMessages: messages
            )
        ]

        static let tickets = [
            SettingsSupportTicket(
                id: "ticket-1",
                conversationId: "conversation-1",
                title: "Branding colours not applying",
                description: "The saved company colours are not appearing on newly created documents.",
                ticketType: "support",
                status: "in_progress",
                priority: "normal",
                effortEstimate: "small",
                ownerId: "preview-user",
                companyId: "preview-company",
                assignedToId: "support-agent",
                dueDate: timestamp + 86400,
                attachmentIds: [],
                createdAt: timestamp - 172_800,
                updatedAt: timestamp - 3600
            )
        ]

        static let news = [
            SettingsNewsPost(
                id: "news-1",
                title: "A faster, clearer Settings experience",
                summary: "Settings now use native controls and more compact rows across iPhone and iPad.",
                contentHtml: "<p>We have refreshed Settings with clearer sections, compact rows and improved accessibility.</p>",
                imageUrl: nil,
                category: "product update",
                publishedAt: timestamp - 86400,
                authorId: "pathway",
                linkUrl: nil,
                isPublished: true,
                createdAt: timestamp - 172_800,
                updatedAt: timestamp - 86400
            )
        ]

        private static let previewDestinations: [MobileSettingsCatalog.Destination] = [
            .init(id: "profile", section: .personal, availability: .available),
            .init(id: "device", section: .personal, availability: .available),
            .init(id: "company", section: .workspace, availability: .available),
            .init(id: "security", section: .workspace, availability: .available),
            .init(id: "users", section: .workspace, availability: .available),
            .init(id: "teams", section: .workspace, availability: .available),
            .init(id: "roles", section: .workspace, availability: .available),
            .init(id: "fonts", section: .contentAndDelivery, availability: .available),
            .init(id: "email_templates", section: .contentAndDelivery, availability: .available),
            .init(id: "billing", section: .billingAndAddons, availability: .available),
            .init(id: "addons", section: .billingAndAddons, availability: .available),
            .init(id: "salesforce", section: .advanced, availability: .available),
            .init(id: "email_setup", section: .contentAndDelivery, availability: .available),
            .init(id: "delivery_rules", section: .contentAndDelivery, availability: .available),
            .init(id: "custom_data_items", section: .contentAndDelivery, availability: .available),
            .init(id: "api", section: .advanced, availability: .available),
            .init(id: "integrations", section: .advanced, availability: .available),
            .init(id: "support", section: .supportAndAbout, availability: .available),
            .init(id: "about", section: .supportAndAbout, availability: .available),
            .init(id: "data_retention", section: .dataAndSession, availability: .available),
            .init(id: "logout", section: .dataAndSession, availability: .available)
        ]

        private static func decode<Value: Decodable>(_ json: String) -> Value {
            do {
                return try JSONDecoder().decode(Value.self, from: Data(json.utf8))
            } catch {
                preconditionFailure("Invalid settings preview fixture: \(error)")
            }
        }
    }
#endif
