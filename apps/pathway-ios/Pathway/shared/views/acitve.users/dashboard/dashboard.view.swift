import SwiftUI
import UIKit

private enum DocumentQuickFilter: String, CaseIterable, Identifiable {
    case all
    case creating
    case review
    case sent
    case delivered
    case accepted

    var id: String { rawValue }

    var title: String {
        switch self {
        case .all: "All"
        case .creating: "Creating"
        case .review: "In Review"
        case .sent: "Sent"
        case .delivered: "Delivered"
        case .accepted: "Accepted"
        }
    }

    var systemImage: String {
        switch self {
        case .all: "doc.on.doc"
        case .creating: "square.and.pencil"
        case .review: "eye"
        case .sent: "paperplane.fill"
        case .delivered: "checkmark.seal.fill"
        case .accepted: "hand.thumbsup.fill"
        }
    }

    func includes(_ document: DashboardDocument) -> Bool {
        switch self {
        case .all:
            true
        case .creating:
            document.status == "creating" || document.status == "revising"
        case .review:
            document.status == "workflow_review_requested" ||
                document.status == "workflow_review_accepted"
        case .sent:
            document.status == "sent" ||
                document.status == "pending_sent" ||
                document.status == "scheduled_send"
        case .delivered:
            document.status == "delivered" || document.status == "delivery_delayed"
        case .accepted:
            document.status == "accepted" || document.status == "signing_complete"
        }
    }
}

private enum DashboardSheetDestination: Identifiable {
    case trial(MobileTrialStatus)
    case settings

    var id: String {
        switch self {
        case .trial: "trial"
        case .settings: "settings"
        }
    }
}

struct DashboardView: View {
    @Environment(PathwayAppModel.self) private var appModel
    @State private var selectedFilter = DocumentQuickFilter.all
    @State private var presentedSheet: DashboardSheetDestination?

    private var filteredDocuments: [DashboardDocument] {
        appModel.documents.filter(selectedFilter.includes)
    }

    private var trialStatus: MobileTrialStatus? {
        MobileTrialStatus(bootstrap: appModel.dashboardBootstrap)
    }

