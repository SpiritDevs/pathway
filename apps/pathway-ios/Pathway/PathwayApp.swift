//
//  PathwayApp.swift
//  Pathway
//
//  Created by Corey Baines on 20/11/2024.
//

import ClerkKit
import SwiftUI

@main
struct PathwayApp: App {
    @State private var appModel: PathwayAppModel?
    private let missingConfigurationKeys: [String]

    init() {
        missingConfigurationKeys = AppConfiguration.missingRequiredKeys
        guard
            missingConfigurationKeys.isEmpty,
            let publishableKey = AppConfiguration.clerkPublishableKey,
            let convexDeploymentURL = AppConfiguration.convexDeploymentURL
        else {
            _appModel = State(initialValue: nil)
            return
        }

        Clerk.configure(
            publishableKey: publishableKey,
            options: .init(
                redirectConfig: .init(
                    redirectUrl: "pathway://callback",
                    callbackUrlScheme: "pathway"
                )
            )
        )
        _appModel = State(
            initialValue: PathwayAppModel(convexDeploymentURL: convexDeploymentURL)
        )
    }

    @SceneBuilder
    var body: some Scene {
        #if os(visionOS)
            WindowGroup {
                mainContent
            }
            .defaultSize(width: 1180, height: 820)
            .windowResizability(.contentMinSize)

            WindowGroup("Pathway Agent", id: PathwayWindow.agentOrchestrator.rawValue) {
                configuredContent {
                    AgentOrchestratorView()
                        .frame(minWidth: 560, minHeight: 620)
                }
            }
            .defaultSize(width: 720, height: 780)
            .windowResizability(.contentMinSize)

            WindowGroup("Pathway Settings", id: PathwayWindow.settings.rawValue) {
                configuredContent {
                    NavigationStack {
                        PathwaySettingsView()
                    }
                    .frame(minWidth: 420, minHeight: 480)
                }
            }
            .defaultSize(width: 520, height: 600)
            .windowResizability(.contentMinSize)
        #else
            WindowGroup {
                mainContent
            }
        #endif
    }

    @ViewBuilder
    private var mainContent: some View {
        if let appModel {
            InitView()
                .environment(Clerk.shared)
                .environment(appModel)
                .onOpenURL(perform: handleOpenURL)
        } else {
            MissingConfigurationView(keys: missingConfigurationKeys)
        }
    }

    @ViewBuilder
    private func configuredContent(
        @ViewBuilder content: () -> some View
    ) -> some View {
        if let appModel {
            content()
                .environment(Clerk.shared)
                .environment(appModel)
        } else {
            MissingConfigurationView(keys: missingConfigurationKeys)
        }
    }

    private func handleOpenURL(_ url: URL) {
        Task {
            try? await Clerk.shared.handle(url)
        }
    }
}

private struct MissingConfigurationView: View {
    let keys: [String]

    var body: some View {
        ContentUnavailableView {
            Label("Pathway needs configuration", systemImage: "wrench.and.screwdriver")
        } description: {
            Text(
                "Run `node scripts/configure-pathway-ios.ts` after setting the Pathway public identifiers in the repository-root .env file. Missing: \(keys.joined(separator: ", "))."
            )
        }
        .frame(minWidth: 320, minHeight: 320)
    }
}
