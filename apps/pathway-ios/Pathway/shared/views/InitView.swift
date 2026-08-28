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
                    MainTabView()
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
