import SwiftUI
import UIKit

/// The environment's primary screen as a persistent view, opened from the thread menu. It
/// streams only while on screen and the app is in the foreground, outlives the agent's turn,
/// and lets this device take control, then hand back with a follow-up for the agent.
/// Leaving the view or the app releases control.
struct AgentThreadComputerSurface: View {
    @State private var surface: PathwayComputerSurfaceModel
    @State private var attempt = 0
    @Environment(\.scenePhase) private var scenePhase

    init(threadID: String, environment: PathwayCompanyEnvironment, connect: PathwayConnectClient) {
        _surface = State(initialValue: PathwayComputerSurfaceModel(threadID: threadID, environment: environment, connect: connect))
    }

    var body: some View {
        content
            .navigationTitle("Computer")
            .navigationBarTitleDisplayMode(.inline)
            .task(id: "\(scenePhase == .active):\(attempt)") {
                guard scenePhase == .active else { return }
                await surface.watch()
            }
            .accessibilityIdentifier("thread-computer-surface")
    }

    @ViewBuilder private var content: some View {
        if let message = surface.disconnected {
            ContentUnavailableView {
                Label("The computer view disconnected.", systemImage: "desktopcomputer")
            } description: { Text(message) } actions: {
                Button("Reconnect") { attempt += 1 }.buttonStyle(.bordered)
            }
        } else if let session = surface.session {
            if session.capture {
                ComputerSurfaceControls(surface: surface, session: session)
            } else {
                ContentUnavailableView("This environment's screen can't be viewed.", systemImage: "desktopcomputer",
                    description: Text("Computer use isn't set up on this environment, or its host can't share its screen."))
            }
        } else {
            ProgressView("Connecting to the computer…").frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }
}

private struct ComputerSurfaceControls: View {
    @Bindable var surface: PathwayComputerSurfaceModel
    let session: PathwayComputerSurfaceSession

    private var interactive: Bool { session.mine && session.input }

    var body: some View {
        VStack(spacing: 0) {
            header
            if let notice = surface.notice { noticeRow(notice) { surface.notice = nil } }
            if let restored = surface.drafts.restored { noticeRow(restored) { surface.drafts.restored = nil } }
            ComputerSurfaceScreen(surface: surface, interactive: interactive)
            if let error = surface.error {
                Text(error).font(.caption).foregroundStyle(.red).lineLimit(2)
                    .padding(.horizontal, 12).padding(.top, 6)
            }
            if interactive { keyboard }
            footer
        }
    }

    private func noticeRow(_ text: String, dismiss: @escaping () -> Void) -> some View {
        HStack {
            Text(text).font(.caption)
            Spacer()
            Button("Dismiss", systemImage: "xmark", action: dismiss).labelStyle(.iconOnly).font(.caption)
        }
        .padding(.horizontal, 12).padding(.vertical, 6)
        .background(Color(uiColor: .secondarySystemBackground))
        .accessibilityElement(children: .combine)
    }

    private var header: some View {
        HStack(spacing: 8) {
            Circle().fill(toneColor).frame(width: 8, height: 8).accessibilityHidden(true)
            Text(session.label).font(.subheadline.weight(.medium)).lineLimit(1)
            Spacer()
            ComputerSurfaceStreamLabel(frames: surface.frames)
            if session.mine {
                Button("Release") { Task { await surface.release() } }
                    .buttonStyle(.bordered).disabled(surface.busy)
                    .accessibilityIdentifier("thread-computer-surface-release")
            } else if session.input {
                Button("Take control") { Task { await surface.takeControl() } }
                    .buttonStyle(.borderedProminent).disabled(surface.busy || session.tone == .other)
                    .accessibilityHint(session.tone == .other ? "Wait for the other device to release control." : "")
                    .accessibilityIdentifier("thread-computer-surface-take-control")
            }
        }
        .controlSize(.small)
        .padding(.horizontal, 12).padding(.vertical, 8)
    }

    private var toneColor: Color {
        switch session.tone {
        case .agent: .blue
        case .mine: .green
        case .other: .orange
        case .idle: .secondary
        }
    }

