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
    @UIApplicationDelegateAdaptor(AppDelegate.self) var appDelegate
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

    private var isDocumentInteractionUITest: Bool {
        ProcessInfo.processInfo.arguments.contains("--ui-testing-document-interactions")
    }

    var body: some Scene {
        WindowGroup {
            if isDocumentInteractionUITest {
                DocumentInteractionUITestFixtureRoot()
            } else if let appModel {
                InitView()
                    .environment(Clerk.shared)
                    .environment(appModel)
                    .onOpenURL { url in
                        Task {
                            try? await Clerk.shared.handle(url)
                        }
                    }
                    .task {
                        appDelegate.connect(to: appModel)
                    }
            } else {
                MissingConfigurationView(keys: missingConfigurationKeys)
            }
        }
    }
}

private struct MissingConfigurationView: View {
    let keys: [String]

    var body: some View {
        ContentUnavailableView {
            Label("Pathway iOS needs configuration", systemImage: "wrench.and.screwdriver")
        } description: {
            Text("Run `node scripts/configure-pathway-ios.ts` after setting the Pathway public identifiers in the repository-root .env file. Missing: \(keys.joined(separator: ", ")).")
        }
    }
}
