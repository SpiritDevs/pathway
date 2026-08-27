import SwiftUI

struct LoginView: View {
    @Environment(PathwayAppModel.self) private var appModel

    private var isSigningIn: Bool {
        appModel.authenticationState == .signingIn
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 20) {
                Spacer()

                Image("pathway-logo-small")
                    .resizable()
                    .scaledToFit()
                    .frame(width: 110, height: 110)
                    .clipShape(.rect(cornerRadius: 12))
                    .accessibilityHidden(true)

                VStack(spacing: 6) {
                    Text("Welcome")
                        .font(.largeTitle.bold())
                    Text("Log in to continue to Pathway")
                        .foregroundStyle(.secondary)
                }

                Text("Use the same Pathway account as the web and desktop apps. Clerk handles your configured sign-in methods, verification, and account recovery.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)

                if let message = appModel.authenticationErrorMessage {
                    Text(message)
                        .font(.footnote)
                        .foregroundStyle(.red)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .accessibilityLabel("Login error: \(message)")
                }

                Spacer()

                Button(action: signIn) {
                    Group {
                        if isSigningIn {
                            ProgressView()
                        } else {
                            Text("Continue with Pathway")
                        }
                    }
                    .frame(maxWidth: .infinity)
                    .padding()
                }
                .buttonStyle(.borderedProminent)
                .disabled(isSigningIn)
            }
            .padding()
        }
    }

    private func signIn() {
        guard !isSigningIn else { return }
        Task {
            await appModel.signIn()
        }
    }
}
