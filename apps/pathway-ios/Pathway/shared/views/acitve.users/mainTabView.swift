//
//  mainTabView.swift
//  Pathway
//
//  Created by Corey Baines on 3/12/2024.
//

import SwiftUI

private let tabBarSpring = Animation.spring(duration: 0.48, bounce: 0.22)
private let tabSelectionSpring = Animation.spring(duration: 0.36, bounce: 0.14)
private let companySwitcherSpring = Animation.spring(duration: 0.42, bounce: 0.16)
private let compactTabBarHeight: CGFloat = 58

private enum AppDestination: String, CaseIterable, Identifiable, Hashable {
    case documents
    case leads
    case messages
    case contacts
    case libraries
    case templates
    case users
    case teams
    case search

    var id: Self { self }

    var title: String {
        switch self {
        case .documents: "Documents"
        case .leads: "Leads"
        case .messages: "Messages"
        case .contacts: "Contacts"
        case .libraries: "Libraries"
        case .templates: "Templates"
        case .users: "Users"
        case .teams: "Teams"
        case .search: "Search"
        }
    }

    var systemImage: String {
        switch self {
        case .documents: "doc"
        case .leads: "list.bullet"
        case .messages: "bubble.left.and.bubble.right"
        case .contacts: "person.crop.rectangle.stack"
        case .libraries: "folder"
        case .templates: "doc.richtext"
        case .users: "person.3"
        case .teams: "person.crop.square"
        case .search: "magnifyingglass"
        }
    }

    var isCompactDestination: Bool {
        self == .documents || self == .leads || self == .messages
    }

    @ViewBuilder
    var content: some View {
        switch self {
        case .documents:
            DashboardView()
        case .leads:
            LeadsView()
        case .messages:
            MessagesView()
        case .contacts:
            ContactsView()
        case .libraries:
            LibrariesView()
        case .templates:
            TemplatesView()
        case .users:
            UsersView()
        case .teams:
            TeamsView()
        case .search:
            GlobalSearchView()
        }
    }
}

private enum AppTab: Hashable {
    case destination(AppDestination)
}

private enum MainTabOverlay {
    case companySwitcher
}

private enum MainTabSheet: String, Identifiable {
    case agentOrchestrator

    var id: Self { self }
}

struct MainTabView: View {
    @Environment(PathwayAppModel.self) private var appModel

    @State private var selectedTab: AppTab = .destination(.documents)
    @State private var isMoreMenuPresented = false
    @State private var presentedOverlay: MainTabOverlay?
    @State private var presentedSheet: MainTabSheet?

    var body: some View {
        @Bindable var preferences = appModel.settingsDevicePreferences

        ZStack(alignment: .bottom) {
            selectedContent

            if isMoreMenuPresented {
                Color.clear
                    .contentShape(Rectangle())
                    .ignoresSafeArea()
                    .onTapGesture(perform: dismissMoreMenu)
            }

            PathwayTabBar(
                selectedTab: $selectedTab,
                isMoreMenuPresented: $isMoreMenuPresented,
                showAgentOrchestrator: presentAgentOrchestrator,
                showCompanySwitcher: {
                    withAnimation(companySwitcherSpring) {
                        presentedOverlay = .companySwitcher
                    }
                }
            )
            .frame(maxWidth: 520)
            .padding(.horizontal, 16)
            .padding(.bottom, 8)

            if presentedOverlay != nil {
                Color.black.opacity(0.12)
                    .ignoresSafeArea()
                    .contentShape(Rectangle())
                    .onTapGesture(perform: dismissCompanySwitcher)
                    .transition(.opacity)
                    .zIndex(10)

                CompanySwitcherCard(onDismiss: dismissCompanySwitcher)
                    .frame(maxWidth: 520)
                    .padding(.horizontal, 8)
                    .padding(.bottom, -28)
                    .transition(
                        .move(edge: .bottom)
                            .combined(with: .scale(scale: 0.96, anchor: .bottom))
                            .combined(with: .opacity)
                    )
                    .zIndex(11)
            }
        }
        .sheet(item: $presentedSheet) { sheet in
            switch sheet {
            case .agentOrchestrator:
                AgentOrchestratorView()
                    .presentationDetents([.large])
                    .presentationDragIndicator(.hidden)
                    .presentationCornerRadius(36)
            }
        }
        .environment(\.locale, preferences.locale)
        .preferredColorScheme(colorScheme(for: preferences.appearance))
    }

