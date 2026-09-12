import SwiftUI

struct LoginView: View {
    @Environment(\.scenePhase) private var scenePhase
    @Environment(PathwayAppModel.self) private var appModel

    private var isSigningIn: Bool {
        appModel.authenticationState == .signingIn
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 24) {
                    Image("pathway-logo-small")
                        .resizable()
                        .scaledToFit()
                        .frame(width: 110, height: 110)
                        .clipShape(.rect(cornerRadius: 28))
                        .accessibilityHidden(true)

                    VStack(spacing: 8) {
                        Text("Welcome")
                            .font(.largeTitle.bold())
                        Text("Log in to continue to Pathway")
                            .foregroundStyle(.secondary)
                    }
                    .multilineTextAlignment(.center)

                    Text("Use the same Pathway account you use on the web and desktop.")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)

                    if let issue = appModel.authenticationIssue {
                        PathwayAuthenticationIssueView(issue: issue, automaticReportState: issue.errorCode == nil ? nil : appModel.loginReportState)
                    }
                }
                .frame(maxWidth: 480)
                .padding(24)
                .frame(maxWidth: .infinity)
            }
            .defaultScrollAnchor(.center, for: .alignment)
            .task(id: scenePhase) {
                if scenePhase == .active { await appModel.retryLoginReport() }
            }
            .safeAreaInset(edge: .bottom) {
                Button(action: signIn) {
                    HStack(spacing: 10) {
                        if isSigningIn {
                            ProgressView()
                            Text("Signing in…")
                        } else {
                            Text(appModel.authenticationIssue == nil ? "Continue with Pathway" : "Try again")
                        }
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 12)
                }
                .buttonStyle(.borderedProminent)
                .disabled(isSigningIn)
                .frame(maxWidth: 480)
                .padding()
                .frame(maxWidth: .infinity)
                .background(.background)
            }
        }
    }

    private func signIn() {
        guard !isSigningIn else { return }
        Task {
            await appModel.signIn()
        }
    }
}
