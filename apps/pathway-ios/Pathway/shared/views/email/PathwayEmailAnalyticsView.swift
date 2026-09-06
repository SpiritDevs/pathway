import SwiftUI
import Charts

struct PathwayEmailAnalyticsView: View {
    @Bindable var model: PathwayEmailModel
    let environment: PathwayCompanyEnvironment
    var projectID: String?
    @State private var from = Calendar.current.date(byAdding: .day, value: -7, to: Date()) ?? Date()
    @State private var to = Date()
    @State private var interval = "day"
    @State private var snapshot: [String: JSONValue]?
    @State private var loading = false
    var body: some View {
        List {
            Section {
                DatePicker("From", selection: $from, displayedComponents: .date)
                DatePicker("To", selection: $to, displayedComponents: .date)
                Picker("Group by", selection: $interval) { Text("Day").tag("day"); Text("Hour").tag("hour") }
                Button("Refresh analytics") { Task { await refresh() } }.disabled(loading || to <= from)
            }
            if loading { ProgressView("Loading analytics…") }
            if let snapshot {
                Section("Message volume") {
                    Chart(rows(snapshot["volumeOverTime"], idKey: "bucketStart")) { row in
                        if let date = pathwayDate(from: row.string("bucketStart")) {
                            BarMark(x: .value("Time", date), y: .value("Messages", row.fields["messageCount"]?.intValue ?? 0))
                        }
                    }.frame(height: 200)
                }
                Section("Capture latency") {
                    if let latency = snapshot["captureLatency"]?.objectValue {
                        LabeledContent("Messages", value: String(latency["messageCount"]?.intValue ?? 0))
                        ForEach(["averageMs", "p50Ms", "p95Ms", "maxMs"], id: \.self) { key in
                            LabeledContent(["averageMs": "Average", "p50Ms": "Median", "p95Ms": "95th percentile", "maxMs": "Maximum"][key] ?? key, value: "\(latency[key]?.intValue ?? 0) ms")
                        }
                    }
                }
                Section("By project") {
                    ForEach(rows(snapshot["perProjectCounts"], idKey: "projectId")) { row in LabeledContent(row.string("mailSlug").isEmpty ? "Unassigned" : row.string("mailSlug"), value: String(row.fields["messageCount"]?.intValue ?? 0)) }
                }
                Section("Top senders") { ForEach(rows(snapshot["topSenders"], idKey: "address")) { row in LabeledContent(row.string("address"), value: String(row.fields["messageCount"]?.intValue ?? 0)) } }
                Section("Top recipients") { ForEach(rows(snapshot["topRecipients"], idKey: "address")) { row in LabeledContent(row.string("address"), value: String(row.fields["messageCount"]?.intValue ?? 0)) } }
            }
            if let error = model.errorMessage { Text(error).foregroundStyle(.red) }
        }
        .accessibilityIdentifier("email-capture-analytics")
        .navigationTitle("Capture analytics")
        .task { await refresh() }
        .refreshable { await refresh() }
    }
    private func rows(_ value: JSONValue?, idKey: String) -> [PathwayCalendarRecord] {
        (value?.arrayValue ?? []).compactMap(\.objectValue).map { .init(companyID: environment.companyId, kind: "analytics", fields: $0.merging(["id": $0[idKey]?.stringValue.map(JSONValue.string) ?? .string("unassigned")]) { _, new in new }) }
    }
    private func refresh() async {
        guard !loading else { return }
        loading = true; defer { loading = false }
        do {
            let scope: JSONValue = projectID.map { .object(["type": .string("project"), "projectId": .string($0)]) } ?? .object(["type": .string("all")])
            snapshot = try await model.environment(companyID: environment.companyId, environmentID: environment.environment.environmentId, method: "email.analytics", fields: ["scope": scope, "from": .string(from.ISO8601Format()), "to": .string(to.ISO8601Format()), "interval": .string(interval), "topAddressLimit": .number(10)]).objectValue
        } catch { snapshot = nil; model.errorMessage = error.localizedDescription }
    }
}