    private func colorScheme(for preference: SettingsAppearancePreference) -> ColorScheme? {
        switch preference {
        case .system: nil
        case .light: .light
        case .dark: .dark
        }
    }

    @ViewBuilder
    private var selectedContent: some View {
        switch selectedTab {
        case .destination(let destination):
            NavigationStack {
                destination.content
            }
        }
    }

    private func presentAgentOrchestrator() {
        dismissMoreMenu()
        presentedSheet = .agentOrchestrator
    }

    private func dismissMoreMenu() {
        withAnimation(tabBarSpring) {
            isMoreMenuPresented = false
        }
    }

    private func dismissCompanySwitcher() {
        withAnimation(companySwitcherSpring) {
            presentedOverlay = nil
        }
    }
}

private struct PathwayTabBar: View {
    @Binding var selectedTab: AppTab
    @Binding var isMoreMenuPresented: Bool
    let showAgentOrchestrator: () -> Void
    let showCompanySwitcher: () -> Void

    @Namespace private var glassNamespace
    @Namespace private var selectionNamespace

    var body: some View {
        GlassEffectContainer(spacing: 8) {
            HStack(alignment: .bottom, spacing: 12) {
                mainSurface

                Button(action: showAgentOrchestrator) {
                    Image(systemName: "bubble.left.and.bubble.right")
                        .font(.system(size: 23, weight: .medium))
                        .frame(width: compactTabBarHeight, height: compactTabBarHeight)
                        .contentShape(Circle())
                }
                .buttonStyle(.plain)
                .foregroundStyle(Color.primary)
                .glassEffect(.regular.interactive(), in: .circle)
                .glassEffectID("agent-orchestrator", in: glassNamespace)
                .accessibilityLabel("Open agent orchestrator")
                .accessibilityIdentifier("agent-orchestrator-button")
            }
        }
    }

    @ViewBuilder
    private var mainSurface: some View {
        if isMoreMenuPresented {
            destinationList
                .frame(maxWidth: .infinity)
                .glassEffect(
                    .regular.interactive(),
                    in: .rect(cornerRadius: 32)
                )
                .glassEffectID("expanded-view-menu", in: glassNamespace)
                .glassEffectTransition(.matchedGeometry)
                .transition(.blurReplace)
        } else {
            tabButtons
                .frame(maxWidth: .infinity)
                .glassEffect(
                    .regular.interactive(),
                    in: .rect(cornerRadius: compactTabBarHeight / 2)
                )
                .glassEffectID("compact-tab-bar", in: glassNamespace)
                .glassEffectTransition(.matchedGeometry)
                .transition(.blurReplace)
        }
    }

    private var destinationList: some View {
        VStack(alignment: .leading, spacing: 4) {
            Button(action: showCompanySwitcher) {
                HStack(spacing: 8) {
                    Text("Pathway")
                        .font(.headline)

                    Image(systemName: "chevron.up.chevron.down")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)

                    Spacer()
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Switch company")
            .padding(.horizontal, 16)
            .padding(.top, 14)
            .padding(.bottom, 8)

            Divider()
                .padding(.horizontal, 14)

            ForEach(AppDestination.allCases) { destination in
                destinationButton(
                    title: destination.title,
                    systemImage: destination.systemImage,
                    isSelected: selectedDestination == destination
                ) {
                    select(destination)
                }
            }
        }
        .padding(.bottom, 10)
    }

    private func destinationButton(
        title: String,
        systemImage: String,
        isSelected: Bool,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            HStack(spacing: 12) {
                Image(systemName: systemImage)
                    .font(.body.weight(.semibold))
                    .frame(width: 24)

                Text(title)
                    .font(.body.weight(.medium))

                Spacer()
            }
            .contentShape(Rectangle())
            .padding(.horizontal, 12)
            .frame(height: 44)
            .background {
                if isSelected {
                    RoundedRectangle(cornerRadius: 14, style: .continuous)
                        .fill(Color.primary.opacity(0.07))
                }
            }
        }
        .buttonStyle(.plain)
        .padding(.horizontal, 6)
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }

