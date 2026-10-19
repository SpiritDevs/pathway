import SwiftUI
#if canImport(WebKit) && canImport(UIKit)
import WebKit
#endif

struct PathwayEmailDetailView: View {
    @Environment(\.dismiss) private var dismiss
    @Bindable var model: PathwayEmailModel
    let original: PathwayEmailRecord
    @State private var tab = "Message"
    @State private var deleting = false
    @State private var loadRemote = false
    private var message: PathwayEmailRecord? { model.messages.first { $0.id == original.id } }
    var body: some View {
        Group {
            if let message {
                List {
                    Section {
                        Text(message.subject).font(.title2).textSelection(.enabled)
                        LabeledContent("From", value: message.sender)
                        LabeledContent("To", value: message.addresses("to"))
                        if !message.addresses("cc").isEmpty { LabeledContent("Cc", value: message.addresses("cc")) }
                        LabeledContent("Inbox", value: message.inbox)
                        LabeledContent("Received", value: message.receivedAt)
                        if let code = message.message["detectedCode"]?.stringValue { LabeledContent("Detected code", value: code).textSelection(.enabled) }
                    }
                    Section {
                        Picker("Content", selection: $tab) { ForEach(["Message", "Text", "Headers", "Diagnostics"], id: \.self) { Text($0) } }.pickerStyle(.segmented)
                        if tab == "Message", let html = message.message["htmlBody"]?.stringValue {
                            Toggle("Load remote images and styles", isOn: $loadRemote)
                            #if canImport(WebKit) && canImport(UIKit)
                            PathwayEmailHTMLView(html: html, allowRemote: loadRemote).frame(minHeight: 420)
                            #else
                            Text(message.message["textBody"]?.stringValue ?? html).textSelection(.enabled)
                            #endif
                        } else if tab == "Headers" {
                            Text(headerText(message)).font(.system(.caption, design: .monospaced)).textSelection(.enabled)
                        } else if tab == "Diagnostics" {
                            Text(diagnostics(message)).font(.system(.caption, design: .monospaced)).textSelection(.enabled)
                        } else { Text(message.message["textBody"]?.stringValue ?? "This message has no plain text body.").textSelection(.enabled) }
                    }
                    Section("Attachments") {
                        ForEach((message.message["attachments"]?.arrayValue ?? []).compactMap(\.objectValue).map { PathwayCalendarRecord(companyID: message.companyID, kind: "attachment", fields: $0) }) { attachment in
                            VStack(alignment: .leading) {
                                Text(attachment.string("filename").isEmpty ? "Attachment" : attachment.string("filename"))
                                Text("\(attachment.string("contentType")) · \(attachment.fields["sizeBytes"]?.intValue ?? 0) bytes").font(.caption).foregroundStyle(.secondary)
                            }
                        }
                    }
                    Section("Tags") {
                        ForEach(model.tags.filter { $0.companyID == message.companyID }) { tag in
                            Toggle(tag.string("name"), isOn: Binding(get: { message.tagIDs.contains(tag.entityID) }, set: { present in run { try await model.setTag([message], tagID: tag.entityID, present: present) } })).disabled(model.isWriting)
                        }
                    }
                    Section {
                        Button(message.isRead ? "Mark unread" : "Mark read") { run { try await model.mark([message], read: !message.isRead) } }
                            .accessibilityIdentifier("email-read-toggle")
                            .accessibilityValue(message.isRead ? "Read" : "Unread")
                        Button("Delete message", role: .destructive) { deleting = true }
                    }.disabled(model.isWriting)
                    if let error = model.errorMessage { Text(error).foregroundStyle(.red) }
                }
                .onChange(of: message.id, initial: true) {
                    let addresses = (message.headers["from"]?.arrayValue ?? []).compactMap { $0.objectValue?["address"]?.stringValue?.lowercased() }
                    loadRemote = model.trustedSenders.contains { $0.companyID == message.companyID && addresses.contains($0.string("address").lowercased()) }
                }
                .confirmationDialog("Delete this captured message?", isPresented: $deleting, titleVisibility: .visible) {
                    Button("Delete message", role: .destructive) { Task { if await model.perform({ try await model.remove([message]) }) { dismiss() } } }
                }
            } else { ContentUnavailableView("Message unavailable", systemImage: "envelope.badge", description: Text("It may have been removed or your access changed.")) }
        }.navigationTitle("Message")
    }
    private func run(_ operation: @escaping @MainActor () async throws -> Void) { Task { _ = await model.perform(operation) } }
    private func headerText(_ message: PathwayEmailRecord) -> String {
        (message.headers["headers"]?.arrayValue ?? []).compactMap { value in
            guard let row = value.objectValue else { return nil }
            return "\(row["name"]?.stringValue ?? ""): \(row["value"]?.stringValue ?? "")"
        }.joined(separator: "\n")
    }
    private func diagnostics(_ message: PathwayEmailRecord) -> String {
        let data: JSONValue = .object(["envelope": message.message["envelope"] ?? .null, "timings": message.message["timings"] ?? .null, "deliverability": message.message["deliverability"] ?? .null, "smtpTransactionLog": message.message["smtpTransactionLog"] ?? .null])
        let encoder = JSONEncoder(); encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        return (try? String(decoding: encoder.encode(data), as: UTF8.self)) ?? "Diagnostics unavailable."
    }
}

#if canImport(WebKit) && canImport(UIKit)
/// Captured HTML is untrusted mail. Scripts, forms, frames and remote resources stay blocked
/// unless the reader explicitly enables images/styles for this message.
struct PathwayEmailHTMLView: UIViewRepresentable {
    let html: String
    let allowRemote: Bool
    @Environment(\.openURL) private var openURL
    func makeCoordinator() -> Coordinator { Coordinator(openURL: openURL) }
    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.defaultWebpagePreferences.allowsContentJavaScript = false
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.navigationDelegate = context.coordinator
        return view
    }
    func updateUIView(_ view: WKWebView, context: Context) {
        let remote = allowRemote ? " https: http:" : ""
        let policy = "default-src 'none'; img-src data: blob:\(remote); style-src 'unsafe-inline'\(remote); font-src data:; frame-src 'none'; form-action 'none'; base-uri 'none'; script-src 'none';"
        let content = "<meta http-equiv=\"Content-Security-Policy\" content=\"\(policy)\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\(html)"
        guard context.coordinator.content != content else { return }
        context.coordinator.content = content
        view.loadHTMLString(content, baseURL: nil)
    }
    final class Coordinator: NSObject, WKNavigationDelegate {
        var content = ""
        let openURL: OpenURLAction
        init(openURL: OpenURLAction) { self.openURL = openURL }
        func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy) -> Void) {
            if navigationAction.navigationType == .linkActivated {
                if let url = navigationAction.request.url, ["https", "http", "mailto"].contains(url.scheme ?? "") { openURL(url) }
                decisionHandler(.cancel)
            } else { decisionHandler(navigationAction.request.url?.scheme == "about" ? .allow : .cancel) }
        }
    }
}
#endif
