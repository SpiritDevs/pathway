import SwiftUI
import UIKit

/// Streams one remote browser tab at the view's size and draws its frames. Streaming pauses
/// while the view is gone or the app is in the background.
struct RemoteBrowserSurfaceView: View {
    let stream: PathwayEnvironmentSurfaceStream
    let threadID: String
    let tabID: String
    var compact = false
    @Environment(\.displayScale) private var displayScale
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        RemoteBrowserSurfaceCanvas(stream: stream)
            .onGeometryChange(for: CGSize.self, of: \.size) { size in
                stream.setViewport(PathwaySurfaceViewport(size: size, displayScale: displayScale))
            }
            .overlay {
                if !stream.hasFrame {
                    // A compact surface's owner shows its own failure, outside any tap target.
                    if stream.state.isDown && !compact {
                        VStack(spacing: 8) {
                            Text(PathwaySurfaceIndicator(state: stream.state, quality: nil).label)
                            Button("Reconnect") { stream.reconnect() }.font(.caption.bold())
                        }.font(.caption).foregroundStyle(.secondary)
                    } else if !stream.state.isDown {
                        ProgressView(compact ? "" : "Connecting…").font(.caption)
                    }
                }
            }
            .overlay(alignment: .bottomTrailing) {
                if !compact && stream.hasFrame { RemoteBrowserSurfaceIndicator(stream: stream).padding(8) }
            }
            .task(id: "\(tabID):\(scenePhase == .background):\(stream.reconnects)") {
                guard scenePhase != .background else { return }
                await stream.run(threadID: threadID, tabID: tabID)
            }
    }
}

/// Connection state and frame rate, matching the web remote browser's indicator.
private struct RemoteBrowserSurfaceIndicator: View {
    let stream: PathwayEnvironmentSurfaceStream

    var body: some View {
        let indicator = PathwaySurfaceIndicator(state: stream.state, quality: stream.quality)
        HStack(spacing: 5) {
            Circle().fill(color(indicator.tone)).frame(width: 6, height: 6)
            Text(indicator.label).monospacedDigit()
        }
        .font(.caption2)
        .padding(.horizontal, 8).padding(.vertical, 4)
        .background(.ultraThinMaterial, in: .capsule)
        .allowsHitTesting(false)
        .accessibilityElement(children: .combine)
    }

    private func color(_ tone: PathwaySurfaceIndicator.Tone) -> Color {
        switch tone {
        case .live: .green
        case .degraded: .orange
        case .offline: .red
        }
    }
}

/// Puts frames straight into a layer, so a new frame never re-renders SwiftUI.
private struct RemoteBrowserSurfaceCanvas: UIViewRepresentable {
    let stream: PathwayEnvironmentSurfaceStream

    func makeUIView(context: Context) -> UIView {
        let view = UIView()
        view.isUserInteractionEnabled = false
        view.layer.contentsGravity = .resizeAspect
        stream.onFrame = { [weak view] image in view?.layer.contents = image }
        return view
    }

    func updateUIView(_ view: UIView, context: Context) {}

    static func dismantleUIView(_ view: UIView, coordinator: ()) {
        view.layer.contents = nil
    }
}