    private var tabButtons: some View {
        HStack(spacing: 0) {
            TabBarIconButton(
                systemImage: AppDestination.documents.systemImage,
                accessibilityLabel: AppDestination.documents.title,
                isSelected: selectedDestination == .documents,
                selectionNamespace: selectionNamespace
            ) {
                select(.documents)
            }

            TabBarIconButton(
                systemImage: AppDestination.leads.systemImage,
                accessibilityLabel: AppDestination.leads.title,
                isSelected: selectedDestination == .leads,
                selectionNamespace: selectionNamespace
            ) {
                select(.leads)
            }

            TabBarIconButton(
                systemImage: AppDestination.messages.systemImage,
                accessibilityLabel: AppDestination.messages.title,
                isSelected: selectedDestination == .messages,
                selectionNamespace: selectionNamespace
            ) {
                select(.messages)
            }

            Button(action: toggleMoreMenu) {
                ZStack {
                    if let selectedChooserDestination {
                        HStack(spacing: 4) {
                            Image(systemName: selectedChooserDestination.systemImage)

                            Image(systemName: "chevron.up.chevron.down")
                                .font(.system(size: 10, weight: .semibold))
                                .opacity(0.45)
                        }
                        .font(.system(size: 22, weight: .semibold))
                        .transition(.scale(scale: 0.82).combined(with: .opacity))
                    } else {
                        Image(systemName: "chevron.up.chevron.down")
                            .font(.system(size: 18, weight: .semibold))
                            .transition(.scale(scale: 0.82).combined(with: .opacity))
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .contentShape(Rectangle())
                .background {
                    if selectedChooserDestination != nil {
                        Capsule()
                            .fill(Color.primary.opacity(0.08))
                            .padding(5)
                            .matchedGeometryEffect(
                                id: "selected-tab-background",
                                in: selectionNamespace
                            )
                    }
                }
            }
            .buttonStyle(.plain)
            .foregroundStyle(selectedChooserDestination != nil ? Color.accentColor : Color.primary)
            .accessibilityLabel(moreAccessibilityLabel)
            .accessibilityValue(isMoreMenuPresented ? "Expanded" : "Collapsed")
        }
        .frame(height: compactTabBarHeight)
    }

    private var moreAccessibilityLabel: String {
        if let selectedChooserDestination {
            return "\(selectedChooserDestination.title), choose another view"
        }
        return "Choose another view"
    }

    private var selectedDestination: AppDestination? {
        guard case .destination(let destination) = selectedTab else { return nil }
        return destination
    }

    private var selectedChooserDestination: AppDestination? {
        guard let selectedDestination, !selectedDestination.isCompactDestination else { return nil }
        return selectedDestination
    }

    private func select(_ destination: AppDestination) {
        if isMoreMenuPresented {
            selectedTab = .destination(destination)
            withAnimation(tabBarSpring) {
                isMoreMenuPresented = false
            }
            return
        }

        let animation = destination.isCompactDestination ? tabSelectionSpring : tabBarSpring
        withAnimation(animation) {
            selectedTab = .destination(destination)
        }
    }

    private func toggleMoreMenu() {
        withAnimation(tabBarSpring) {
            isMoreMenuPresented.toggle()
        }
    }

}

private struct TabBarIconButton: View {
    let systemImage: String
    let accessibilityLabel: String
    let isSelected: Bool
    let selectionNamespace: Namespace.ID
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: systemImage)
                .font(.system(size: 22, weight: .semibold))
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .contentShape(Rectangle())
                .background {
                    if isSelected {
                        Capsule()
                            .fill(Color.primary.opacity(0.08))
                            .padding(5)
                            .matchedGeometryEffect(
                                id: "selected-tab-background",
                                in: selectionNamespace
                            )
                    }
                }
        }
        .buttonStyle(.plain)
        .foregroundStyle(isSelected ? Color.accentColor : Color.primary)
        .accessibilityLabel(accessibilityLabel)
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }
}

