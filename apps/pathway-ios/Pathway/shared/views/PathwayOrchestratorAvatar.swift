import SwiftUI

struct PathwayOrchestratorLauncherAvatar: View {
    @Environment(PathwayAppModel.self) private var appModel

    var body: some View {
        PathwayOrchestratorAvatar(contact: appModel.cloud.orchestrators.personalContact, size: 36, idle: true)
    }
}

/// Shared character geometry keeps navigation, conversations and participants consistent.
struct PathwayOrchestratorAvatar: View {
    let contact: PathwayOrchestratorRecord?
    var size: CGFloat = 40
    var idle = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase
    @State private var eyeScale: CGFloat = 1
    @State private var gaze = CGSize.zero
    @State private var tilt = 0.0

    private var appearance: [String: JSONValue] {
        contact?.fields["avatar"]?.objectValue ?? [:]
    }

    private func trait(_ name: String, default value: Double) -> Double {
        let personality = contact?.fields["personality"]?.objectValue
        let setting = personality?["avatar"]?.objectValue?[name] ?? personality?["shared"]?.objectValue?[name]
        return min(100, max(0, Double(setting?.intValue ?? Int(value))))
    }

    private var tint: Color {
        switch contact?.string("color") ?? "violet" {
        case "blue": Color(red: 0.169, green: 0.498, blue: 1)
        case "green": Color(red: 0, green: 0.737, blue: 0.490)
        case "amber": Color(red: 0.996, green: 0.604, blue: 0)
        case "pink": Color(red: 0.965, green: 0.200, blue: 0.604)
        case "cyan": Color(red: 0, green: 0.573, blue: 0.722)
        default: Color(red: 0.557, green: 0.318, blue: 1)
        }
    }

    private var eyeSize: CGSize {
        switch appearance["eyes"]?.stringValue {
        case "wide": CGSize(width: 13, height: 23)
        case "round": CGSize(width: 12, height: 12)
        case "soft": CGSize(width: 10, height: 14)
        default: CGSize(width: 10, height: 23)
        }
    }

    private var animates: Bool { idle && !reduceMotion && scenePhase == .active }
    private var unit: CGFloat { size / 100 }

    var body: some View {
        ZStack {
            PathwayAvatarSilhouette(shape: appearance["shape"]?.stringValue ?? "round")
                .fill(tint)
            HStack(spacing: (26 - eyeSize.width) * unit) {
                ForEach(0..<2) { _ in
                    PathwayAvatarEye()
                        .fill(.white)
                        .frame(width: eyeSize.width * unit, height: eyeSize.height * unit)
                }
            }
            .scaleEffect(y: animates ? eyeScale : 1)
            .offset(x: animates ? gaze.width : 0, y: -2 * unit + (animates ? gaze.height : 0))
        }
        .frame(width: size, height: size)
        .rotationEffect(.degrees(animates ? tilt : 0))
        .accessibilityHidden(true)
        .task(id: animates) {
            guard animates else { return }
            defer {
                var transaction = Transaction()
                transaction.disablesAnimations = true
                withTransaction(transaction) { eyeScale = 1; gaze = .zero; tilt = 0 }
            }
            do {
                try await Task.sleep(for: .seconds(Double.random(in: 0.6...1.3)))
                var gesture = 0
                while !Task.isCancelled {
                    gesture += 1
                    withAnimation(.easeOut(duration: 0.075)) { eyeScale = 0.08 }
                    try await Task.sleep(for: .milliseconds(110))
                    withAnimation(.easeOut(duration: 0.1)) { eyeScale = 1 }
                    if gesture.isMultiple(of: 2) {
                        let direction = gesture.isMultiple(of: 4) ? -1.0 : 1.0
                        withAnimation(.easeInOut(duration: 0.3)) {
                            gaze = CGSize(width: direction * (3 + trait("curiosity", default: 45) / 25) * unit, height: -2 * unit)
                            tilt = direction * 1.5 * (0.4 + trait("expressiveness", default: 35) / 120)
                        }
                        try await Task.sleep(for: .milliseconds(700))
                        withAnimation(.easeInOut(duration: 0.3)) { gaze = .zero; tilt = 0 }
                    }
                    // Real pauses between finite gestures; no display timer while idle.
                    try await Task.sleep(for: .seconds(2 - trait("energy", default: 25) * 0.006 + Double.random(in: 0...0.9)))
                }
            } catch { /* Disappearing, backgrounding or Reduce Motion cancels the idle task. */ }
        }
    }
}

