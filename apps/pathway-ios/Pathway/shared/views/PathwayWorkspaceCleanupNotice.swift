import SwiftUI

struct PathwayWorkspaceCleanupNotice: View {
    @Environment(PathwayAppModel.self) private var appModel
    @State private var cleanup = PathwayWorkspaceCleanupModel()

    private var environments: [PathwayCompanyEnvironment] {
        appModel.cloud.environments.filter {
            $0.environment.state == "active"
                && $0.environment.descriptor.capabilities?["threadConversations"]?.boolValue == true
        }
    }

    var body: some View {
        ZStack {
            if !cleanup.entries.isEmpty {
                ScrollView {
                    VStack(alignment: .leading, spacing: 12) {
                        ForEach(cleanup.entries) { entry in
                            HStack(alignment: .top) {
                                Image(systemName: "exclamationmark.triangle").foregroundStyle(.orange)
                                VStack(alignment: .leading, spacing: 3) {
                                    Text("Cleanup failed: \(entry.failure.title)").font(.subheadline.bold())
                                    Text(entry.environmentLabel).font(.caption).foregroundStyle(.secondary)
                                    Text(entry.failure.message).font(.caption)
                                }
                                Spacer(minLength: 8)
                                Button("Retry") { Task { await cleanup.retry(entry) } }
                                    .disabled(!cleanup.canRetry(entry))
                            }
                        }
                    }.padding()
                }
                .frame(maxHeight: 160)
                .background(.regularMaterial)
                .accessibilityIdentifier("workspace-cleanup-notices")
            }
        }
        .task(id: environments.map(\.id)) {
            guard let connect = appModel.connect else { return }
            await cleanup.observe(environments: environments, using: connect)
        }
        .alert("Couldn’t retry cleanup", isPresented: Binding(
            get: { cleanup.errorMessage != nil },
            set: { if !$0 { cleanup.errorMessage = nil } }
        )) {
            Button("OK", role: .cancel) { cleanup.errorMessage = nil }
        } message: { Text(cleanup.errorMessage ?? "Please try again.") }
    }
}
