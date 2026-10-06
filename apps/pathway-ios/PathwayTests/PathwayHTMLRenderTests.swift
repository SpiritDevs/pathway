import Foundation
@testable import Pathway
import Testing
import UIKit

@MainActor
struct PathwayHTMLRenderTests {
    private let reference: JSONValue = .object(["attachmentId": .string("thread-abc-123-html"), "title": .string("Chart"), "height": .number(420)])

    @Test func readsCompletedRendersInEveryToolSpelling() throws {
        for toolName in ["pathway.html_render", "mcp__pathway__html_render", "html_render", "pathway_html_render",
                         "mcp__pathway_code__html_render", "pathway_code.html_render", "pathway_code/html_render", "pathway:html_render",
                         "pathway_code_html_render", "mcp__PATHWAY__html_render", "PATHWAY/html_render", "  pathway.html_render completed  "] {
            let render = try #require(PathwayHTMLRender(try item(toolName: toolName)), "\(toolName)")
            #expect(render.attachmentID == "thread-abc-123-html")
            #expect(render.title == "Chart")
            #expect(render.height == 420)
            #expect(render.heights.isEmpty)
        }
    }

    @Test func leavesRunningFailedErroredAndOtherToolsAsWorkRows() throws {
        let output: JSONValue = .object(["htmlRender": reference])
        #expect(PathwayHTMLRender(try item(status: "running")) == nil)
        #expect(PathwayHTMLRender(try item(status: "failed")) == nil)
        #expect(PathwayHTMLRender(try item(status: "cancelled")) == nil)
        #expect(PathwayHTMLRender(try item(output: .object(["htmlRender": reference, "isError": .bool(true)]))) == nil)
        #expect(PathwayHTMLRender(try item(toolName: "pathway.html_preview", output: output)) == nil)
        #expect(PathwayHTMLRender(try item(toolName: "mcp__other__html_render", output: output)) == nil)
        #expect(PathwayHTMLRender(try item(toolName: "other.html_render", output: output)) == nil)
        #expect(PathwayHTMLRender(try item(toolName: "pathway.HTML_RENDER", output: output)) == nil)
        #expect(PathwayHTMLRender(try item(toolName: "MCP__pathway__html_render", output: output)) == nil)
        #expect(PathwayHTMLRender(try item(type: "command_execution", output: output)) == nil)
        #expect(PathwayHTMLRender(try item(output: .array([output]))) == nil)
        // A provider envelope is the server's to normalize, not a page.
        #expect(PathwayHTMLRender(try item(output: .object(["structuredContent": output]))) == nil)
        #expect(PathwayHTMLRender(try item(output: .string("{\"htmlRender\":{}}"))) == nil)
    }

    @Test func validatesTheReferenceLikeTheSharedReader() {
        func read(_ changes: [String: JSONValue]) -> PathwayHTMLRender? {
            guard case var .object(fields) = reference else { return nil }
            fields.merge(changes) { $1 }
            return PathwayHTMLRender(reference: .object(fields))
        }
        #expect(read(["height": .number(99_999)])?.height == 2_000)
        #expect(read(["height": .number(12)])?.height == 80)
        #expect(read(["height": .number(420.5)])?.height == 421)
        #expect(read(["title": .string("  ")])?.title == "HTML")
        #expect(read(["title": .string("  Revenue \n")])?.title == "Revenue")
        #expect(read(["title": .string(String(repeating: "a", count: 300))])?.title.count == 200)
        #expect(read(["title": .string(String(repeating: "😀", count: 150))])?.title.utf16.count == 200)
        #expect(read(["title": .string("\u{FEFF} Chart \u{FEFF}")])?.title == "Chart")
        #expect(read(["attachmentId": .number(4)]) == nil)
        #expect(read(["attachmentId": .string("")]) == nil)
        #expect(read(["attachmentId": .string(String(repeating: "a", count: 257))]) == nil)
        #expect(read(["title": .null]) == nil)
        #expect(read(["height": .string("420")]) == nil)
        #expect(read(["height": .number(.nan)]) == nil)
        #expect(read(["height": .number(.infinity)]) == nil)

        let sorted = read(["heights": heights([[728, 1403], [390, 1290], [1000, 1660]])])
        #expect(sorted?.heights.map(\.width) == [390, 728, 1000])
        #expect(read(["heights": heights([[728, 99_999]])])?.heights.first?.height == 2_000)
        // A malformed table is dropped whole; the page still shows at the agent's height.
        for malformed: JSONValue in [
            .array([.array([.number(728), .string("x")])]), heights([[728.5, 400]]), heights([[0, 400]]), heights([[10_001, 400]]),
            heights([[728, 0]]), heights([[728, -1]]), heights([[728, .infinity]]), heights([[728, 400], [728, 500]]), heights([]), heights(Array(repeating: [320, 400], count: 25)),
            .array([.array([.number(728)])]), .string("[[728,400]]")
        ] {
            let render = read(["heights": malformed])
            #expect(render != nil)
            #expect(render?.heights.isEmpty == true)
        }
    }

