import SwiftUI

struct PathwayIssuesDestinationView: View {
    @Environment(PathwayAppModel.self) private var appModel
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    var initialTab = "all"
    @State private var destination: IssueDestination?

    var body: some View {
        PathwayIssuesView(
            model: appModel.cloud.issues,
            companies: appModel.cloud.companies,
            projects: appModel.cloud.projects,
            initialScope: initialTab == "assigned" ? .mine : initialTab == "triage" ? .triage : .all,
            onOpenPlanning: { destination = IssueDestination(companyID: $0, planning: true) },
            onOpenSettings: { destination = IssueDestination(companyID: $0, planning: false) }
        )
        .safeAreaPadding(.bottom, horizontalSizeClass == .compact ? CompactAppShellMetrics.scrollContentClearance : 0)
        .overlay {
            if appModel.cloud.companies.isEmpty {
                if appModel.cloud.connectionState == .syncing || appModel.cloud.connectionState == .connecting {
                    ProgressView("Syncing tasks…")
                } else {
                    ContentUnavailableView {
                        Label("Your tasks are unavailable", systemImage: "wifi.exclamationmark")
                    } description: {
                        Text(appModel.cloud.errorMessage ?? "Connect to your workspace to view tasks.")
                    } actions: {
                        Button("Reconnect") { Task { await appModel.cloud.retry() } }
                    }
                    .background(.background)
                }
            }
        }
        .navigationDestination(item: $destination) { destination in
            Group {
                if destination.planning {
                    PathwayIssuePlanningView(model: appModel.cloud.issues, companyID: destination.companyID)
                } else {
                    PathwayIssueSettingsView(model: appModel.cloud.issues, companyID: destination.companyID)
                }
            }
            .toolbarVisibility(.visible, for: .navigationBar)
            .preference(key: IssueDetailNavigationActiveKey.self, value: true)
        }
    }
}

private struct IssueDestination: Hashable {
    let companyID: String
    let planning: Bool
    var id: String { "\(companyID):\(planning)" }
}

/// A pushed issue owns the compact screen; the app dock returns when navigation pops.
struct IssueDetailNavigationActiveKey: PreferenceKey {
    static let defaultValue = false
    static func reduce(value: inout Bool, nextValue: () -> Bool) {
        value = value || nextValue()
    }
}
