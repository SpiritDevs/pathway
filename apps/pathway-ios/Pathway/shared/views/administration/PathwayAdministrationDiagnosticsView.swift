import SwiftUI

struct PathwayAdministrationDiagnosticsView: View {
    let client: PathwayAdministrationClient
    @State private var report: Report?
    @State private var error: String?
    private struct Report: Decodable {
        let readAt: String
        let recordCount: Int
        let parseErrorCount: Int
        let failureCount: Int
        let interruptionCount: Int
        let slowSpanCount: Int
        let latestFailures: [Failure]
        let topSpansByCount: [Span]
        let error: JSONValue?
        var readError: String? { error?.objectValue?["value"]?.objectValue?["message"]?.stringValue }
        struct Failure: Decodable, Identifiable {
            let name: String
            let cause: String
            let endedAt: String
            let traceId: String
            let spanId: String
            var id: String { traceId + ":" + spanId }
        }
        struct Span: Decodable, Identifiable {
            let name: String
            let count: Int
            let failureCount: Int
            let averageDurationMs: Double
            let maxDurationMs: Double
            var id: String { name }
        }
    }
    var body: some View {
        List {
            if let error { Text(error).foregroundStyle(.red) }
            if let report {
                Section("Environment trace summary") {
                    if let readError = report.readError { Text(readError).foregroundStyle(.orange) }
                    LabeledContent("Records", value: report.recordCount.formatted())
                    LabeledContent("Failures", value: report.failureCount.formatted())
                    LabeledContent("Interruptions", value: report.interruptionCount.formatted())
                    LabeledContent("Slow operations", value: report.slowSpanCount.formatted())
                    if report.parseErrorCount > 0 { Text("\(report.parseErrorCount) records could not be read.").foregroundStyle(.orange) }
                    Text("Read at \(report.readAt)").font(.caption).foregroundStyle(.secondary)
                }
                Section("Recent failures") {
                    ForEach(report.latestFailures) { failure in
                        VStack(alignment: .leading, spacing: 4) {
                            Text(failure.name).font(.headline)
                            Text(failure.cause).textSelection(.enabled)
                            Text(failure.endedAt).font(.caption).foregroundStyle(.secondary)
                            Text("Trace \(failure.traceId)").font(.caption.monospaced()).textSelection(.enabled)
                        }
                    }
                }
                Section("Frequent operations") {
                    ForEach(report.topSpansByCount) { span in
                        VStack(alignment: .leading) {
                            Text(span.name)
                            Text("\(span.count) calls · average \(span.averageDurationMs.formatted(.number.precision(.fractionLength(0)))) ms · maximum \(span.maxDurationMs.formatted(.number.precision(.fractionLength(0)))) ms").font(.caption).foregroundStyle(.secondary)
                        }
                    }
                }
            } else if error == nil { ProgressView("Reading diagnostics…") }
        }.navigationTitle("Diagnostics").task { await load() }.refreshable { await load() }
    }
    private func load() async {
        do { report = try await client.call("server.getTraceDiagnostics"); error = nil }
        catch { self.error = error.localizedDescription }
    }
}
