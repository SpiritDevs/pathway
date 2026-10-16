import SwiftUI

/// Description blocks retain their layout; inline Markdown still uses Foundation's parser.
struct PathwayIssueMarkdownView: View {
    let markdown: String
    var toggleTask: ((Int) -> Void)?
    var imageContext: AgentMarkdownImageContext? = nil
    @State private var parsed = PathwayMarkdownBlockCache()

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            ForEach(parsed.blocks(for: markdown)) { block in
                PathwayIssueMarkdownBlockView(block: block, toggleTask: toggleTask, imageContext: imageContext)
                    .equatable()
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .font(.body).lineSpacing(4)
        .textSelection(.enabled)
    }
}

/// Streaming replies only grow their last block; unchanged blocks skip inline Markdown parsing.
private struct PathwayIssueMarkdownBlockView: View, Equatable {
    let block: PathwayIssueMarkdownBlock
    let toggleTask: ((Int) -> Void)?
    let imageContext: AgentMarkdownImageContext?
    private let isInteractive: Bool

    init(block: PathwayIssueMarkdownBlock, toggleTask: ((Int) -> Void)?, imageContext: AgentMarkdownImageContext?) {
        self.block = block
        self.toggleTask = toggleTask
        self.imageContext = imageContext
        isInteractive = toggleTask != nil
    }

    /// Task toggles capture the caller's latest state, so interactive blocks always rebuild.
    nonisolated static func == (lhs: Self, rhs: Self) -> Bool {
        !lhs.isInteractive && !rhs.isInteractive && lhs.block == rhs.block && lhs.imageContext == rhs.imageContext
    }

    var body: some View {
        switch block.kind {
        case .heading(let level):
            inline(block.text).font(level == 1 ? .title2.weight(.semibold) : .title3.weight(.semibold))
                .padding(.top, block.id == 0 ? 0 : 8)
                .accessibilityAddTraits(.isHeader)
        case .paragraph:
            if let visualization = PathwayVisualization.parse(block.text), let imageContext {
                AgentVisualization(visualization: visualization, context: imageContext)
            } else {
                inline(block.text)
            }
        case .task(let checked, let depth):
            HStack(alignment: .top, spacing: 9) {
                if let toggleTask {
                    Button { toggleTask(block.id) } label: {
                        Image(systemName: checked ? "checkmark.square.fill" : "square")
                            .foregroundStyle(checked ? Color.indigo : Color.secondary)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(checked ? "Mark incomplete" : "Complete task")
                    .accessibilityValue(block.text)
                } else {
                    Image(systemName: checked ? "checkmark.square.fill" : "square")
                        .foregroundStyle(checked ? Color.indigo : Color.secondary)
                        .accessibilityLabel(checked ? "Completed" : "Not completed")
                }
                inline(block.text).foregroundStyle(checked ? .secondary : .primary)
            }.padding(.leading, CGFloat(depth) * 14)
        case .list(let marker, let depth):
            HStack(alignment: .top, spacing: 9) {
                Text(marker).foregroundStyle(.secondary)
                inline(block.text)
            }.padding(.leading, CGFloat(depth) * 14)
        case .quote:
            HStack(alignment: .top, spacing: 12) {
                RoundedRectangle(cornerRadius: 2).fill(.quaternary).frame(width: 3)
                inline(block.text).foregroundStyle(.secondary)
            }.fixedSize(horizontal: false, vertical: true)
        case .code(let language):
            VStack(alignment: .leading, spacing: 8) {
                if !language.isEmpty { Text(language).font(.caption).foregroundStyle(.secondary) }
                ScrollView(.horizontal) {
                    Text(block.text).font(.callout.monospaced()).fixedSize(horizontal: true, vertical: false)
                }
            }.padding(14).background(.quaternary, in: .rect(cornerRadius: 12))
        case .divider:
            Divider()
        }
    }

    @ViewBuilder
    private func inline(_ text: String) -> some View {
        if let imageContext {
            VStack(alignment: .leading, spacing: 8) {
                ForEach(PathwayMarkdownInlinePart.parse(text)) { part in
                    switch part.content {
                    case .text(let value): inlineText(value)
                    case .image(let source, let alt, let link):
                        AgentMarkdownImage(source: source, alt: alt, link: link, context: imageContext)
                    }
                }
            }
        } else {
            inlineText(text)
        }
    }

    private func inlineText(_ text: String) -> Text {
        if let attributed = try? AttributedString(markdown: text, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)) {
            Text(attributed)
        } else {
            Text(text)
        }
    }
}