    /// Text goes out as `type`; the key bar sends complete presses and Command chords.
    private var keyboard: some View {
        VStack(spacing: 6) {
            HStack {
                TextField("Type on the computer", text: $surface.typing)
                    .textFieldStyle(.roundedBorder).textInputAutocapitalization(.never).autocorrectionDisabled()
                    .onSubmit(surface.sendTyping)
                    .accessibilityIdentifier("thread-computer-surface-type")
                Button("Type", action: surface.sendTyping).disabled(surface.typing.isEmpty)
            }
            ScrollView(.horizontal) {
                HStack(spacing: 6) {
                    ForEach(Self.keys, id: \.key) { item in
                        Button { surface.sendKey(item.key) } label: {
                            Text(item.title).frame(minWidth: 28)
                        }
                        .accessibilityLabel(item.accessibility)
                    }
                    Menu {
                        ForEach(Self.chords, id: \.title) { chord in
                            Button(chord.title) { surface.sendKey(chord.key, modifiers: chord.modifiers) }
                        }
                    } label: { Text("⌘").frame(minWidth: 28) }
                    .accessibilityLabel("Command shortcuts")
                }
                .buttonStyle(.bordered).controlSize(.small)
            }
            .scrollIndicators(.hidden)
        }
        .padding(.horizontal, 12).padding(.top, 8)
    }

    @ViewBuilder private var footer: some View {
        if surface.pendingFollowUp != nil {
            HStack {
                Text("Your message didn't reach the agent. Your screenshot and actions are kept.")
                    .font(.caption).foregroundStyle(.secondary)
                Spacer()
                Button("Retry") { Task { await surface.retryFollowUp() } }.buttonStyle(.borderedProminent).disabled(surface.busy)
                Button("Discard") { surface.discardFollowUp() }
            }
            .controlSize(.small)
            .padding(12)
        } else if session.mine {
            HStack(alignment: .bottom) {
                TextField("Tell the agent what's next…", text: $surface.draft, axis: .vertical)
                    .lineLimit(1...4).textFieldStyle(.roundedBorder)
                    .accessibilityLabel("Message for the agent")
                    .accessibilityIdentifier("thread-computer-surface-hand-back-message")
                Button(surface.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "Hand back" : "Send & hand back") {
                    let message = surface.draft
                    Task { if await surface.handBack(message), surface.draft == message { surface.draft = "" } }
                }
                .buttonStyle(.borderedProminent).disabled(surface.busy)
                .accessibilityIdentifier("thread-computer-surface-hand-back")
            }
            .padding(12)
        }
    }

    private static let keys: [(title: String, key: String, accessibility: String)] = [
        ("Return", "Enter", "Return"), ("Esc", "Escape", "Escape, stops your control"), ("Tab", "Tab", "Tab"),
        ("⌫", "Backspace", "Delete"), ("←", "ArrowLeft", "Left arrow"), ("↑", "ArrowUp", "Up arrow"),
        ("↓", "ArrowDown", "Down arrow"), ("→", "ArrowRight", "Right arrow")
    ]

    private static let chords: [(title: String, key: String, modifiers: [String])] = [
        ("Copy  ⌘C", "C", ["meta"]), ("Paste  ⌘V", "V", ["meta"]), ("Cut  ⌘X", "X", ["meta"]),
        ("Undo  ⌘Z", "Z", ["meta"]), ("Redo  ⇧⌘Z", "Z", ["shift", "meta"]), ("Select all  ⌘A", "A", ["meta"]),
        ("Spotlight  ⌘Space", "Space", ["meta"])
    ]
}

/// The stream's health; changes only when the connection does, never per frame.
private struct ComputerSurfaceStreamLabel: View {
    let frames: PathwayComputerSurfaceStream

    var body: some View {
        switch frames.state {
        case .connecting: Text("Connecting…").font(.caption).foregroundStyle(.secondary)
        case .live: Text("Live").font(.caption).foregroundStyle(.secondary)
        case .stale: Text("Reconnecting…").font(.caption).foregroundStyle(.orange)
        case .failed: Text("Offline").font(.caption).foregroundStyle(.red)
        }
    }
}

/// The only view that redraws per frame. With control, a tap clicks, a double tap
/// double-clicks, touch and hold right-clicks, and a two-finger pan scrolls. Pointer
/// down/move/up are never sent, so drags stay off even on hosts with pointer phases.
private struct ComputerSurfaceScreen: View {
    let surface: PathwayComputerSurfaceModel
    let interactive: Bool
    @Environment(\.displayScale) private var displayScale

