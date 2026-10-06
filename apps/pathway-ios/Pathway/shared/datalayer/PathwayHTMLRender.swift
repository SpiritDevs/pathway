import Foundation
import UIKit

/// A page an agent published into its thread with `html_render`, shown inline above its reply.
/// The server stores the page as a thread attachment and normalizes the tool item, so this reads
/// only `output.htmlRender` of a completed `dynamic_tool` item. Mirrors `@pathway/shared/htmlRender`.
struct PathwayHTMLRender: Equatable, Sendable {
    /// A content height the server measured the page at for one frame width.
    struct Measured: Equatable, Sendable {
        let width: Double
        let height: Double
    }

    static let minHeight = 80.0
    static let maxHeight = 2_000.0
    /// The reply column's width on desktop. Agents size pages for it, so it decides whether the
    /// agent's height asked for a scrolling frame.
    static let columnWidth = 728.0
    private static let maxTitleLength = 200
    private static let maxMeasurements = 24

    let attachmentID: String
    let title: String
    /// The agent's frame height in CSS pixels.
    let height: Double
    /// Ascending by width; empty when the environment could not measure the page.
    let heights: [Measured]

    init?(_ item: PathwayTimelineItem) {
        guard item.type == "dynamic_tool", item.status == "completed",
              Self.htmlTool(item.fields["toolName"]?.stringValue) == "html_render",
              let output = item.fields["output"]?.objectValue, output["isError"]?.boolValue != true else { return nil }
        self.init(reference: output["htmlRender"])
    }

    init?(reference: JSONValue?) {
        guard let reference = reference?.objectValue,
              let attachmentID = reference["attachmentId"]?.stringValue, (1...256).contains(attachmentID.utf16.count),
              let title = reference["title"]?.stringValue,
              case let .number(height)? = reference["height"], height.isFinite else { return nil }
        let trimmed = Self.prefix(title.trimmingCharacters(in: Self.whitespace), length: Self.maxTitleLength)
        self.attachmentID = attachmentID
        self.title = trimmed.isEmpty ? "HTML" : trimmed
        self.height = Self.clamp(height)
        heights = Self.measured(reference["heights"]) ?? []
    }