struct PathwayIssueMarkdownBlock: Identifiable, Equatable {
    enum Kind: Equatable {
        case heading(Int), paragraph, task(Bool, Int), list(String, Int), quote, code(String), divider
    }
    let id: Int
    let kind: Kind
    let text: String

    static func parse(_ markdown: String) -> [Self] {
        scan(markdown[...], firstLine: 0, firstOffset: 0).blocks.map(\.block)
    }

    /// A block with the last line its parse examined and the UTF-8 offset of its first line. A block
    /// that never examined a text's last line stays the same when the text grows.
    struct Scanned {
        let block: PathwayIssueMarkdownBlock
        let lookahead: Int
        let offset: Int
    }

    /// Parses lines from a line start, numbering them from `firstLine`.
    static func scan(_ markdown: Substring, firstLine: Int, firstOffset: Int) -> (blocks: [Scanned], lines: Int, lastLineOffset: Int) {
        let lines = markdown.components(separatedBy: "\n")
        var offsets: [Int] = []
        offsets.reserveCapacity(lines.count)
        var offset = firstOffset
        for line in lines { offsets.append(offset); offset += line.utf8.count + 1 }
        var blocks: [Scanned] = []
        func add(_ start: Int, _ kind: Kind, _ text: String, examined: Int) {
            blocks.append(Scanned(block: Self(id: firstLine + start, kind: kind, text: text),
                                  lookahead: firstLine + min(examined, lines.count - 1), offset: offsets[start]))
        }
        var index = 0
        while index < lines.count {
            let start = index
            let raw = lines[index]
            let line = raw.trimmingCharacters(in: .whitespaces)
            if line.isEmpty { index += 1; continue }
            if line.hasPrefix("```") || line.hasPrefix("~~~") {
                let fence = String(line.prefix(3))
                let language = String(line.dropFirst(3)).trimmingCharacters(in: .whitespaces)
                index += 1
                var code: [String] = []
                while index < lines.count && !lines[index].trimmingCharacters(in: .whitespaces).hasPrefix(fence) {
                    code.append(lines[index]); index += 1
                }
                // A closed fence examined its closing line; an open one ran to the end.
                let examined = index
                if index < lines.count { index += 1 }
                add(start, .code(language), code.joined(separator: "\n"), examined: examined)
                continue
            }
            if let heading = heading(line) {
                add(start, .heading(heading.level), heading.text, examined: start); index += 1; continue
            }
            // Every remaining block first checks the next line for a setext underline.
            if index + 1 < lines.count {
                let underline = lines[index + 1].trimmingCharacters(in: .whitespaces)
                if underline.count >= 3 && (underline.allSatisfy { $0 == "=" } || underline.allSatisfy { $0 == "-" }) {
                    add(start, .heading(underline.first == "=" ? 1 : 2), line, examined: start + 1); index += 2; continue
                }
            }
            if isDivider(line) {
                add(start, .divider, "", examined: start + 1); index += 1; continue
            }
            if let item = listItem(raw) {
                add(start, item.kind, item.text, examined: start + 1); index += 1; continue
            }
            if line.hasPrefix(">") {
                var quoted: [String] = []
                while index < lines.count {
                    let next = lines[index].trimmingCharacters(in: .whitespaces)
                    guard next.hasPrefix(">") else { break }
                    quoted.append(String(next.dropFirst()).trimmingCharacters(in: .whitespaces)); index += 1
                }
                add(start, .quote, quoted.joined(separator: "\n"), examined: index); continue
            }
            var paragraph = [line]
            index += 1
            while index < lines.count {
                let next = lines[index].trimmingCharacters(in: .whitespaces)
                if next.isEmpty || heading(next) != nil || listItem(lines[index]) != nil || isDivider(next)
                    || next.hasPrefix(">") || next.hasPrefix("```") || next.hasPrefix("~~~") { break }
                paragraph.append(next); index += 1
            }
            add(start, .paragraph, paragraph.joined(separator: "\n"), examined: index)
        }
        return (blocks, firstLine + lines.count, offsets[lines.count - 1])
    }