private struct CompanySwitcherCard: View {
    @Environment(PathwayAppModel.self) private var appModel
    @Environment(\.openURL) private var openURL

    let onDismiss: () -> Void

    @State private var isLoading = true

    private var currentCompanyID: String? {
        appModel.dashboardBootstrap?.companyData.id
    }

    private var companies: [NativeCompanyPickerCompany] {
        (appModel.companySwitcherContext?.companies ?? [])
            .filter(\.isSelectable)
            .sorted { left, right in
                if left.companyId == currentCompanyID { return true }
                if right.companyId == currentCompanyID { return false }
                if left.lastSelectedAt != right.lastSelectedAt {
                    return (left.lastSelectedAt ?? 0) > (right.lastSelectedAt ?? 0)
                }
                return left.name.localizedCaseInsensitiveCompare(right.name) == .orderedAscending
            }
    }

    private var companyListHeight: CGFloat {
        min(CGFloat(max(companies.count, 1)) * 70, 246)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("Companies")
                .font(.headline)
                .foregroundStyle(.secondary)
                .padding(.horizontal, 24)
                .padding(.top, 12)
                .padding(.bottom, 14)

            Group {
                if isLoading, appModel.companySwitcherContext == nil {
                    ProgressView("Loading companies…")
                        .frame(maxWidth: .infinity)
                        .frame(height: 70)
                } else if companies.isEmpty {
                    Label("No other active companies", systemImage: "building.2")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity)
                        .frame(height: 70)
                } else {
                    ScrollView {
                        LazyVStack(spacing: 6) {
                            ForEach(companies) { company in
                                CompanySwitcherRow(
                                    company: company,
                                    isCurrent: company.companyId == currentCompanyID,
                                    isPending: company.companyId == appModel.pendingCompanyID,
                                    selectionInProgress: appModel.pendingCompanyID != nil
                                ) {
                                    select(company)
                                }
                            }
                        }
                        .padding(.horizontal, 14)
                        .padding(.bottom, 8)
                    }
                    .scrollDisabled(companies.count <= 3)
                    .frame(height: companyListHeight)
                }
            }

            if let message = appModel.companySwitcherErrorMessage {
                Text(message)
                    .font(.caption)
                    .foregroundStyle(.red)
                    .padding(.horizontal, 24)
                    .padding(.vertical, 6)
            }

            Divider()
                .padding(.horizontal, 20)

            Button(action: startNewCompany) {
                Label("Start a new company", systemImage: "plus")
                    .font(.body.weight(.medium))
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 24)
                    .frame(height: 58)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
        }
        .padding(.bottom, 8)
        .glassEffect(
            .regular,
            in: ConcentricRectangle(
                uniformTopCorners: .fixed(32),
                uniformBottomCorners: .concentric(minimum: .fixed(32))
            )
        )
        .task {
            await appModel.loadCompanySwitcherContext()
            isLoading = false
        }
    }

    private func select(_ company: NativeCompanyPickerCompany) {
        guard company.companyId != currentCompanyID else { return }

        Task {
            if await appModel.switchCompany(company.companyId) {
                onDismiss()
            }
        }
    }

    private func startNewCompany() {
        openURL(createCompanyURL)
        onDismiss()
    }

    private var createCompanyURL: URL {
        let accountSetupURL = AppConfiguration.pathwaySiteURL
            .appending(path: "en")
            .appending(path: "account-setup")
        guard var components = URLComponents(
            url: accountSetupURL,
            resolvingAgainstBaseURL: false
        ) else {
            return accountSetupURL
        }
        components.queryItems = [
            URLQueryItem(name: "createCompany", value: "1"),
            URLQueryItem(name: "postLoginPath", value: "/documents")
        ]
        return components.url ?? accountSetupURL
    }
}

private struct CompanySwitcherRow: View {
    let company: NativeCompanyPickerCompany
    let isCurrent: Bool
    let isPending: Bool
    let selectionInProgress: Bool
    let action: () -> Void

    private var initials: String {
        let value = company.name
            .split(whereSeparator: \.isWhitespace)
            .prefix(2)
            .compactMap(\.first)
            .map(String.init)
            .joined()
            .uppercased()
        return value.isEmpty ? "QC" : value
    }

