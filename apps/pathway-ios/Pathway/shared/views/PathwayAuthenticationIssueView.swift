import SwiftUI

struct PathwayAuthenticationIssueView: View {
    let issue: PathwayAuthenticationIssue
    var automaticReportState: PathwayLoginReportState? = nil
    @State private var reportingIssue: PathwayAuthenticationIssue?

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Label(issue.title, systemImage: issue.isCancellation ? "info.circle.fill" : "exclamationmark.triangle.fill")
                .font(.headline)
                .foregroundStyle(issue.isCancellation ? Color.secondary : Color.orange)
            Text(issue.message)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            if let automaticReportState {
                Label(automaticReportState.message, systemImage: automaticReportState == .received ? "checkmark.circle" : "envelope")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            } else {
                Button("Report a problem", systemImage: "envelope") { reportingIssue = issue }
                    .buttonStyle(.bordered)
                    .accessibilityHint("Review an email report for Pathway support")
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding()
        .background(.quaternary.opacity(0.5), in: .rect(cornerRadius: 16))
        .accessibilityElement(children: .contain)
        .sheet(item: $reportingIssue) { issue in
            PathwayAuthenticationReportView(issue: issue)
        }
    }
}

private struct PathwayAuthenticationReportView: View {
    let issue: PathwayAuthenticationIssue
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL
    @State private var couldNotOpenEmail = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text("Send this report to our support team. You can add details in your email app before sending.")
                    Text(PathwayAuthenticationIssue.supportAddress)
                        .textSelection(.enabled)
                }
                Section("Report details") {
                    Text(issue.reportBody)
                        .font(.footnote.monospaced())
                        .textSelection(.enabled)
                    Text("Includes the error code, app version and OS version. No account credentials or conversation content are included.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
                Section {
                    Button("Open email", systemImage: "envelope", action: openEmail)
                    ShareLink(item: issue.reportBody) {
                        Label("Share report", systemImage: "square.and.arrow.up")
                    }
                    if couldNotOpenEmail {
                        Text("No email app could be opened. Share or copy the report and send it to \(PathwayAuthenticationIssue.supportAddress).")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                }
            }
            .navigationTitle("Report a problem")
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done", action: dismiss.callAsFunction)
                }
            }
        }
    }

    private func openEmail() {
        guard let url = issue.emailURL else { couldNotOpenEmail = true; return }
        openURL(url) { accepted in couldNotOpenEmail = !accepted }
    }
}