    private static func heading(_ line: String) -> (level: Int, text: String)? {
        let level = line.prefix(while: { $0 == "#" }).count
        guard (1...6).contains(level), line.dropFirst(level).first == " " else { return nil }
        return (level, String(line.dropFirst(level + 1)).trimmingCharacters(in: .whitespaces))
    }

    private static func isDivider(_ line: String) -> Bool {
        let compact = line.filter { !$0.isWhitespace }
        return compact.count >= 3 && (compact.allSatisfy { $0 == "-" } || compact.allSatisfy { $0 == "*" } || compact.allSatisfy { $0 == "_" })
    }

    private static func listItem(_ raw: String) -> (kind: Kind, text: String)? {
        let line = raw.trimmingCharacters(in: .whitespaces)
        let depth = raw.prefix(while: { $0 == " " || $0 == "\t" }).reduce(0) { $0 + ($1 == "\t" ? 2 : 1) } / 2
        let marker: String
        let body: String
        if line.hasPrefix("- ") || line.hasPrefix("* ") || line.hasPrefix("+ ") {
            marker = "•"; body = String(line.dropFirst(2))
        } else {
            let digits = line.prefix(while: \.isNumber)
            let suffix = line.dropFirst(digits.count)
            guard !digits.isEmpty, suffix.hasPrefix(". ") || suffix.hasPrefix(") ") else { return nil }
            marker = "\(digits)."; body = String(suffix.dropFirst(2))
        }
        if body.hasPrefix("[ ] ") || body.lowercased().hasPrefix("[x] ") {
            return (.task(body.lowercased().hasPrefix("[x]"), depth), String(body.dropFirst(4)))
        }
        return (.list(marker, depth), body)
    }
}

/// One view's parsed blocks. Appended text reparses from the first block that examined the old last
/// line, since only that line can change; any other edit parses everything again.
@MainActor
final class PathwayMarkdownBlockCache {
    private var text = ""
    private var scanned: [PathwayIssueMarkdownBlock.Scanned] = []
    private var lineCount = 1
    private var lastLineOffset = 0
    private(set) var blocks: [PathwayIssueMarkdownBlock] = []
    /// Lines the latest change parsed; tests use it to prove unchanged history is skipped.
    private(set) var parsedLines = 0

    func blocks(for markdown: String) -> [PathwayIssueMarkdownBlock] {
        let appended = Self.hasPrefix(markdown, text)
        if appended && markdown.utf8.count == text.utf8.count { return blocks }
        let lastLine = lineCount - 1
        let keep = appended ? scanned.firstIndex { $0.lookahead >= lastLine } ?? scanned.count : 0
        let (line, offset) = !appended ? (0, 0) : keep < scanned.count ? (scanned[keep].block.id, scanned[keep].offset) : (lastLine, lastLineOffset)
        // Offsets fall just after a newline, which is always a character boundary.
        let start = markdown.utf8.index(markdown.utf8.startIndex, offsetBy: offset)
        let tail = PathwayIssueMarkdownBlock.scan(markdown[start...], firstLine: line, firstOffset: offset)
        scanned.removeSubrange(keep...)
        scanned.append(contentsOf: tail.blocks)
        blocks.removeSubrange(keep...)
        blocks.append(contentsOf: tail.blocks.map(\.block))
        lineCount = tail.lines
        lastLineOffset = tail.lastLineOffset
        parsedLines = tail.lines - line
        text = markdown
        return blocks
    }

    /// A byte comparison: block parsing is byte-exact, and it avoids Unicode-aware comparison on long replies.
    private static func hasPrefix(_ text: String, _ prefix: String) -> Bool {
        let count = prefix.utf8.count
        guard count > 0 else { return true }
        guard count <= text.utf8.count else { return false }
        let same = text.utf8.withContiguousStorageIfAvailable { whole in
            prefix.utf8.withContiguousStorageIfAvailable { part in memcmp(whole.baseAddress!, part.baseAddress!, count) == 0 }
        }
        return (same ?? nil) ?? text.utf8.starts(with: prefix.utf8)
    }
}