    var body: some View {
        VStack(spacing: 0) {
            DocumentsHeader(
                selectedFilter: $selectedFilter,
                user: appModel.dashboardBootstrap?.userData,
                company: appModel.dashboardBootstrap?.companyData,
                cloudFrontSignature: appModel.companyAssetSignature,
                trial: trialStatus,
                showTrial: { presentedSheet = .trial($0) },
                showSettings: { presentedSheet = .settings }
            )

            if let errorMessage = appModel.dashboardErrorMessage {
                ContentUnavailableView(
                    "Unable to Load Dashboard",
                    systemImage: "exclamationmark.triangle",
                    description: Text(errorMessage)
                )
            } else if appModel.dashboardBootstrap == nil, appModel.documents.isEmpty {
                ProgressView("Connecting to Pathway…")
                    .padding(.top, 20)
            } else if appModel.documents.isEmpty {
                ContentUnavailableView(
                    "No Documents",
                    systemImage: "doc.text",
                    description: Text("Documents will appear here as soon as they are created.")
                )
            } else if filteredDocuments.isEmpty {
                ContentUnavailableView {
                    Label("No \(selectedFilter.title) Documents", systemImage: selectedFilter.systemImage)
                } description: {
                    Text("Choose another filter to see more documents.")
                } actions: {
                    Button("Show All") {
                        selectedFilter = .all
                    }
                }
            } else {
                DocumentInteractiveList(documents: filteredDocuments)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .background(Color(uiColor: .systemBackground))
        .toolbar(.hidden, for: .navigationBar)
        .sheet(item: $presentedSheet) { destination in
            switch destination {
            case .trial(let trial):
                TrialSubscriptionSheet(trial: trial)
            case .settings:
                SettingsSheet()
                    .presentationDetents([.large])
                    .presentationDragIndicator(.visible)
            }
        }
    }
}

private struct DocumentsHeader: View {
    @Binding var selectedFilter: DocumentQuickFilter

    let user: MobileDashboardBootstrap.UserData?
    let company: MobileDashboardBootstrap.CompanyData?
    let cloudFrontSignature: CompanyAssetCloudFrontSignature?
    let trial: MobileTrialStatus?
    let showTrial: (MobileTrialStatus) -> Void
    let showSettings: () -> Void

    var body: some View {
        VStack(spacing: 2) {
            HStack(alignment: .center, spacing: 12) {
                Text("Documents")
                    .font(.title2.bold())
                    .tracking(-0.4)

                Spacer(minLength: 12)

                if let trial {
                    TrialCountdownButton(trial: trial) {
                        showTrial(trial)
                    }
                }

                Menu {
                    ForEach(DocumentQuickFilter.allCases) { filter in
                        Button {
                            withAnimation(.easeOut(duration: 0.18)) {
                                selectedFilter = filter
                            }
                        } label: {
                            Label(
                                filter.title,
                                systemImage: selectedFilter == filter ? "checkmark" : filter.systemImage
                            )
                        }
                    }
                } label: {
                    Image(systemName: "line.3.horizontal.decrease")
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(Color.primary)
                        .frame(width: 32, height: 32)
                        .background(Color(uiColor: .secondarySystemBackground), in: Circle())
                }
                .accessibilityLabel("Filter documents")

                Button(action: showSettings) {
                    UserProfileAvatar(
                        user: user,
                        company: company,
                        cloudFrontSignature: cloudFrontSignature
                    )
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Open profile and settings for \(user?.displayName ?? "Pathway user")")
            }
            .padding(.horizontal, 16)
            .padding(.top, 6)

            ScrollView(.horizontal, showsIndicators: false) {
                LazyHStack(spacing: 6) {
                    ForEach(DocumentQuickFilter.allCases) { filter in
                        DocumentFilterChip(
                            filter: filter,
                            isSelected: selectedFilter == filter
                        ) {
                            withAnimation(.easeOut(duration: 0.18)) {
                                selectedFilter = filter
                            }
                        }
                    }
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 8)
            }
            .scrollClipDisabled()
            .frame(height: 44)
        }
        .background(Color(uiColor: .systemBackground))
        .overlay(alignment: .bottom) {
            Divider()
        }
    }
}

private struct DocumentFilterChip: View {
    let filter: DocumentQuickFilter
    let isSelected: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Label(filter.title, systemImage: filter.systemImage)
                .font(.caption.weight(.semibold))
                .lineLimit(1)
                .padding(.horizontal, 9)
                .frame(height: 26)
                .foregroundStyle(isSelected ? Color.white : Color.primary)
                .background {
                    Capsule()
                        .fill(isSelected ? Color.accentColor : Color(uiColor: .secondarySystemBackground))
                }
                .overlay {
                    Capsule()
                        .stroke(Color.primary.opacity(isSelected ? 0 : 0.07), lineWidth: 1)
                }
                .shadow(color: .black.opacity(isSelected ? 0.1 : 0.06), radius: 4, y: 1)
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }
}

private struct UserProfileAvatar: View {
    let user: MobileDashboardBootstrap.UserData?
    let company: MobileDashboardBootstrap.CompanyData?
    let cloudFrontSignature: CompanyAssetCloudFrontSignature?

    private var profileImageURL: URL? {
        guard let user, let company else { return nil }
        return user.profileImageURL(
            companyID: company.id,
            cloudFrontSignature: cloudFrontSignature
        )
    }

    private var inlineProfileImage: UIImage? {
        guard
            let profileImage = user?.profileImage,
            profileImage.hasPrefix("data:image/"),
            let commaIndex = profileImage.firstIndex(of: ","),
            let data = Data(base64Encoded: String(profileImage[profileImage.index(after: commaIndex)...]))
        else {
            return nil
        }
        return UIImage(data: data)
    }

    private var profileColor: Color {
        let colors = [
            "slate": "475569", "gray": "4B5563", "zinc": "52525B", "neutral": "525252",
            "stone": "57534E", "red": "DC2626", "orange": "EA580C", "amber": "D97706",
            "yellow": "CA8A04", "lime": "65A30D", "green": "16A34A", "emerald": "059669",
            "teal": "0D9488", "cyan": "0891B2", "sky": "0284C7", "blue": "2563EB",
            "indigo": "4F46E5", "violet": "7C3AED", "purple": "9333EA", "fuchsia": "C026D3",
            "pink": "DB2777", "rose": "E11D48"
        ]
        return Color(hex: colors[user?.profileColor ?? "orange"] ?? "EA580C")
    }

    var body: some View {
        ZStack {
            fallback

            if let inlineProfileImage {
                Image(uiImage: inlineProfileImage)
                    .resizable()
                    .scaledToFill()
            } else if let profileImageURL {
                AsyncImage(url: profileImageURL) { phase in
                    if let image = phase.image {
                        image
                            .resizable()
                            .scaledToFill()
                    }
                }
            }
        }
        .frame(width: 32, height: 32)
        .clipShape(Circle())
        .overlay {
            Circle()
                .stroke(profileColor.opacity(0.8), lineWidth: 1.5)
        }
        .contentShape(Circle())
    }

    private var fallback: some View {
        Circle()
            .fill(profileColor)
            .overlay {
                Text(user?.initials ?? "QC")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.white)
            }
    }
}

struct DocumentRow: View {
    let document: DashboardDocument

    private var statusStyle: DocumentStatusStyle {
        DocumentStatusStyle(status: document.status)
    }

    private var recipient: String {
        document.recipientName.isEmpty ? document.mainRecipientEmail : document.recipientName
    }

    private var amountText: String? {
        guard let totalValue = document.totalValue else { return nil }
        return "\(document.currencySymbol)\(totalValue.formatted(.number.precision(.fractionLength(2))))"
    }

    private var totalLabel: String {
        amountText.map { "Total \($0)" } ?? "No value"
    }