    /// The `htmlRenderFrameHeight` cases from `packages/shared/src/htmlRender.test.ts` (#16283), so the two stay in step.
    @Test func frameHeightMatchesTheSharedRule() throws {
        let fixture = """
        [
          {"reference": {"height": 1500, "heights": [[728, 1403], [390, 1290], [1000, 1660]]},
           "cases": [[728, null, 1403], [559, null, 1403], [320, null, 1290]]},
          {"reference": {"height": 2000, "heights": [[520, 900], [640, 450]]},
           "cases": [[590, null, 900], [640, null, 450]]},
          {"reference": {"height": 1403, "heights": [[728, 1403], [390, 1290], [1000, 1660]]},
           "cases": [[728, 1415, 1415], [1400, null, 1660], [728, 5000, 2000]]},
          {"reference": {"height": 600, "heights": [[728, 1403], [390, 1290], [1000, 1660]]},
           "cases": [[728, 1415, 600], [1400, null, 600]]},
          {"reference": {"height": 420},
           "cases": [[728, null, 420], [728, 900, 420], [728, 300, 300], [728, 20, 80]]}
        ]
        """
        let groups = try #require(try JSONDecoder().decode(JSONValue.self, from: Data(fixture.utf8)).arrayValue)
        for group in groups {
            guard case var .object(fields) = group.objectValue?["reference"], case let .object(base) = reference else { Issue.record("Bad fixture"); return }
            fields.merge(base) { current, _ in current }
            let render = try #require(PathwayHTMLRender(reference: .object(fields)))
            for value in group.objectValue?["cases"]?.arrayValue ?? [] {
                let row = try #require(value.arrayValue)
                guard case let .number(width) = row[0], case let .number(expected) = row[2] else { Issue.record("Bad case"); continue }
                let content: Double? = if case let .number(height) = row[1] { height } else { nil }
                #expect(render.frameHeight(width: width, contentHeight: content) == expected, "\(fields) at \(width), content \(String(describing: content))")
            }
        }
    }

