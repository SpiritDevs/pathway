import Foundation
@testable import Pathway
import Testing

@MainActor
struct PathwayMarkdownFileLinkTests {
    @Test func opensTheReportedMarkdownLinkThroughItsEnvironment() async throws {
        let root = "/Users/coreybaines/.pathway/worktrees/pathway/pathway-c5d114c3"
        let markdown = "[Design and verification notes](\(root)/docs/plans/report-a-bug.md)"
        let text = try AttributedString(markdown: markdown, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))
        let url = try #require(text.runs.compactMap(\.link).first)
        let link = try #require(PathwayMarkdownFileLink(url: url))
        let path = try #require(link.relativePath(in: root))
        #expect(path == "docs/plans/report-a-bug.md")
        let client = PathwayWorkspaceClient(context: .init(threadID: "source-thread", projectID: "project", cwd: root, projectRoot: "/original-checkout")) { method, payload in
            #expect(method == "projects.readFile")
            #expect(payload.objectValue?["cwd"] == .string(root))
            #expect(payload.objectValue?["relativePath"] == .string("docs/plans/report-a-bug.md"))
            return .object(["contents": .string("# Report a bug"), "truncated": .bool(false), "byteLength": .number(14)])
        }
        #expect(try await client.readFile(path).contents == "# Report a bug")
    }

    @Test func resolvesRelativeEncodedAndFileURLReferences() throws {
        for (href, expected) in [
            ("docs/report.md", "docs/report.md"),
            ("./docs/../notes.md", "notes.md"),
            ("/repo/notes%20and%20research.md", "notes and research.md"),
            ("file:///repo/notes%2520.md", "notes%20.md"),
            ("docs/a%23b%3Fc%25.md", "docs/a#b?c%.md"),
            ("file://localhost/repo/notes.md", "notes.md")
        ] {
            let link = try fileLink(href)
            #expect(link.relativePath(in: "/repo") == expected)
        }
    }

    @Test func separatesLineLocationsFromFileNames() throws {
        for href in ["src/app.swift:42", "src/app.swift:42:7", "src/app.swift#L42", "src/app.swift#L42C7", "file:///repo/src/app.swift#L42C7"] {
            let link = try fileLink(href)
            #expect(link.relativePath(in: "/repo") == "src/app.swift")
            #expect(link.line == 42)
        }
        let bare = try fileLink("app.swift:12")
        #expect(bare.path == "app.swift")
        #expect(bare.line == 12)
    }

    @Test func keepsWebMailAndProductLinksOutOfTheFileViewer() throws {
        for href in ["https://example.com/report.md", "http://localhost:3000/report.md", "mailto:team@example.com", "mailto:123", "tel:5551234", "pathway://threads/environment/thread", "//example.com/report.md", "#section", "javascript:alert(1)", "sandbox:/mnt/data/report.md", "file:///repo/a%00.md"] {
            let url = try #require(URL(string: href))
            #expect(PathwayMarkdownFileLink(url: url) == nil)
        }
    }

    @Test func usesRemoteWindowsPathsWithoutThePhonesPathRules() throws {
        for href in ["C:/work/docs/report.md", "C:%5Cwork%5Cdocs%5Creport.md", "file:///C:/work/docs/report.md"] {
            let link = try fileLink(href)
            #expect(link.relativePath(in: #"C:\work"#) == "docs/report.md")
        }
        let unc = try fileLink("file://server/share/report.md")
        #expect(unc.relativePath(in: #"\\server\share"#) == "report.md")
    }

    @Test func doesNotSwitchToAnotherCheckoutOrEscapeTheWorkspace() throws {
        for href in ["/repo-other/notes.md", "/repo/../private.md", "../private.md", "docs/../../private.md", "/original-checkout/notes.md", "file:///etc/passwd"] {
            let link = try fileLink(href)
            #expect(link.relativePath(in: "/repo") == nil)
        }
    }

    private func fileLink(_ href: String) throws -> PathwayMarkdownFileLink {
        let url = try #require(URL(string: href))
        return try #require(PathwayMarkdownFileLink(url: url))
    }
}
