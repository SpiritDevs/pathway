import SwiftUI

struct ForgottenPasswordView: View {
    @Environment(PathwayAppModel.self) private var appModel
    @Environment(\.dismiss) private var dismiss
    @State private var email: String
    @State private var isLoading = false
    @State private var alertMessage: String?

    init(initialEmail: String = "") {
        _email = State(initialValue: initialEmail)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Email address", text: $email)
                        .textInputAutocapitalization(.never)
                        .keyboardType(.emailAddress)
                        .textContentType(.emailAddress)
                        .submitLabel(.continue)
                        .onSubmit(requestReset)
                } footer: {
                    Text("If the address belongs to an account, Pathway will email password reset instructions.")
                }

                Section {
                    Button(action: requestReset) {
                        if isLoading {
                            ProgressView()
                                .frame(maxWidth: .infinity)
                        } else {
                            Text("Send Reset Instructions")
                                .frame(maxWidth: .infinity)
                        }
                    }
                    .disabled(!isValidEmail(email) || isLoading)
                }
            }
            .navigationTitle("Forgotten Password")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel", action: dismiss.callAsFunction)
                }
            }
            .alert("Password Reset", isPresented: Binding(
                get: { alertMessage != nil },
                set: { if !$0 { alertMessage = nil } }
            )) {
                Button("OK") {
                    alertMessage = nil
                    dismiss()
                }
            } message: {
                Text(alertMessage ?? "")
            }
        }
    }

    private func requestReset() {
        guard isValidEmail(email), !isLoading else { return }
        isLoading = true
        Task {
            defer { isLoading = false }
            do {
                alertMessage = try await appModel.requestPasswordReset(email: email)
            } catch {
                alertMessage = error.localizedDescription
            }
        }
    }
}