struct PathwayOrchestratorConversationAvatar: View {
    let contacts: [PathwayOrchestratorRecord]

    var body: some View {
        if contacts.count <= 1 {
            PathwayOrchestratorAvatar(contact: contacts.first)
        } else {
            HStack(spacing: -8) {
                ForEach(contacts.prefix(3)) { contact in
                    PathwayOrchestratorAvatar(contact: contact, size: 36)
                }
            }
        }
    }
}

private struct PathwayAvatarSilhouette: Shape {
    let shape: String

    func path(in rect: CGRect) -> Path {
        let points = (0..<32).map { index -> CGPoint in
            let angle = Double(index) / 32 * .pi * 2 - .pi / 2
            let x = cos(angle), y = sin(angle)
            let radius: Double
            switch shape {
            case "squircle": radius = 41 / pow(pow(x, 4) + pow(y, 4), 0.25)
            case "pebble": radius = 40 + 2 * sin(3 * angle + 1)
            case "cloud": radius = 36 + 5 * cos(5 * angle + 0.5)
            case "flower": radius = 34 + 8 * cos(6 * angle)
            case "drop":
                return CGPoint(x: (50 + 40 * x * (0.72 + 0.28 * y)) * rect.width / 100 + rect.minX,
                               y: (50 + 43 * y) * rect.height / 100 + rect.minY)
            default: radius = 42
            }
            return CGPoint(x: (50 + radius * x) * rect.width / 100 + rect.minX,
                           y: (50 + radius * y) * rect.height / 100 + rect.minY)
        }
        var path = Path()
        path.move(to: points[0])
        for index in points.indices {
            let previous = points[(index + 31) % 32], start = points[index]
            let end = points[(index + 1) % 32], next = points[(index + 2) % 32]
            path.addCurve(to: end,
                          control1: CGPoint(x: start.x + (end.x - previous.x) / 6, y: start.y + (end.y - previous.y) / 6),
                          control2: CGPoint(x: end.x - (next.x - start.x) / 6, y: end.y - (next.y - start.y) / 6))
        }
        path.closeSubpath()
        return path
    }
}

private struct PathwayAvatarEye: Shape {
    func path(in rect: CGRect) -> Path {
        var path = Path()
        path.move(to: CGPoint(x: rect.minX, y: rect.midY))
        path.addCurve(to: CGPoint(x: rect.midX, y: rect.minY),
                      control1: CGPoint(x: rect.minX, y: rect.minY + rect.height * 0.1),
                      control2: CGPoint(x: rect.minX + rect.width * 0.1, y: rect.minY))
        path.addCurve(to: CGPoint(x: rect.maxX, y: rect.midY),
                      control1: CGPoint(x: rect.maxX - rect.width * 0.1, y: rect.minY),
                      control2: CGPoint(x: rect.maxX, y: rect.minY + rect.height * 0.1))
        path.addCurve(to: CGPoint(x: rect.midX, y: rect.maxY),
                      control1: CGPoint(x: rect.maxX, y: rect.maxY - rect.height * 0.1),
                      control2: CGPoint(x: rect.maxX - rect.width * 0.1, y: rect.maxY))
        path.addCurve(to: CGPoint(x: rect.minX, y: rect.midY),
                      control1: CGPoint(x: rect.minX + rect.width * 0.1, y: rect.maxY),
                      control2: CGPoint(x: rect.minX, y: rect.maxY - rect.height * 0.1))
        path.closeSubpath()
        return path
    }
}
