import SwiftUI

struct PathwayAdministrationUsageView: View {
    let client: PathwayAdministrationClient
    @State private var days = 7
    @State private var usage: PathwayAdministrationUsage?
    @State private var quotas: [PathwayAdministrationQuota] = []
    @State private var errors: [String] = []
    @State private var busy = false
    var body: some View {
        List {
            Picker("Range", selection: $days) { Text("7 days").tag(7); Text("30 days").tag(30); Text("90 days").tag(90) }
            if busy { ProgressView("Reading environment usage…") }
            if !errors.isEmpty { Text(errors.joined(separator: "\n")).foregroundStyle(.red) }
            if let usage {
                Section("Usage on this environment") {
                    LabeledContent("Tokens", value: usage.totalTokens.formatted())
                    LabeledContent("API-equivalent cost", value: usage.totalCost.formatted(.currency(code: "USD")))
                    LabeledContent("Sessions", value: usage.sources.reduce(0) { $0 + $1.distinctSessions }.formatted())
                    Text("Subscription billing is separate. These costs estimate equivalent API usage.").font(.caption).foregroundStyle(.secondary)
                    Text("Read at \(usage.readAt)").font(.caption).foregroundStyle(.secondary)
                    if usage.contractVersion != 5 { Text("This environment uses a different usage contract; coverage may be partial.").foregroundStyle(.orange) }
                    if usage.unpricedRecords > 0 { Text("\(usage.unpricedRecords) records have tokens but no known price.").foregroundStyle(.orange) }
                    Text("Pricing: \(usage.pricing.status)").font(.caption)
                }
                Section("Providers and models") {
                    ForEach(usage.models) { model in
                        VStack(alignment: .leading) {
                            Text(model.name)
                            Text("\(model.provider) · \(model.tokens.formatted()) tokens · \(model.cost.formatted(.currency(code: "USD")))").font(.caption).foregroundStyle(.secondary)
                        }
                    }
                }
                Section("Coverage") {
                    ForEach(usage.sources) { source in
                        VStack(alignment: .leading) { Text("\(source.fingerprint.provider): \(source.status)"); if let message = source.message { Text(message).font(.caption).foregroundStyle(.secondary) } }
                    }
                }
            }
            ForEach(quotas) { quota in
                Section("\(quota.instanceId) limits") {
                    if let plan = quota.planName { Text(plan) }
                    Text(quota.status).font(.caption)
                    if quota.stale == true { Text("Cached quota; the latest refresh was unavailable.").foregroundStyle(.orange) }
                    if let detail = quota.detail { Text(detail).font(.caption).foregroundStyle(.secondary) }
                    ForEach(quota.limits) { limit in
                        VStack(alignment: .leading, spacing: 4) {
                            Text(limit.window)
                            if let remaining = limit.remaining {
                                ProgressView(value: remaining, total: 100)
                                    .accessibilityLabel("\(limit.window) remaining").accessibilityValue("\(remaining.formatted(.number.precision(.fractionLength(0)))) percent")
                                Text("\(remaining.formatted(.number.precision(.fractionLength(0))))% remaining").font(.caption)
                            } else { Text("Remaining amount unavailable").font(.caption).foregroundStyle(.secondary) }
                            if let reset = limit.resetsAt { Text("Resets: \(reset)").font(.caption).foregroundStyle(.secondary) }
                        }
                    }
                    ForEach(quota.usageLines) { line in LabeledContent(line.label, value: line.value) }
                    Text("Updated \(quota.updatedAt)").font(.caption).foregroundStyle(.secondary)
                }
            }
            if !errors.isEmpty && usage != nil { Text("Showing the last successful usage snapshot above.").font(.caption).foregroundStyle(.secondary) }
        }.navigationTitle("Usage & limits").task(id: days) { await load() }.refreshable { await load() }
    }
    private func load() async {
        busy = true; defer { busy = false }
        errors = []
        let calendar = Calendar.current
        let now = Date()
        let formatter = DateFormatter(); formatter.calendar = Calendar(identifier: .gregorian); formatter.locale = Locale(identifier: "en_US_POSIX"); formatter.timeZone = .current; formatter.dateFormat = "yyyy-MM-dd"
        let since = calendar.date(byAdding: .day, value: -(days - 1), to: now) ?? now
        do {
            let next: PathwayAdministrationUsage = try await client.call("server.getUsageSummary", ["sinceDay": .string(formatter.string(from: since)), "untilDay": .string(formatter.string(from: now)), "timeZone": .string(TimeZone.current.identifier), "resolution": .string("day")])
            try Task.checkCancellation(); usage = next
        } catch is CancellationError { return } catch { errors.append(error.localizedDescription) }
        do {
            let config: PathwayAdministrationConfig = try await client.call("server.getConfig")
            var next: [PathwayAdministrationQuota] = []
            for provider in config.providers where ["codex", "claudeAgent", "cursor"].contains(provider.driver) && provider.enabled {
                do {
                    let quota: PathwayAdministrationQuota = try await client.call("server.getProviderUsage", ["instanceId": .string(provider.instanceId), "provider": .string(provider.driver)])
                    next.append(quota)
                } catch { errors.append("\(provider.name): \(error.localizedDescription)") }
            }
            try Task.checkCancellation(); quotas = next
        } catch is CancellationError { } catch { errors.append(error.localizedDescription) }
    }
}
