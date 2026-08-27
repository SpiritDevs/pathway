import SwiftUI

struct SettingsRootContent: View {
    let phase: SettingsCatalogPhase
    let catalog: MobileSettingsCatalog?
    let destinations: [SettingsDestinationSearchItem]
    @Binding var searchText: String
    let locale: Locale
    let cloudFrontSignature: CompanyAssetCloudFrontSignature?
    let currentProfileColor: String?
    let onSelect: (SettingsRoute) -> Void
    let onRetry: () -> Void

    init(
        phase: SettingsCatalogPhase,
        catalog: MobileSettingsCatalog?,
        destinations: [SettingsDestinationSearchItem],
        searchText: Binding<String>,
        locale: Locale = .autoupdatingCurrent,
        cloudFrontSignature: CompanyAssetCloudFrontSignature? = nil,
        currentProfileColor: String? = nil,
        onSelect: @escaping (SettingsRoute) -> Void,
        onRetry: @escaping () -> Void
    ) {
        self.phase = phase
        self.catalog = catalog
        self.destinations = destinations
        _searchText = searchText
        self.locale = locale
        self.cloudFrontSignature = cloudFrontSignature
        self.currentProfileColor = currentProfileColor
        self.onSelect = onSelect
        self.onRetry = onRetry
    }

    var body: some View {
        Group {
            switch phase {
            case .idle, .loading:
                SettingsLoadingView()
            case let .failed(message):
                SettingsErrorView(
                    title: "Settings Unavailable",
                    message: message,
                    onRetry: onRetry
                )
            case .loaded:
                loadedContent
            }
        }
        .navigationTitle("Settings")
        .searchable(
            text: $searchText,
            placement: .navigationBarDrawer(displayMode: .automatic),
            prompt: "Search Settings"
        )
    }

    @ViewBuilder
    private var loadedContent: some View {
        if let catalog {
            let rows = destinations.filter { item in
                !searchText.isEmpty || item.route != .profile
            }
            if rows.isEmpty, !searchText.isEmpty {
                SettingsEmptyView(isSearching: true)
            } else {
                List {
                    if searchText.isEmpty {
                        Section {
                            SettingsProfileCard(
                                identity: catalog.identity,
                                workspace: catalog.workspace,
                                roleNames: catalog.roleNames,
                                cloudFrontSignature: cloudFrontSignature,
                                profileColor: catalog.identity.profileColor ?? currentProfileColor,
                                onSelect: { onSelect(.profile) }
                            )
                            .listRowInsets(.init(top: 10, leading: 16, bottom: 10, trailing: 16))
                        }
                    }

                    ForEach(visibleSections, id: \.self) { section in
                        let sectionRows = rows.filter { $0.section == section }
                        if !sectionRows.isEmpty {
                            Section(section.settingsTitle(locale: locale)) {
                                ForEach(sectionRows) { item in
                                    SettingsRow(item: item, locale: locale) {
                                        onSelect(item.route)
                                    }
                                }
                            }
                        }
                    }
                }
                .listStyle(.insetGrouped)
                .listSectionSpacing(.compact)
                .environment(\.defaultMinListRowHeight, 1)
            }
        } else {
            SettingsEmptyView(isSearching: !searchText.isEmpty)
        }
    }

    private var visibleSections: [MobileSettingsCatalog.Section] {
        MobileSettingsCatalog.Section.allCases.filter { section in
            destinations.contains { $0.route != .profile && $0.section == section }
        }
    }
}
