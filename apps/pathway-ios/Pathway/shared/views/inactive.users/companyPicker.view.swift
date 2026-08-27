import SwiftUI

struct CompanyPickerView: View {
    @Environment(PathwayAppModel.self) private var appModel
    @State private var query = ""

    private var companies: [NativeCompanyPickerCompany] {
        guard let context = appModel.companyPickerContext else { return [] }
        let normalizedQuery = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()

        return context.companies
            .filter { company in
                normalizedQuery.isEmpty || [company.name, company.primaryTeamName]
                    .compactMap(\.self)
                    .contains { $0.lowercased().contains(normalizedQuery) } ||
                    company.roleNames.contains { $0.lowercased().contains(normalizedQuery) }
            }
            .sorted { left, right in
                if left.isSelectable != right.isSelectable {
                    return left.isSelectable
                }
                if left.lastSelectedAt != right.lastSelectedAt {
                    return (left.lastSelectedAt ?? 0) > (right.lastSelectedAt ?? 0)
                }
                return left.name.localizedCaseInsensitiveCompare(right.name) == .orderedAscending
            }
    }

    private var recentCompanyID: String? {
        appModel.companyPickerContext?.companies
            .filter { $0.isSelectable && $0.lastSelectedAt != nil }
            .max { ($0.lastSelectedAt ?? 0) < ($1.lastSelectedAt ?? 0) }?
            .companyId
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 24) {
                    Image("pathway-logo-small")
                        .resizable()
                        .scaledToFit()
                        .frame(width: 84, height: 84)
                        .clipShape(.rect(cornerRadius: 12))
                        .accessibilityHidden(true)

                    VStack(spacing: 8) {
                        Text("Choose a company")
                            .font(.title.bold())
                        if let email = appModel.companyPickerContext?.email {
                            Label("Signed in as \(email)", systemImage: "person")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                        }
                    }

                    if let message = appModel.authenticationErrorMessage {
                        Text(message)
                            .font(.footnote)
                            .foregroundStyle(.red)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding()
                            .background(.red.opacity(0.08), in: .rect(cornerRadius: 10))
                            .accessibilityLabel("Company selection error: \(message)")
                    }

                    LazyVStack(spacing: 10) {
                        ForEach(companies) { company in
                            CompanyPickerRow(
                                company: company,
                                isPending: appModel.pendingCompanyID == company.companyId,
                                isRecent: recentCompanyID == company.companyId,
                                selectionInProgress: appModel.pendingCompanyID != nil
                            ) {
                                Task {
                                    await appModel.chooseCompany(company.companyId)
                                }
                            }
                        }

                        if companies.isEmpty {
                            ContentUnavailableView.search(text: query)
                        }
                    }

                    Divider()

                    Button {
                        Task {
                            await appModel.signOut()
                        }
                    } label: {
                        Text("Use another account")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.large)
                    .disabled(appModel.pendingCompanyID != nil)
                }
                .frame(maxWidth: 560)
                .padding(24)
            }
            .searchable(
                text: $query,
                prompt: "Search companies"
            )
        }
        .tint(.orange)
    }
}

private struct CompanyPickerRow: View {
    let company: NativeCompanyPickerCompany
    let isPending: Bool
    let isRecent: Bool
    let selectionInProgress: Bool
    let action: () -> Void

    private var initials: String {
        let words = company.name.split(whereSeparator: \.isWhitespace)
        let initials = words.prefix(2).compactMap(\.first).map(String.init).joined()
        return initials.isEmpty ? "QC" : initials.uppercased()
    }

    var body: some View {
        Button(action: action) {
            HStack(spacing: 12) {
                Text(initials)
                    .font(.subheadline.bold())
                    .foregroundStyle(.orange)
                    .frame(width: 44, height: 44)
                    .background(.orange.opacity(0.1), in: .rect(cornerRadius: 10))

                VStack(alignment: .leading, spacing: 5) {
                    HStack(spacing: 8) {
                        Text(company.name)
                            .font(.subheadline.bold())
                            .foregroundStyle(.primary)
                            .lineLimit(1)
                        if isRecent {
                            Text("Recent")
                                .font(.caption2.weight(.medium))
                                .foregroundStyle(.orange)
                                .padding(.horizontal, 7)
                                .padding(.vertical, 3)
                                .background(.orange.opacity(0.1), in: .capsule)
                        }
                    }
                    Text(company.metadata)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }

                Spacer(minLength: 8)

                if let statusLabel = company.statusLabel {
                    Text(statusLabel)
                        .font(.caption2.weight(.medium))
                        .foregroundStyle(.secondary)
                        .padding(.horizontal, 7)
                        .padding(.vertical, 5)
                        .background(.quaternary, in: .rect(cornerRadius: 6))
                } else if isPending {
                    ProgressView()
                } else {
                    Image(systemName: "arrow.right")
                        .foregroundStyle(.tertiary)
                }
            }
            .padding(14)
            .background(Color(.secondarySystemBackground), in: .rect(cornerRadius: 12))
            .overlay {
                RoundedRectangle(cornerRadius: 12)
                    .stroke(.quaternary, lineWidth: 1)
            }
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .disabled(!company.isSelectable || selectionInProgress)
        .opacity(company.isSelectable && (!selectionInProgress || isPending) ? 1 : 0.65)
        .accessibilityLabel(
            company.isSelectable
                ? "Continue with \(company.name)"
                : "\(company.name), \(company.statusLabel ?? "unavailable")"
        )
    }
}
