import SwiftUI
import UIKit

struct SettingsProfileCard: View {
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    let identity: MobileSettingsCatalog.Identity
    let workspace: MobileSettingsCatalog.Workspace
    let roleNames: [String]
    let cloudFrontSignature: CompanyAssetCloudFrontSignature?
    let profileColor: String?
    let onSelect: () -> Void

    var body: some View {
        Button(action: onSelect) {
            Group {
                if dynamicTypeSize.isAccessibilitySize {
                    VStack(alignment: .leading, spacing: 12) {
                        HStack {
                            avatar
                            Spacer(minLength: 8)
                            chevron
                        }
                        identityLabels
                    }
                    .padding(.vertical, 6)
                } else {
                    HStack(spacing: 16) {
                        avatar
                        identityLabels
                        Spacer(minLength: 8)
                        chevron
                    }
                }
            }
            .frame(minHeight: 76)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Profile for \(identity.displayName), \(identity.email), \(contextLine)")
        .accessibilityHint("Opens your profile settings")
    }

    private var contextLine: String {
        let roles = roleNames.prefix(2).joined(separator: ", ")
        return roles.isEmpty ? workspace.companyName : "\(workspace.companyName) · \(roles)"
    }

    private var avatar: some View {
        SettingsAvatar(
            initials: identity.initials,
            imageURL: identity.profileImage,
            profileColor: profileColor,
            userID: identity.userId,
            companyID: workspace.companyId,
            cloudFrontSignature: cloudFrontSignature,
            size: 62
        )
    }

    private var identityLabels: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(identity.displayName)
                .font(.title3.weight(.semibold))
                .foregroundStyle(.primary)
            Text(identity.email)
                .font(.subheadline)
                .foregroundStyle(.secondary)
            Text(contextLine)
                .font(.caption.weight(.medium))
                .foregroundStyle(.secondary)
        }
        .lineLimit(dynamicTypeSize.isAccessibilitySize ? nil : 1)
    }

    private var chevron: some View {
        Image(systemName: "chevron.forward")
            .font(.footnote.weight(.semibold))
            .foregroundStyle(.tertiary)
            .accessibilityHidden(true)
    }
}

struct SettingsRow: View {
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    let item: SettingsDestinationSearchItem
    let locale: Locale
    let onSelect: () -> Void

    init(
        item: SettingsDestinationSearchItem,
        locale: Locale = .autoupdatingCurrent,
        onSelect: @escaping () -> Void
    ) {
        self.item = item
        self.locale = locale
        self.onSelect = onSelect
    }

    var body: some View {
        Button(action: onSelect) {
            HStack(spacing: 12) {
                SettingsSymbol(route: item.route)

                VStack(alignment: .leading, spacing: 2) {
                    Text(item.title)
                        .font(.body)
                        .foregroundStyle(item.route == .logout ? .red : .primary)
                        .frame(maxWidth: .infinity, alignment: .leading)

                    if let subtitle = item.route.settingsSubtitle(locale: locale) {
                        Text(subtitle)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(dynamicTypeSize.isAccessibilitySize ? nil : 1)
                    }
                }

                if item.availability.isLocked {
                    Image(systemName: "lock.fill")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .accessibilityHidden(true)
                }

                if item.route != .logout {
                    Image(systemName: "chevron.forward")
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(.tertiary)
                        .accessibilityHidden(true)
                }
            }
            .frame(minHeight: dynamicTypeSize.isAccessibilitySize ? 58 : 50)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .listRowInsets(.init(top: 4, leading: 16, bottom: 4, trailing: 16))
        .alignmentGuide(.listRowSeparatorLeading) { _ in 44 }
        .accessibilityLabel(accessibilityLabel)
        .accessibilityHint(accessibilityHint)
    }

    private var accessibilityLabel: String {
        guard let subtitle = item.route.settingsSubtitle(locale: locale) else { return item.title }
        return "\(item.title), \(subtitle)"
    }

    private var accessibilityHint: String {
        if item.availability.isLocked {
            return "Requires an add-on. Opens details."
        }
        if item.route == .logout {
            return "Signs you out of Pathway"
        }
        return "Opens \(item.title) settings"
    }
}

struct SettingsSymbol: View {
    let systemName: String
    let color: Color

    init(route: SettingsRoute) {
        systemName = route.settingsSymbolName
        color = route.settingsSymbolColor
    }

    init(systemName: String, color: Color = .accentColor) {
        self.systemName = systemName
        self.color = color
    }