    @Test func requestsTheStoredPageInline() throws {
        let render = try #require(PathwayHTMLRender(reference: .object([
            "attachmentId": .string("thread-abc-123-html"), "title": .string("Q3: revenue / costs?"), "height": .number(420)
        ])))
        #expect(render.assetResource == .object([
            "_tag": .string("attachment"), "attachmentId": .string("thread-abc-123-html"), "fileName": .string("Q3 revenue costs.html"),
            "mimeType": .string("text/html"), "disposition": .string("inline")
        ]))
        #expect(try #require(PathwayHTMLRender(reference: .object(["attachmentId": .string("a"), "title": .string("<>|"), "height": .number(80)]))).fileName == "Page.html")
        #expect(try #require(PathwayHTMLRender(reference: .object([
            "attachmentId": .string("a"), "title": .string(String(repeating: "😀", count: 100)), "height": .number(80)
        ]))).fileName.utf16.count == 125)
    }

    @Test func labelsRunningHtmlToolCalls() {
        #expect(PathwayHTMLRender.toolLabel("pathway.html_render") == "Render an HTML page")
        #expect(PathwayHTMLRender.toolLabel("mcp__pathway__html_preview") == "Preview an HTML page")
        #expect(PathwayHTMLRender.toolLabel("pathway.delegate_task") == nil)
        #expect(PathwayHTMLRender.toolLabel(nil) == nil)
    }

    @Test func themeHasTheSharedVariablesAndTheBridgeShapes() throws {
        // The variable names `htmlRenderTheme` produces in `packages/shared/src/htmlRender.ts`.
        let names: Set<String> = [
            "--background", "--foreground", "--muted", "--muted-foreground", "--card", "--card-foreground", "--popover",
            "--popover-foreground", "--secondary", "--secondary-foreground", "--border", "--input", "--ring", "--primary",
            "--primary-foreground", "--accent", "--accent-foreground", "--accent-surface", "--accent-surface-foreground",
            "--destructive", "--destructive-foreground", "--destructive-surface", "--warning", "--warning-foreground",
            "--warning-surface", "--success", "--success-foreground", "--info", "--info-foreground", "--code-background",
            "--code-foreground", "--chart-1", "--chart-2", "--chart-3", "--chart-4", "--chart-5", "--chart-6", "--radius",
            "--font-sans", "--font-mono"
        ]
        let dark = PathwayHTMLRenderTheme.current(UITraitCollection(userInterfaceStyle: .dark))
        let light = PathwayHTMLRenderTheme.current(UITraitCollection(userInterfaceStyle: .light))
        #expect(Set(dark.variables.keys) == names)
        #expect(dark.appearance == "dark" && light.appearance == "light")
        #expect(dark.variables["--background"] == "#000000")
        #expect(light.variables["--background"] == "#ffffff")
        #expect(dark.variables["--chart-2"] == "#2dd4bf")
        // The page's bootstrap drops any value with these characters.
        #expect(dark.variables.values.allSatisfy { $0.rangeOfCharacter(from: CharacterSet(charactersIn: ";{}<>")) == nil })

        let fragment = dark.fragment
        #expect(fragment.hasPrefix("#pathway-theme="))
        #expect(!fragment.contains("&") && !fragment.contains(" "))
        let encoded = try #require(fragment.dropFirst("#pathway-theme=".count).removingPercentEncoding)
        let decoded = try JSONDecoder().decode(JSONValue.self, from: Data(encoded.utf8))
        #expect(decoded == .object(["appearance": .string("dark"), "variables": .object(dark.variables.mapValues(JSONValue.string))]))
        #expect(URL(string: "https://environment.example/api/assets/token/Chart.html" + fragment) != nil)

        let script = light.hostContextChangedScript
        #expect(script.hasPrefix("window.postMessage(") && script.hasSuffix(", \"*\");"))
        let message = String(script.dropFirst("window.postMessage(".count).dropLast(", \"*\");".count))
        #expect(try JSONDecoder().decode(JSONValue.self, from: Data(message.utf8)) == .object([
            "jsonrpc": .string("2.0"), "method": .string("ui/notifications/host-context-changed"),
            "params": .object(["theme": .string("light"), "styles": .object(["variables": .object(light.variables.mapValues(JSONValue.string))])])
        ]))
    }

    @Test func writesCssColors() {
        #expect(PathwayHTMLRenderTheme.css(UIColor(red: 1, green: 0.5, blue: 0, alpha: 1)) == "#ff8000")
        #expect(PathwayHTMLRenderTheme.css(UIColor(red: 0, green: 0, blue: 1, alpha: 0.12)) == "rgba(0, 0, 255, 0.12)")
    }

    private func heights(_ rows: [[Double]]) -> JSONValue { .array(rows.map { .array($0.map(JSONValue.number)) }) }

    private func item(type: String = "dynamic_tool", toolName: String = "pathway.html_render", status: String = "completed",
                      output: JSONValue? = nil) throws -> PathwayTimelineItem {
        try #require(PathwayTimelineItem(json: .object([
            "id": .string("render"), "type": .string(type), "status": .string(status), "toolName": .string(toolName),
            "input": .object(["title": .string("Chart"), "height": .number(420), "htmlBytes": .number(2400)]),
            "output": output ?? .object(["htmlRender": reference, "message": .string("Rendered above your reply.")])
        ])))
    }
}
