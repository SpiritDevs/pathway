import Foundation
@testable import Pathway
import Testing

@MainActor
struct PathwayMarkdownImageTests {
    @Test func resolvesEnvironmentPathsWithoutClientFilesystemAssumptions() {
        for (source, expected) in [
            ("/Users/coreybaines/GitHub/pathway/.pathway/evidence/thread-environment-right.jpg", "/Users/coreybaines/GitHub/pathway/.pathway/evidence/thread-environment-right.jpg"),
            ("./screens/你好%20world.png", "./screens/你好 world.png"),
            ("screens/a%23b%3Fc%25.png", "screens/a#b?c%.png"),
            ("screens/a%2520.png", "screens/a%20.png"),
            ("file:///Users/me/a%20b.png", "/Users/me/a b.png"),
            ("file:///C:/work/a%20b.png", "C:/work/a b.png"),
            ("file://server/share/a.png", "//server/share/a.png"),
            (#"C:\work\a.png"#, #"C:\work\a.png"#),
            ("C:%5Cwork%5Ca.png", #"C:\work\a.png"#),
            ("../escape.png", "../escape.png")
        ] { #expect(PathwayMarkdownImageSource.resolve(source) == .workspace(expected)) }
        for workspace in ["/project", "/worktree", "/conversations/id", #"C:\work"#] {
            #expect(PathwayMarkdownImageSource.resolve("./image.png", workspace: workspace) == .workspace("./image.png"))
        }
    }

    @Test func distinguishesWebImagesAndUnsupportedReferences() throws {
        let https = try #require(URL(string: "https://images.example/a.png?size=2"))
        #expect(PathwayMarkdownImageSource.resolve(https.absoluteString) == .web(https))
        #expect(PathwayMarkdownImageSource.resolve("/images/a.png") == .unavailable)
        #expect(PathwayMarkdownImageSource.resolve("/custom/work/a.png", workspace: "/custom/work") == .workspace("/custom/work/a.png"))
        for source in ["sandbox:/mnt/data/a.png", "javascript:alert(1)", "data:image/png;base64,AA", "a%00.png", "a%zz.png", ""] {
            #expect(PathwayMarkdownImageSource.resolve(source) == .unavailable)
        }
    }

    @Test func parsesTheHistoricalExampleInlineImagesAndLinkedImages() throws {
        let path = "/Users/coreybaines/GitHub/pathway/.pathway/evidence/thread-environment-right.jpg"
        let parts = PathwayMarkdownInlinePart.parse("Before [![Environment name aligned beside the agent icon](\(path))](https://example.com) after")
        #expect(parts.count == 3)
        guard case let .image(source, alt, link) = parts[1].content else { Issue.record("Expected image"); return }
        #expect(source == path)
        #expect(alt == "Environment name aligned beside the agent icon")
        #expect(link?.absoluteString == "https://example.com")
        for markdown in ["![Alt](<file:///tmp/a%20b.png>)", "![Alt](./a(b).png)", "![Alt](./a.png \"Title\")", "![](./a.png)"] {
            let image = try #require(PathwayMarkdownInlinePart.parse(markdown).first)
            guard case .image = image.content else { Issue.record("Expected image for \(markdown)"); continue }
        }
        let windows = try #require(PathwayMarkdownInlinePart.parse(#"![Alt](C:\work\a.png)"#).first)
        if case let .image(source, _, _) = windows.content { #expect(PathwayMarkdownImageSource.resolve(source) == .workspace(#"C:\work\a.png"#)) }
        else { Issue.record("Expected Windows image") }
        for markdown in ["`![Alt](./a.png)`", #"\![Alt](./a.png)"#, "![incomplete](./a.png"] {
            #expect(PathwayMarkdownInlinePart.parse(markdown).count == 1)
            guard case .text = PathwayMarkdownInlinePart.parse(markdown)[0].content else { Issue.record("Expected literal text"); continue }
        }
    }

    @Test func signedURLsUseTheirPreparedEnvironmentAndRejectExpiredCapabilities() throws {
        let response: JSONValue = .object(["relativeUrl": .string("/api/assets/token/a.png"), "expiresAt": .number(Date().timeIntervalSince1970 * 1000 + 3_600_000)])
        for host in ["direct.example", "connect.example", "tunnel.example"] {
            let base = try #require(URL(string: "https://\(host)"))
            #expect(try PathwayEnvironmentHTTP.signedAssetURL(response, base: base).absoluteString == "https://\(host)/api/assets/token/a.png")
        }
        let base = try #require(URL(string: "https://owner.example"))
        #expect(throws: (any Error).self) {
            try PathwayEnvironmentHTTP.signedAssetURL(.object(["relativeUrl": .string("/api/assets/token/a.png"), "expiresAt": .number(0)]), base: base)
        }
        for relative in ["https://elsewhere.example/api/assets/a.png", "//elsewhere.example/api/assets/a.png", "/Users/me/a.png", "/api/assets/../../private"] {
            #expect(throws: (any Error).self) { try PathwayEnvironmentHTTP.signedAssetURL(.object(["relativeUrl": .string(relative)]), base: base) }
        }
    }
}
