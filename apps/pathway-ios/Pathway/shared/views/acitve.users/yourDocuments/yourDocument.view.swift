import SwiftUI

struct YourDocumentsView: View {
    @Environment(PathwayAppModel.self) private var appModel

    var body: some View {
        Group {
            if appModel.dashboardBootstrap == nil, appModel.pinnedDocuments.isEmpty {
                ProgressView("Loading pinned documents…")
            } else if appModel.pinnedDocuments.isEmpty {
                ContentUnavailableView(
                    "No Pinned Documents",
                    systemImage: "pin",
                    description: Text("Pin documents from Pathway to keep them close at hand.")
                )
            } else {
                DocumentInteractiveList(documents: appModel.pinnedDocuments)
            }
        }
        .navigationTitle("Pinned")
    }
}