    private var modifiedText: String? {
        guard let value = document.modifiedDate else { return nil }
        let fractionalStyle = Date.ISO8601FormatStyle(includingFractionalSeconds: true)
        let standardStyle = Date.ISO8601FormatStyle()
        guard let date = (try? fractionalStyle.parse(value)) ?? (try? standardStyle.parse(value)) else {
            return nil
        }
        return date.formatted(.relative(presentation: .named, unitsStyle: .abbreviated))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(document.title)
                    .font(.subheadline.weight(.semibold))
                    .lineLimit(1)

                Spacer(minLength: 8)

                Text(totalLabel)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(amountText == nil ? Color.secondary : Color.primary)
                    .monospacedDigit()
                    .lineLimit(1)
                    .padding(.horizontal, 7)
                    .frame(height: 22)
                    .background(Color(uiColor: .secondarySystemBackground), in: Capsule())
                    .fixedSize(horizontal: true, vertical: false)
            }

            HStack(spacing: 5) {
                Text("#\(document.displayId)")
                    .font(.caption.monospacedDigit().weight(.medium))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)

                if let subtitle = document.subtitle, !subtitle.isEmpty {
                    Text("·")
                        .foregroundStyle(.tertiary)

                    Text(subtitle)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }

            HStack(spacing: 8) {
                HStack(spacing: 4) {
                    Image(systemName: statusStyle.systemImage)
                        .accessibilityHidden(true)

                    Text(statusStyle.title)
                }
                .font(.caption2.weight(.semibold))
                .foregroundStyle(statusStyle.tint)
                .padding(.horizontal, 7)
                .frame(height: 20)
                .background(statusStyle.tint.opacity(0.12), in: Capsule())
                .fixedSize(horizontal: true, vertical: false)

                if !recipient.isEmpty {
                    HStack(spacing: 4) {
                        Image(systemName: "person")
                            .accessibilityHidden(true)

                        Text(recipient)
                    }
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }

                Spacer(minLength: 4)

                if let modifiedText {
                    Text(modifiedText)
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                        .lineLimit(1)
                        .fixedSize(horizontal: true, vertical: false)
                        .layoutPriority(1)
                }
            }
        }
        .contentShape(Rectangle())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilitySummary)
    }

    private var accessibilitySummary: String {
        var details = [
            document.title,
            "Document \(document.displayId)",
            statusStyle.title
        ]
        if !recipient.isEmpty { details.append("Recipient \(recipient)") }
        details.append(amountText.map { "Total \($0)" } ?? "No value")
        if let modifiedText { details.append("Modified \(modifiedText)") }
        return details.joined(separator: ", ")
    }
}

private struct DocumentStatusStyle {
    let title: String
    let systemImage: String
    let tint: Color

    init(status: String) {
        switch status {
        case "creating", "revising":
            (title, systemImage, tint) = (status == "creating" ? "Creating" : "Revising", "pencil", .orange)
        case "workflow_review_requested":
            (title, systemImage, tint) = ("In review", "eye.fill", .indigo)
        case "workflow_review_accepted":
            (title, systemImage, tint) = ("Review approved", "checkmark.circle.fill", .teal)
        case "pending_sent":
            (title, systemImage, tint) = ("Sending", "arrow.up.circle.fill", .blue)
        case "scheduled_send":
            (title, systemImage, tint) = ("Scheduled", "clock.fill", .blue)
        case "sent":
            (title, systemImage, tint) = ("Sent", "paperplane.fill", .blue)
        case "opened":
            (title, systemImage, tint) = ("Opened", "eye.fill", .cyan)
        case "delivered":
            (title, systemImage, tint) = ("Delivered", "checkmark.circle.fill", .teal)
        case "signing":
            (title, systemImage, tint) = ("Signing", "signature", .purple)
        case "signing_complete":
            (title, systemImage, tint) = ("Signed", "checkmark.seal.fill", .green)
        case "accepted":
            (title, systemImage, tint) = ("Accepted", "hand.thumbsup.fill", .green)
        case "paid":
            (title, systemImage, tint) = ("Paid", "checkmark.circle.fill", .green)
        case "part_paid":
            (title, systemImage, tint) = ("Part paid", "circle.lefthalf.filled", .mint)
        case "delivery_delayed", "alert", "email_complained", "email_bounced", "send_failed":
            (title, systemImage, tint) = (
                status.replacingOccurrences(of: "_", with: " ").capitalized,
                "exclamationmark.triangle.fill",
                .red
            )
        case "lost", "expired":
            (title, systemImage, tint) = (
                status.capitalized,
                status == "expired" ? "clock.badge.exclamationmark" : "xmark.circle.fill",
                .secondary
            )
        case "template", "system_template":
            (title, systemImage, tint) = ("Template", "doc.on.doc.fill", .purple)
        default:
            (title, systemImage, tint) = (
                status.replacingOccurrences(of: "_", with: " ").capitalized,
                "circle.fill",
                .secondary
            )
        }
    }
}
