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
    @Environment(\.scenePhase) private var scenePhase
    @UIApplicationDelegateAdaptor(PathwayNotificationDelegate.self) private var notificationDelegate
    @State private var appModel: PathwayAppModel?
    private let missingConfigurationKeys: [String]

    init() {
        missingConfigurationKeys = AppConfiguration.missingRequiredKeys
        #if DEBUG && !os(visionOS)
        if ProcessInfo.processInfo.arguments.contains("--uitest-assets") || ProcessInfo.processInfo.arguments.contains("--uitest-issues") || ProcessInfo.processInfo.arguments.contains("--uitest-conversation") || ProcessInfo.processInfo.arguments.contains("--uitest-parity") {
            _appModel = State(initialValue: nil)
            return
        }
        #endif
        guard
            missingConfigurationKeys.isEmpty,
            let publishableKey = AppConfiguration.clerkPublishableKey,
            let convexDeploymentURL = AppConfiguration.convexDeploymentURL,
            let relayURL = AppConfiguration.relayURL,
            let relayJWTTemplate = AppConfiguration.clerkJWTTemplate
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
            initialValue: PathwayAppModel(
                convexDeploymentURL: convexDeploymentURL,
                relayURL: relayURL,
                relayJWTTemplate: relayJWTTemplate
            )
        )
    }

    @SceneBuilder
    var body: some Scene {
        #if os(visionOS)
            WindowGroup {
                mainContent
            }
            .commands { PathwayKeyboardCommands(isAvailable: appModel?.isAccountReady == true) }
            .defaultSize(width: 1180, height: 820)
            .windowResizability(.contentMinSize)

            WindowGroup("Pathway Agent", id: PathwayWindow.agentOrchestrator.rawValue) {
                configuredContent {
                    AgentOrchestratorView(isSeparateWindow: true)
                        .frame(minWidth: 560, minHeight: 620)
                }
            }
            .defaultSize(width: 720, height: 780)
            .windowResizability(.contentMinSize)

            WindowGroup("Pathway Settings", id: PathwayWindow.settings.rawValue) {
                configuredContent {
                    NavigationStack {
                        PathwaySettingsView(isSeparateWindow: true)
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
            .commands { PathwayKeyboardCommands(isAvailable: appModel?.isAccountReady == true) }
        #endif
    }

    @ViewBuilder
    private var mainContent: some View {
        #if DEBUG && !os(visionOS)
        if ProcessInfo.processInfo.arguments.contains("--uitest-assets") {
            PathwayAssetsSimulatorScene()
        } else if ProcessInfo.processInfo.arguments.contains("--uitest-issues") {
            PathwayIssuesSimulatorScene()
        } else if ProcessInfo.processInfo.arguments.contains("--uitest-conversation") {
            PathwayConversationSimulatorScene()
        } else if ProcessInfo.processInfo.arguments.contains("--uitest-parity") {
            PathwayParitySimulatorScene()
        } else {
            authenticatedContent
        }
        #else
        authenticatedContent
        #endif
    }

    @ViewBuilder
    private var authenticatedContent: some View {
        if let appModel {
            InitView()
                .modifier(PathwayAppearanceModifier())
                .environment(Clerk.shared)
                .environment(appModel)
                .onOpenURL(perform: handleOpenURL)
                .task {
                    notificationDelegate.onOpenStorage = { appModel.pendingStorageNotification = $0 }
                    if let storage = notificationDelegate.pendingStorage {
                        appModel.pendingStorageNotification = storage
                        notificationDelegate.pendingStorage = nil
                    }
                    notificationDelegate.onOpenThread = { appModel.openProductLink($0) }
                    if let link = notificationDelegate.pendingLink {
                        appModel.openProductLink(link)
                        notificationDelegate.pendingLink = nil
                    }
                }
                .onChange(of: appModel.workWidgetCounts) { _, _ in appModel.updateWorkWidget() }
                .onChange(of: appModel.cloud.isConnected) { _, _ in appModel.updateWorkWidget() }
                .onChange(of: appModel.cloud.cachedAt) { _, _ in appModel.updateWorkWidget() }
                .onChange(of: appModel.isAccountReady) { _, ready in if ready { appModel.resolveProductLink() } }
                .onChange(of: appModel.cloud.threads.map(\.id)) { _, _ in appModel.resolveProductLink() }
                .onChange(of: scenePhase) { _, phase in
                    if phase == .active { Task {
                        await PathwayNotifications.shared.foreground()
                        await PathwayCaptureInbox.shared.refresh()
                        appModel.updateWorkWidget()
                    } }
                }
        } else {
            MissingConfigurationView(keys: missingConfigurationKeys)
        }
    }

    @ViewBuilder
    private func configuredContent(
        @ViewBuilder content: () -> some View
    ) -> some View {
        if let appModel {
            Group {
                if appModel.authenticationState == .signedIn && appModel.isAccountReady {
                    content().id(appModel.localStorageDirectory)
                } else if appModel.authenticationState == .signedOut {
                    ContentUnavailableView {
                        Label("Sign in to Pathway", systemImage: "person.crop.circle")
                    } description: { Text("Sign in to open your workspace in this window.") } actions: {
                        Button("Sign in") { Task { await appModel.signIn() } }
                    }
                } else { ProgressView("Preparing your workspace") }
            }
                .modifier(PathwayAppearanceModifier())
                .environment(Clerk.shared)
                .environment(appModel)
        } else {
            MissingConfigurationView(keys: missingConfigurationKeys)
        }
    }

    private func handleOpenURL(_ url: URL) {
        if let request = PathwaySystemRequest(workURL: url) {
            PathwaySystemEntry.shared.request = request
            return
        }
        if let link = PathwayProductLink(url: url, allowedWebHost: AppConfiguration.siteURL?.host()) {
            appModel?.openProductLink(link)
            return
        }
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