    var body: some View {
        let frames = surface.frames
        ZStack {
            Color.black
            if let image = frames.image {
                Image(decorative: image, scale: 1).resizable().scaledToFit()
                    .opacity(frames.state == .live ? 1 : 0.6)
                    .accessibilityLabel(interactive
                        ? "The computer's screen. You have control: tap to click, double-tap to double-click, touch and hold to right-click, and scroll with two fingers."
                        : "Live view of the computer's screen")
                if interactive {
                    ComputerSurfaceTouches(
                        tap: { location, box, count in
                            guard let point = point(location, box) else { return }
                            surface.send(PathwayComputerSurfaceInput.click(point, clickCount: count))
                        },
                        longPress: { location, box in
                            guard let point = point(location, box) else { return }
                            surface.send(PathwayComputerSurfaceInput.click(point, button: "right"))
                        },
                        pan: { location, box, translation in
                            guard let point = point(location, box), let screen = frames.screenSize else { return }
                            let scale = min(box.width / screen.width, box.height / screen.height)
                            guard scale > 0 else { return }
                            // Content follows the fingers, as scrolling does on the phone.
                            surface.scroll(at: point, deltaX: -translation.x / scale, deltaY: -translation.y / scale)
                        }
                    )
                }
            }
            if frames.image == nil || frames.state == .failed {
                VStack(spacing: 8) {
                    Image(systemName: "desktopcomputer")
                    Text(frames.state == .failed ? "The screen stream is offline." : "Connecting to the screen…")
                    if frames.state == .failed {
                        Button("Reconnect") { frames.reconnect() }.buttonStyle(.bordered)
                    }
                }
                .font(.callout).foregroundStyle(.white.opacity(0.8))
                .padding()
                .background(.black.opacity(frames.image == nil ? 0 : 0.6), in: .rect(cornerRadius: 12))
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .onGeometryChange(for: CGSize.self) { $0.size } action: { surface.setViewport($0, scale: displayScale) }
    }

    private func point(_ location: CGPoint, _ box: CGSize) -> CGPoint? {
        guard let screen = surface.frames.screenSize else { return nil }
        return PathwayComputerSurfaceInput.point(location, in: box, screen: screen)
    }
}

/// UIKit recognizers, so a single tap waits for a double tap to fail and a pan can
/// require two fingers. Locations are in the overlay, which covers the fitted image's box.
private struct ComputerSurfaceTouches: UIViewRepresentable {
    let tap: (CGPoint, CGSize, Int) -> Void
    let longPress: (CGPoint, CGSize) -> Void
    let pan: (CGPoint, CGSize, CGPoint) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(parent: self) }

    func makeUIView(context: Context) -> UIView {
        let view = UIView()
        view.backgroundColor = .clear
        let coordinator = context.coordinator
        let double = UITapGestureRecognizer(target: coordinator, action: #selector(Coordinator.doubleTap(_:)))
        double.numberOfTapsRequired = 2
        let single = UITapGestureRecognizer(target: coordinator, action: #selector(Coordinator.singleTap(_:)))
        single.require(toFail: double)
        let long = UILongPressGestureRecognizer(target: coordinator, action: #selector(Coordinator.longPress(_:)))
        let pan = UIPanGestureRecognizer(target: coordinator, action: #selector(Coordinator.pan(_:)))
        pan.minimumNumberOfTouches = 2
        pan.maximumNumberOfTouches = 2
        [double, single, long, pan].forEach(view.addGestureRecognizer)
        return view
    }

    func updateUIView(_: UIView, context: Context) { context.coordinator.parent = self }

    @MainActor final class Coordinator: NSObject {
        var parent: ComputerSurfaceTouches
        init(parent: ComputerSurfaceTouches) { self.parent = parent }

        @objc func singleTap(_ recognizer: UITapGestureRecognizer) { tap(recognizer, count: 1) }
        @objc func doubleTap(_ recognizer: UITapGestureRecognizer) { tap(recognizer, count: 2) }

        private func tap(_ recognizer: UITapGestureRecognizer, count: Int) {
            guard recognizer.state == .ended, let view = recognizer.view else { return }
            parent.tap(recognizer.location(in: view), view.bounds.size, count)
        }

        @objc func longPress(_ recognizer: UILongPressGestureRecognizer) {
            guard recognizer.state == .began, let view = recognizer.view else { return }
            parent.longPress(recognizer.location(in: view), view.bounds.size)
        }

        @objc func pan(_ recognizer: UIPanGestureRecognizer) {
            guard [.began, .changed].contains(recognizer.state), let view = recognizer.view else { return }
            let translation = recognizer.translation(in: view)
            recognizer.setTranslation(.zero, in: view)
            guard translation != .zero else { return }
            parent.pan(recognizer.location(in: view), view.bounds.size, translation)
        }
    }
}
