import SwiftUI

/// Description blocks retain their layout; inline Markdown still uses Foundation's parser.
struct PathwayIssueMarkdownView: View {
    let markdown: String
    var toggleTask: ((Int) -> Void)?
    var imageContext: AgentMarkdownImageContext? = nil

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            ForEach(PathwayIssueMarkdownBlock.parse(markdown)) { block in
                blockView(block)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .font(.body).lineSpacing(4)
        .textSelection(.enabled)
    }

    @ViewBuilder
    private func blockView(_ block: PathwayIssueMarkdownBlock) -> some View {
        switch block.kind {
        case .heading(let level):
            inline(block.text).font(level == 1 ? .title2.weight(.semibold) : .title3.weight(.semibold))
                .padding(.top, block.id == 0 ? 0 : 8)
                .accessibilityAddTraits(.isHeader)
        case .paragraph:
            inline(block.text)
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

struct PathwayIssueMarkdownBlock: Identifiable {
    enum Kind {
        case heading(Int), paragraph, task(Bool, Int), list(String, Int), quote, code(String), divider
    }
    let id: Int
    let kind: Kind
    let text: String

    static func parse(_ markdown: String) -> [Self] {
        let lines = markdown.components(separatedBy: "\n")
        var blocks: [Self] = []
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
                if index < lines.count { index += 1 }
                blocks.append(Self(id: start, kind: .code(language), text: code.joined(separator: "\n")))
                continue
            }
            if let heading = heading(line) {
                blocks.append(Self(id: start, kind: .heading(heading.level), text: heading.text)); index += 1; continue
            }
            if index + 1 < lines.count {
                let underline = lines[index + 1].trimmingCharacters(in: .whitespaces)
                if underline.count >= 3 && (underline.allSatisfy { $0 == "=" } || underline.allSatisfy { $0 == "-" }) {
                    blocks.append(Self(id: start, kind: .heading(underline.first == "=" ? 1 : 2), text: line)); index += 2; continue
                }
            }
            if isDivider(line) {
                blocks.append(Self(id: start, kind: .divider, text: "")); index += 1; continue
            }
            if let item = listItem(raw) {
                blocks.append(Self(id: start, kind: item.kind, text: item.text)); index += 1; continue
            }
            if line.hasPrefix(">") {
                var quoted: [String] = []
                while index < lines.count {
                    let next = lines[index].trimmingCharacters(in: .whitespaces)
                    guard next.hasPrefix(">") else { break }
                    quoted.append(String(next.dropFirst()).trimmingCharacters(in: .whitespaces)); index += 1
                }
                blocks.append(Self(id: start, kind: .quote, text: quoted.joined(separator: "\n"))); continue
            }
            var paragraph = [line]
            index += 1
            while index < lines.count {
                let next = lines[index].trimmingCharacters(in: .whitespaces)
                if next.isEmpty || heading(next) != nil || listItem(lines[index]) != nil || isDivider(next)
                    || next.hasPrefix(">") || next.hasPrefix("```") || next.hasPrefix("~~~") { break }
                paragraph.append(next); index += 1
            }
            blocks.append(Self(id: start, kind: .paragraph, text: paragraph.joined(separator: "\n")))
        }
        return blocks
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