    var body: some View {
        Button(action: action) {
            HStack(spacing: 14) {
                Text(initials)
                    .font(.headline)
                    .foregroundStyle(.white)
                    .frame(width: 48, height: 48)
                    .background(Color.orange.gradient, in: .circle)

                VStack(alignment: .leading, spacing: 3) {
                    Text(company.name)
                        .font(.body.weight(.semibold))
                        .foregroundStyle(.primary)
                        .lineLimit(1)

                    Text(company.metadata)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }

                Spacer(minLength: 8)

                if isPending {
                    ProgressView()
                } else if isCurrent {
                    Image(systemName: "checkmark.circle.fill")
                        .font(.title3)
                        .foregroundStyle(Color.accentColor)
                }
            }
            .padding(.horizontal, 10)
            .frame(height: 64)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(selectionInProgress)
        .accessibilityLabel(
            isCurrent ? "\(company.name), current company" : "Switch to \(company.name)"
        )
    }
}

private struct ContactsView: View {
    var body: some View {
        PlaceholderFeatureView(
            title: "Contacts",
            systemImage: "person.crop.rectangle.stack",
            description: "Your contacts will appear here."
        )
    }
}

private struct LeadsView: View {
    var body: some View {
        PlaceholderFeatureView(
            title: "Leads",
            systemImage: "list.bullet",
            description: "Your leads will appear here."
        )
    }
}

private struct MessagesView: View {
    var body: some View {
        PlaceholderFeatureView(
            title: "Messages",
            systemImage: "bubble.left.and.bubble.right",
            description: "Your messages will appear here."
        )
    }
}

private struct LibrariesView: View {
    var body: some View {
        PlaceholderFeatureView(
            title: "Libraries",
            systemImage: "folder",
            description: "Your reusable content libraries will appear here."
        )
    }
}

private struct TemplatesView: View {
    var body: some View {
        PlaceholderFeatureView(
            title: "Templates",
            systemImage: "doc.richtext",
            description: "Your document templates will appear here."
        )
    }
}

private struct UsersView: View {
    var body: some View {
        PlaceholderFeatureView(
            title: "Users",
            systemImage: "person.3",
            description: "The people with access to Pathway will appear here."
        )
    }
}

private struct TeamsView: View {
    var body: some View {
        PlaceholderFeatureView(
            title: "Teams",
            systemImage: "person.crop.square",
            description: "Your teams and their members will appear here."
        )
    }
}

private struct GlobalSearchView: View {
    @State private var query = ""

    private var trimmedQuery: String {
        query.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 10) {
                Image(systemName: "magnifyingglass")
                    .foregroundStyle(.secondary)

                TextField("Search Pathway", text: $query)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .submitLabel(.search)

                if !query.isEmpty {
                    Button {
                        query = ""
                    } label: {
                        Image(systemName: "xmark.circle.fill")
                            .foregroundStyle(.secondary)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Clear search")
                }
            }
            .padding(.horizontal, 14)
            .frame(height: 44)
            .background(.quaternary, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            .padding(.horizontal, 16)
            .padding(.top, 6)

            ScrollView {
                Group {
                    if trimmedQuery.isEmpty {
                        ContentUnavailableView(
                            "Search Pathway",
                            systemImage: "magnifyingglass",
                            description: Text(
                                "Search documents, leads, messages, contacts, libraries, templates, users, and teams."
                            )
                        )
                    } else {
                        ContentUnavailableView(
                            "No Results",
                            systemImage: "magnifyingglass",
                            description: Text("No matches found for “\(trimmedQuery)”.")
                        )
                    }
                }
                .frame(maxWidth: .infinity)
                .padding(.top, 120)
            }
            .scrollDismissesKeyboard(.interactively)
        }
        .navigationTitle("Search")
        .navigationBarTitleDisplayMode(.large)
    }
}

private struct PlaceholderFeatureView: View {
    let title: String
    let systemImage: String
    let description: String

    var body: some View {
        ContentUnavailableView {
            Label(title, systemImage: systemImage)
        } description: {
            Text(description)
        }
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.large)
    }
}
