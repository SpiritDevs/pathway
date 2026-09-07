import SwiftUI

struct PathwaySourceControlDiscoveryView: View {
    let client: PathwayAdministrationClient
    @State private var discovery: PathwaySourceControlDiscovery?
    @State private var error: String?
    @State private var busy = false
    var body: some View {
        List {
            if let error { Text(error).foregroundStyle(.red) }
            if let discovery {
                Section("Version control") {
                    ForEach(discovery.versionControlSystems) { item in PathwaySourceControlDiscoveryRow(item: item) }
                }
                Section("Hosting accounts") {
                    ForEach(discovery.sourceControlProviders) { item in PathwaySourceControlDiscoveryRow(item: item) }
                }
                Section {
                    Text("Install tools and authenticate hosting accounts on this environment, then rescan. Account credentials remain on the host.")
                }
            }
            Button("Rescan environment", systemImage: "arrow.clockwise") { Task { await load() } }.disabled(busy)
        }
        .navigationTitle("Git tools & accounts")
        .overlay { if busy && discovery == nil { ProgressView("Scanning environment…") } }
        .task { await load() }
        .refreshable { await load() }
    }
    private func load() async {
        guard !busy else { return }; busy = true; defer { busy = false }
        do {
            let result: PathwaySourceControlDiscovery = try await client.call("server.discoverSourceControl")
            try Task.checkCancellation(); discovery = result; error = nil
        } catch is CancellationError {} catch { self.error = error.localizedDescription }
    }
}

private struct PathwaySourceControlDiscoveryRow: View {
    let item: PathwaySourceControlDiscovery.Item
    @State private var revealAccount = false
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            LabeledContent(item.label, value: item.implemented == false ? "Not supported" : item.status.capitalized)
            if let version = PathwaySourceControlDiscovery.option(item.version) { Text(version).font(.caption) }
            if let executable = item.executable { Text(executable).font(.caption.monospaced()).textSelection(.enabled) }
            if let detail = PathwaySourceControlDiscovery.option(item.detail) { Text(detail).font(.footnote).foregroundStyle(.secondary) }
            if item.status == "missing" { Text(item.installHint).font(.footnote).textSelection(.enabled) }
            if let auth = item.auth {
                LabeledContent("Authentication", value: auth.status.capitalized).font(.subheadline)
                if let host = PathwaySourceControlDiscovery.option(auth.host) { Text(host).font(.caption).textSelection(.enabled) }
                if let account = PathwaySourceControlDiscovery.option(auth.account) {
                    Button(revealAccount ? "Hide account" : "Show account") { revealAccount.toggle() }.font(.caption)
                    if revealAccount { Text(account).font(.caption).textSelection(.enabled) }
                }
                if let detail = PathwaySourceControlDiscovery.option(auth.detail) { Text(detail).font(.footnote).textSelection(.enabled) }
            }
        }.padding(.vertical, 4)
    }
}
