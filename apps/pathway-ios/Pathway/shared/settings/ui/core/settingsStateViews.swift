import SwiftUI

struct SettingsLoadingView: View {
    var body: some View {
        List {
            Section {
                HStack(spacing: 14) {
                    Circle().frame(width: 58, height: 58)
                    VStack(alignment: .leading, spacing: 7) {
                        Text("Profile name placeholder")
                        Text("Email placeholder")
                            .font(.subheadline)
                    }
                }
                .frame(minHeight: 68)
            }

            ForEach(0..<3, id: \.self) { section in
                Section {
                    ForEach(0..<2, id: \.self) { row in
                        Label("Settings item \(section)-\(row)", systemImage: "gearshape")
                    }
                }
            }
        }
        .listStyle(.insetGrouped)
        .redacted(reason: .placeholder)
        .allowsHitTesting(false)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Loading settings")
    }
}

struct SettingsErrorView: View {
    let title: String
    let message: String
    let onRetry: () -> Void

    var body: some View {
        ContentUnavailableView {
            Label(title, systemImage: "exclamationmark.triangle")
        } description: {
            Text(message)
        } actions: {
            Button("Try Again", action: onRetry)
                .buttonStyle(.borderedProminent)
        }
    }
}

struct SettingsEmptyView: View {
    let isSearching: Bool

    var body: some View {
        if isSearching {
            ContentUnavailableView.search
        } else {
            ContentUnavailableView(
                "No Settings Available",
                systemImage: "gearshape",
                description: Text("There are no settings available for this account.")
            )
        }
    }
}

struct SettingsLockedFeatureView: View {
    let item: SettingsDestinationSearchItem
    var onOpenAddons: (() -> Void)?

    init(
        item: SettingsDestinationSearchItem,
        onOpenAddons: (() -> Void)? = nil
    ) {
        self.item = item
        self.onOpenAddons = onOpenAddons
    }

    var body: some View {
        ContentUnavailableView {
            Label(item.title, systemImage: "lock.fill")
        } description: {
            if let addonCode = item.availability.requiredAddonCode {
                Text("This setting is available when the \(addonCode) add-on is active for your company.")
            } else {
                Text("This setting is not currently available for your company.")
            }
        } actions: {
            if let onOpenAddons {
                Button("View Add-ons", action: onOpenAddons)
                    .buttonStyle(.borderedProminent)
            }
        }
        .navigationTitle(item.title)
        .navigationBarTitleDisplayMode(.inline)
    }
}
