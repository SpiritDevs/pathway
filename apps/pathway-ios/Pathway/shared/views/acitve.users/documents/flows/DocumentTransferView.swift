import SwiftUI

struct DocumentTransferView: View {
    @Environment(PathwayAppModel.self) private var appModel
    @Environment(\.dismiss) private var dismiss

    let document: DashboardDocument

    @State private var searchText = ""
    @State private var selectedUser: MobileDashboardBootstrap.CompanyUser?
    @State private var currentOwnerID: String?
    @State private var unavailableReason: String?
    @State private var isLoading = true
    @State private var isTransferring = false
    @State private var errorMessage: String?

    private var eligibleUsers: [MobileDashboardBootstrap.CompanyUser] {
        (appModel.dashboardBootstrap?.assignableCompanyUsers ?? [])
            .filter { $0.id != currentOwnerID }
            .filter {
                searchText.isEmpty ||
                    $0.displayName.localizedCaseInsensitiveContains(searchText) ||
                    ($0.email?.localizedCaseInsensitiveContains(searchText) ?? false)
            }
            .sorted { $0.displayName.localizedCaseInsensitiveCompare($1.displayName) == .orderedAscending }
    }

    var body: some View {
        Group {
            if isLoading {
                ProgressView("Loading eligible users…")
            } else if let unavailableReason {
                ContentUnavailableView(
                    "Transfer Unavailable",
                    systemImage: "person.crop.circle.badge.xmark",
                    description: Text(unavailableReason)
                )
            } else if eligibleUsers.isEmpty && searchText.isEmpty {
                ContentUnavailableView(
                    "No Eligible Users",
                    systemImage: "person.crop.circle.badge.xmark",
                    description: Text("There is nobody available to receive this document.")
                )
            } else {
                List(eligibleUsers) { user in
                    Button {
                        selectedUser = user
                    } label: {
                        HStack(spacing: 12) {
                            UserInitialsView(user: user)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(user.displayName)
                                    .foregroundStyle(.primary)
                                if let email = user.email {
                                    Text(email)
                                        .font(.subheadline)
                                        .foregroundStyle(.secondary)
                                }
                            }
                            Spacer()
                            Image(systemName: "chevron.right")
                                .foregroundStyle(.tertiary)
                        }
                    }
                    .disabled(isTransferring)
                    .accessibilityIdentifier("transfer-user-\(user.id)")
                }
                .listStyle(.insetGrouped)
                .searchable(text: $searchText, prompt: "Search people")
            }
        }
        .navigationTitle("Transfer Document")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("Cancel") { dismiss() }
                    .disabled(isTransferring)
            }
        }
        .task { await loadOwner() }
        .confirmationDialog(
            "Transfer to \(selectedUser?.displayName ?? "this user")?",
            isPresented: Binding(
                get: { selectedUser != nil },
                set: { if !$0 { selectedUser = nil } }
            ),
            titleVisibility: .visible
        ) {
            Button("Transfer Document", role: .destructive) {
                guard let selectedUser else { return }
                transfer(to: selectedUser)
            }
            Button("Cancel", role: .cancel) { selectedUser = nil }
        } message: {
            Text("Ownership of “\(document.title)” will move immediately. You may lose access afterward.")
        }
        .alert("Transfer Failed", isPresented: .constant(errorMessage != nil)) {
            Button("OK") { errorMessage = nil }
        } message: {
            Text(errorMessage ?? "The document could not be transferred.")
        }
    }

    private func loadOwner() async {
        defer { isLoading = false }
        do {
            let information = try await appModel.documentService.information(documentID: document.id)
            currentOwnerID = information.ownerUserId
            if !information.canEdit {
                unavailableReason = "You need edit access to transfer this document."
            } else if appModel.dashboardBootstrap?.assignableCompanyUsers?.isEmpty != false {
                unavailableReason = "There is nobody eligible to receive this document."
            }
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func transfer(to user: MobileDashboardBootstrap.CompanyUser) {
        isTransferring = true
        Task {
            defer { isTransferring = false }
            do {
                try await appModel.documentService.transfer(documentID: document.id, ownerUserID: user.id)
                dismiss()
            } catch {
                selectedUser = nil
                errorMessage = error.localizedDescription
            }
        }
    }
}

private struct UserInitialsView: View {
    let user: MobileDashboardBootstrap.CompanyUser

    var body: some View {
        ZStack {
            Circle().fill(.tint.opacity(0.15))
            Text(initials)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(.tint)
        }
        .frame(width: 42, height: 42)
        .accessibilityHidden(true)
    }

    private var initials: String {
        let initials = [user.firstName, user.lastName]
            .compactMap(\.?.first)
            .map(String.init)
            .joined()
            .uppercased()
        return initials.isEmpty ? "QC" : initials
    }
}
