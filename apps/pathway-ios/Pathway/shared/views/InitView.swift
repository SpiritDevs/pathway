//
//  InitView.swift
//  Pathway
//
//  Created by Corey Baines on 20/11/2024.
//

import ClerkKit
import SwiftUI

struct InitView: View {
    @Environment(Clerk.self) private var clerk
    @Environment(PathwayAppModel.self) private var appModel

    var body: some View {
        Group {
            if !clerk.isLoaded {
                ProgressView()
                    .controlSize(.large)
                    .scaleEffect(1.5)
                    .accessibilityLabel("Loading Pathway")
            } else {
                switch appModel.authenticationState {
                case .restoring:
                    ProgressView()
                        .controlSize(.large)
                        .scaleEffect(1.5)
                        .accessibilityLabel("Loading Pathway")
                case .signedIn:
                    if appModel.isAccountReady {
                        MainTabView().id(appModel.localStorageDirectory)
                    } else if let message = appModel.authenticationErrorMessage {
                        ContentUnavailableView {
                            Label("Account unavailable", systemImage: "person.crop.circle.badge.exclamationmark")
                        } description: { Text(message) } actions: {
                            Button("Sign out") { Task { await appModel.signOut() } }
                        }
                    } else {
                        ProgressView("Preparing your workspace")
                    }
                case .signedOut, .signingIn:
                    LoginView()
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(.systemBackground))
        .task(id: clerk.isLoaded) {
            if clerk.isLoaded {
                await appModel.restoreSession()
            }
        }
    }
}
