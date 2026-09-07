import SwiftUI

struct PathwayWorkspaceTerminalView: View {
    let client: PathwayWorkspaceClient
    var subscribe: PathwayWorkspaceSubscribe?
    @State private var terminalID = "term-1"
    @State private var attachGeneration = 0
    @State private var attached = false
    @State private var output = ""
    @State private var showTranscript = false
    @State private var renderer = PathwayTerminalRenderer()
    @State private var command = ""
    @State private var status = "Disconnected"
    @State private var error: String?
    @State private var busy = false
    @State private var confirmation: String?
    @State private var pendingScript: PathwayWorkspaceScript?

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text(status).font(.caption).foregroundStyle(.secondary)
                Spacer()
                if busy { ProgressView() }
            }.padding()
            if let error { Text(error).foregroundStyle(.red).padding(.horizontal) }
            if subscribe == nil {
                ContentUnavailableView("Terminal connection unavailable", systemImage: "terminal", description: Text("Connect to an environment that supports a dedicated terminal stream."))
            } else {
                if showTranscript {
                    ScrollView([.vertical, .horizontal]) {
                        Text(output.isEmpty ? "Attach to a terminal to read its output." : output)
                            .font(.caption.monospaced()).textSelection(.enabled).padding()
                    }.frame(maxWidth: .infinity, maxHeight: .infinity)
                } else {
                    PathwayTerminalWebView(renderer: renderer, enabled: attached && client.context.canMutate,
                        onInput: { [terminalID] data in _ = await write(data, terminal: terminalID, showProgress: false) },
                        onResize: { [terminalID] cols, rows in await resize(cols: cols, rows: rows, terminal: terminalID) },
                        onError: { error = $0; attached = false })
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                }
                if !attached { Text("Attach to the primary terminal or open a new shell from the menu.").font(.caption).foregroundStyle(.secondary).padding(.horizontal) }
                HStack {
                    Button("Copy selection", systemImage: "doc.on.doc") { renderer.copySelection() }.disabled(showTranscript)
                    Spacer()
                    PasteButton(payloadType: String.self) { values in for text in values { renderer.paste(text) } }
                        .disabled(!attached || showTranscript || !client.context.canMutate)
                }.font(.caption).padding(.horizontal)
                Divider()
                HStack {
                    TextField("Command", text: $command, axis: .vertical).lineLimit(1...4)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                    Button("Send", systemImage: "arrow.up.circle.fill") { Task { await sendCommand() } }
                        .labelStyle(.iconOnly).frame(minWidth: 44, minHeight: 44)
                        .disabled(!attached || command.isEmpty || busy || !client.context.canMutate)
                }.padding()
            }
        }.navigationTitle("Terminal")
            .toolbar {
                Menu {
                    Button("Attach primary terminal") { terminalID = "term-1"; attachGeneration += 1 }
                    Button("Open new terminal") { Task { await open() } }.disabled(!client.context.canMutate)
                    Button("Interrupt (Ctrl-C)") { Task { await write("\u{03}") } }.disabled(!attached || !client.context.canMutate)
                    Button("End input (Ctrl-D)") { Task { await write("\u{04}") } }.disabled(!attached || !client.context.canMutate)
                    Button("Clear display") { output = ""; renderer.reset() }
                    Toggle("Readable transcript", isOn: $showTranscript)
                    Button("Close terminal", role: .destructive) { confirmation = "close" }.disabled(!attached || !client.context.canMutate)
                    if !client.context.scripts.isEmpty {
                        Section("Project scripts") {
                            ForEach(client.context.scripts) { script in
                                Button(script.name) { pendingScript = script; confirmation = "script" }
                                    .disabled(!attached || !client.context.canMutate)
                            }
                        }
                    }
                } label: { Image(systemName: "ellipsis.circle") }.disabled(busy || subscribe == nil)
            }
            .onChange(of: showTranscript) { if attachGeneration > 0 { attachGeneration += 1 } }
            .task(id: attachGeneration) { if attachGeneration > 0 { await consume() } }
            .confirmationDialog(confirmation == "close" ? "Close this terminal?" : "Run project script?", isPresented: Binding(get: { confirmation != nil }, set: { if !$0 { confirmation = nil } })) {
                if confirmation == "close" {
                    Button("Close terminal", role: .destructive) { confirmation = nil; Task { await close() } }
                } else if let pendingScript {
                    Button("Run \(pendingScript.name)") { confirmation = nil; Task { await write(pendingScript.command + "\n") } }
                }
                Button("Cancel", role: .cancel) { confirmation = nil }
            } message: { Text(confirmation == "close" ? "The selected terminal and its running process will stop." : (pendingScript?.command ?? "")) }
    }
    private func open() async {
        busy = true; defer { busy = false }
        do {
            let id = "term-mobile-" + UUID().uuidString
            let snapshot = try await client.openTerminal(id)
            terminalID = id; renderer.reset(snapshot.history)
            if showTranscript { output = PathwayWorkspaceTerminalText.clean(snapshot.history) }
            status = snapshot.status
            attachGeneration += 1; error = nil
        } catch { self.error = error.localizedDescription }
    }
    private func consume() async {
        guard let subscribe else { return }
        attached = false; status = "Connecting…"; error = nil
        let consumingTerminalID = terminalID
        var payload = client.terminalPayload(consumingTerminalID)
        payload["cols"] = .number(Double(renderer.columns)); payload["rows"] = .number(Double(renderer.rows))
        payload["restartIfNotRunning"] = .bool(false)
        do {
            let stream = try await subscribe("terminal.attach", .object(payload))
            for try await event in stream {
                try Task.checkCancellation()
                guard let fields = event.objectValue else { continue }
                switch fields["type"]?.stringValue {
                case "snapshot", "restarted":
                    if let snapshot = fields["snapshot"]?.objectValue {
                        let history = snapshot["history"]?.stringValue ?? ""
                        renderer.reset(history)
                        if showTranscript { output = PathwayWorkspaceTerminalText.clean(history) }
                        status = snapshot["status"]?.stringValue ?? "Connected"
                        attached = status == "running"
                    }
                case "output":
                    let data = fields["data"]?.stringValue ?? ""
                    if showTranscript { output = String((output + PathwayWorkspaceTerminalText.clean(data)).suffix(150_000)) }
                    else { renderer.write(data) }
                case "exited", "closed": attached = false; status = "Exited"
                case "error": error = fields["message"]?.stringValue; attached = false
                case "cleared": output = ""; renderer.reset()
                default: break
                }
            }
            attached = false; status = "Disconnected"
        } catch is CancellationError { } catch { attached = false; status = "Disconnected"; self.error = error.localizedDescription }
    }
    private func sendCommand() async {
        let sent = command
        if await write(sent + "\n") { command = "" }
    }
    @discardableResult private func write(_ data: String, terminal: String? = nil, showProgress: Bool = true) async -> Bool {
        guard attached, terminal == nil || terminal == terminalID else { return false }
        if showProgress { busy = true }; defer { if showProgress { busy = false } }
        do {
            var payload = client.terminalPayload(terminal ?? terminalID); payload["data"] = .string(data)
            _ = try await client.run("terminal.write", payload); error = nil; return true
        } catch { self.error = error.localizedDescription; return false }
    }
    private func resize(cols: Int, rows: Int, terminal: String) async {
        guard attached, terminal == terminalID, client.context.canMutate else { return }
        do {
            var payload = client.terminalPayload(terminal)
            payload["cols"] = .number(Double(cols)); payload["rows"] = .number(Double(rows))
            _ = try await client.run("terminal.resize", payload)
        } catch { self.error = error.localizedDescription }
    }
    private func close() async {
        busy = true; defer { busy = false }
        do {
            _ = try await client.run("terminal.close", client.terminalPayload(terminalID))
            attached = false; status = "Closed"
        } catch { self.error = error.localizedDescription }
    }
}

enum PathwayWorkspaceTerminalText {
    /// Terminal output is displayed as selectable text; discard control sequences rather than showing raw escapes.
    static func clean(_ value: String) -> String {
        value.replacingOccurrences(of: "\u{001B}\\[[0-?]*[ -/]*[@-~]", with: "", options: .regularExpression)
            .replacingOccurrences(of: "\u{001B}\\][^\u{0007}]*(?:\u{0007}|\u{001B}\\\\)", with: "", options: .regularExpression)
            .replacingOccurrences(of: "\r\n", with: "\n")
            .replacingOccurrences(of: "\r", with: "\n")
    }
}