    var body: some View {
        Image(systemName: systemName)
            .font(.system(size: 14, weight: .semibold))
            .symbolRenderingMode(.monochrome)
            .foregroundStyle(.white)
            .frame(width: 29, height: 29)
            .background(color, in: RoundedRectangle(cornerRadius: 7, style: .continuous))
            .accessibilityHidden(true)
    }
}

struct SettingsIconLabel: View {
    let title: String
    let systemName: String
    let color: Color

    init(_ title: String, systemName: String, color: Color = .accentColor) {
        self.title = title
        self.systemName = systemName
        self.color = color
    }

    var body: some View {
        HStack(spacing: 12) {
            SettingsSymbol(systemName: systemName, color: color)
            Text(title)
        }
    }
}

extension SettingsRoute {
    var settingsSymbolColor: Color {
        switch self {
        case .profile, .device, .security, .api:
            .blue
        case .company, .users, .teams, .roles:
            .indigo
        case .fonts, .emailTemplates, .emailSetup, .deliveryRules:
            .orange
        case .billing, .addons:
            .green
        case .salesforce, .integrations:
            .cyan
        case .support:
            .purple
        case .about:
            .gray
        case .customDataItems:
            .teal
        case .dataRetention, .logout:
            .red
        }
    }
}

struct SettingsAvatar: View {
    let initials: String
    let imageURL: String?
    let profileColor: String?
    let userID: String
    let companyID: String
    let cloudFrontSignature: CompanyAssetCloudFrontSignature?
    let size: CGFloat

    var body: some View {
        ZStack {
            fallback

            if let inlineProfileImage {
                Image(uiImage: inlineProfileImage)
                    .resizable()
                    .scaledToFill()
            } else if let url = profileImageURL {
                AsyncImage(url: url) { phase in
                    if let image = phase.image {
                        image.resizable().scaledToFill()
                    }
                }
            }
        }
        .frame(width: size, height: size)
        .clipShape(Circle())
        .overlay {
            Circle().stroke(resolvedProfileColor.opacity(0.8), lineWidth: 1.5)
        }
        .accessibilityHidden(true)
    }

    private var inlineProfileImage: UIImage? {
        guard
            let imageURL,
            imageURL.hasPrefix("data:image/"),
            let commaIndex = imageURL.firstIndex(of: ","),
            let data = Data(base64Encoded: String(imageURL[imageURL.index(after: commaIndex)...]))
        else {
            return nil
        }
        return UIImage(data: data)
    }

    private var profileImageURL: URL? {
        guard
            let imageURL = imageURL?.trimmingCharacters(in: .whitespacesAndNewlines),
            !imageURL.isEmpty,
            !imageURL.hasPrefix("data:image/")
        else {
            return nil
        }

        if imageURL.hasPrefix("https://") {
            return URL(string: imageURL)
        }
        if imageURL.hasPrefix("http://") {
            return nil
        }

        guard
            let cloudFrontSignature,
            cloudFrontSignature.isUsable,
            var url = URL(string: cloudFrontSignature.baseUrl)
        else {
            return nil
        }

        url.append(path: "company")
        url.append(path: companyID)
        url.append(path: "user")
        url.append(path: userID)
        url.append(path: "profile")
        url.append(path: imageURL)

        var components = URLComponents(url: url, resolvingAgainstBaseURL: false)
        components?.queryItems = [
            URLQueryItem(name: "Policy", value: cloudFrontSignature.policy),
            URLQueryItem(name: "Key-Pair-Id", value: cloudFrontSignature.keyPairId),
            URLQueryItem(name: "Signature", value: cloudFrontSignature.signature)
        ]
        return components?.url
    }

    private var fallback: some View {
        Circle()
            .fill(resolvedProfileColor)
            .overlay {
                Text(initials)
                    .font(.system(size: size * 0.34, weight: .semibold, design: .rounded))
                    .foregroundStyle(.white)
            }
    }

    private var resolvedProfileColor: Color {
        let colors = [
            "slate": "475569", "gray": "4B5563", "zinc": "52525B", "neutral": "525252",
            "stone": "57534E", "red": "DC2626", "orange": "EA580C", "amber": "D97706",
            "yellow": "CA8A04", "lime": "65A30D", "green": "16A34A", "emerald": "059669",
            "teal": "0D9488", "cyan": "0891B2", "sky": "0284C7", "blue": "2563EB",
            "indigo": "4F46E5", "violet": "7C3AED", "purple": "9333EA", "fuchsia": "C026D3",
            "pink": "DB2777", "rose": "E11D48"
        ]
        guard let profileColor else { return Color(hex: "EA580C") }
        if profileColor.hasPrefix("#") {
            return Color(hex: profileColor)
        }
        return Color(hex: colors[profileColor] ?? "EA580C")
    }
}