    /// The Pathway HTML tool (`html_render` or `html_preview`) a tool name refers to, in the
    /// spellings providers have used. New items always carry `pathway.html_render`.
    static func htmlTool(_ toolName: String?) -> String? {
        guard let toolName else { return nil }
        let label = toolName.replacingOccurrences(of: #"\s+(?:complete|completed)\s*$"#, with: "", options: [.regularExpression, .caseInsensitive])
            .trimmingCharacters(in: whitespace)
        let pattern = #"^(?:mcp__(?i:pathway|pathway_code)__|(?i:pathway|pathway_code)[.:/_])?(html_render|html_preview)$"#
        guard label.range(of: pattern, options: .regularExpression) != nil else { return nil }
        return label.hasSuffix("html_render") ? "html_render" : "html_preview"
    }

    /// The work-row label for a running or failed HTML tool call.
    static func toolLabel(_ toolName: String?) -> String? {
        switch htmlTool(toolName) {
        case "html_render": "Render an HTML page"
        case "html_preview": "Preview an HTML page"
        default: nil
        }
    }

    /// The frame height at a frame width: the page's own reported content height once it has one,
    /// else the server's measurement for that width. The agent's height caps it only when it is
    /// below the page's height at the column width (a scrolling frame) or the page is unmeasured.
    func frameHeight(width: Double, contentHeight: Double? = nil) -> Double {
        guard !heights.isEmpty else { return Self.clamp(min(height, contentHeight ?? height)) }
        let cap = measuredHeight(at: Self.columnWidth) > height ? height : Self.maxHeight
        return Self.clamp(min(cap, contentHeight ?? measuredHeight(at: width)))
    }

    /// A readable download name: the title without characters file systems reject.
    var fileName: String {
        let name = title
            .replacingOccurrences(of: #"[\\/:*?"<>|\p{Cc}]+"#, with: " ", options: .regularExpression)
            .replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
            .trimmingCharacters(in: Self.whitespace)
        let clipped = Self.prefix(name, length: 120).trimmingCharacters(in: Self.whitespace)
        return "\(clipped.isEmpty ? "Page" : clipped).html"
    }

    /// The `assets.createUrl` resource that serves the stored page inline.
    var assetResource: JSONValue {
        .object([
            "_tag": .string("attachment"), "attachmentId": .string(attachmentID), "fileName": .string(fileName),
            "mimeType": .string("text/html"), "disposition": .string("inline")
        ])
    }

    // The taller of the heights measured at the nearest widths on each side. A breakpoint
    // between two measured widths can make the page as tall as either.
    private func measuredHeight(at width: Double) -> Double {
        let high = heights.firstIndex { $0.width >= width } ?? heights.count - 1
        let low = heights[high].width == width ? high : max(0, high - 1)
        return max(heights[low].height, heights[high].height)
    }

    private static func measured(_ value: JSONValue?) -> [Measured]? {
        guard let entries = value?.arrayValue, (1...maxMeasurements).contains(entries.count) else { return nil }
        var measured: [Measured] = []
        for entry in entries {
            guard let pair = entry.arrayValue, pair.count == 2,
                  case let .number(width) = pair[0], width.rounded() == width, (1...10_000).contains(width),
                  case let .number(height) = pair[1], height.isFinite, height > 0 else { return nil }
            measured.append(Measured(width: width, height: clamp(height)))
        }
        measured.sort { $0.width < $1.width }
        return zip(measured, measured.dropFirst()).allSatisfy { $0.width < $1.width } ? measured : nil
    }

    private static func clamp(_ height: Double) -> Double {
        min(maxHeight, max(minHeight, height.rounded()))
    }

    // JavaScript trim/slice operate on ECMAScript whitespace and UTF-16 code units.
    private static let whitespace = CharacterSet(charactersIn: "\u{0009}\u{000A}\u{000B}\u{000C}\u{000D}\u{0020}\u{00A0}\u{1680}\u{2000}\u{2001}\u{2002}\u{2003}\u{2004}\u{2005}\u{2006}\u{2007}\u{2008}\u{2009}\u{200A}\u{2028}\u{2029}\u{202F}\u{205F}\u{3000}\u{FEFF}")
    private static func prefix(_ value: String, length: Int) -> String {
        String(decoding: value.utf16.prefix(length), as: UTF16.self)
    }
}

/// The theme a page styles against: CSS custom properties named as on web, filled from the
/// iOS system palette, which is what the conversation around the page uses.
struct PathwayHTMLRenderTheme: Equatable, Sendable {
    let appearance: String
    let variables: [String: String]

    static let fonts = (
        sans: #"-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif"#,
        mono: #""SF Mono", "SFMono-Regular", Menlo, Consolas, "Liberation Mono", monospace"#
    )
    // A categorical series after the accent, the same as web's.
    private static let chart = (
        light: ["#0d9488", "#d97706", "#9333ea", "#e11d48", "#65a30d"],
        dark: ["#2dd4bf", "#fbbf24", "#c084fc", "#fb7185", "#a3e635"]
    )
    private static let uriComponentCharacters = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.!~*'()")

    static func current(_ traits: UITraitCollection) -> Self {
        let dark = traits.userInterfaceStyle == .dark
        func css(_ color: UIColor, opacity: CGFloat = 1) -> String {
            let resolved = color.resolvedColor(with: traits)
            return Self.css(resolved.withAlphaComponent(resolved.cgColor.alpha * opacity))
        }
        let tint = UIColor.tintColor
        var variables = [
            "--background": css(.systemBackground),
            "--foreground": css(.label),
            "--muted": css(.secondarySystemBackground),
            "--muted-foreground": css(.secondaryLabel),
            "--card": css(.secondarySystemBackground),
            "--card-foreground": css(.label),
            "--popover": css(.tertiarySystemBackground),
            "--popover-foreground": css(.label),
            "--secondary": css(.secondarySystemFill),
            "--secondary-foreground": css(.label),
            "--border": css(.separator),
            "--input": css(.separator),
            "--ring": css(tint),
            "--primary": css(tint),
            "--primary-foreground": css(.white),
            "--accent": css(tint),
            "--accent-foreground": css(.white),
            "--accent-surface": css(tint, opacity: 0.12),
            "--accent-surface-foreground": css(tint),
            "--destructive": css(.systemRed),
            "--destructive-foreground": css(.systemRed),
            "--destructive-surface": css(.systemRed, opacity: 0.12),
            "--warning": css(.systemOrange),
            "--warning-foreground": css(.systemOrange),
            "--warning-surface": css(.systemOrange, opacity: 0.12),
            "--success": css(.systemGreen),
            "--success-foreground": css(.systemGreen),
            "--info": css(.systemBlue),
            "--info-foreground": css(.systemBlue),
            "--code-background": css(.secondarySystemBackground),
            "--code-foreground": css(.label),
            "--chart-1": css(tint),
            "--radius": "0.625rem",
            "--font-sans": fonts.sans,
            "--font-mono": fonts.mono
        ]
        for (index, color) in (dark ? chart.dark : chart.light).enumerated() { variables["--chart-\(index + 2)"] = color }
        return Self(appearance: dark ? "dark" : "light", variables: variables)
    }

    /// `#pathway-theme=<json>`: the page's bootstrap reads it before first paint, then drops it.
    var fragment: String {
        let json = Self.json(.object(["appearance": .string(appearance), "variables": .object(variables.mapValues(JSONValue.string))]))
        return "#pathway-theme=" + (json.addingPercentEncoding(withAllowedCharacters: Self.uriComponentCharacters) ?? "")
    }

    /// Posts the MCP Apps `host-context-changed` notification a loaded page restyles on.
    var hostContextChangedScript: String {
        let message = JSONValue.object([
            "jsonrpc": .string("2.0"), "method": .string("ui/notifications/host-context-changed"),
            "params": .object(["theme": .string(appearance), "styles": .object(["variables": .object(variables.mapValues(JSONValue.string))])])
        ])
        return "window.postMessage(\(Self.json(message)), \"*\");"
    }

    static func css(_ color: UIColor) -> String {
        var red: CGFloat = 0, green: CGFloat = 0, blue: CGFloat = 0, alpha: CGFloat = 0
        color.getRed(&red, green: &green, blue: &blue, alpha: &alpha)
        let channels = [red, green, blue].map { Int((min(1, max(0, $0)) * 255).rounded()) }
        if alpha >= 0.999 { return String(format: "#%02x%02x%02x", channels[0], channels[1], channels[2]) }
        return "rgba(\(channels[0]), \(channels[1]), \(channels[2]), \(String(format: "%.3g", Double(max(0, alpha)))))"
    }

    private static func json(_ value: JSONValue) -> String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return (try? encoder.encode(value)).map { String(decoding: $0, as: UTF8.self) } ?? "{}"
    }
}
