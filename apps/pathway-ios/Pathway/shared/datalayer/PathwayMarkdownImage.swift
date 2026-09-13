import Foundation

enum PathwayMarkdownImageSource: Equatable {
    case workspace(String), web(URL), unavailable

    static func resolve(_ source: String, workspace: String? = nil) -> Self {
        let value = source.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty, !value.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) else { return .unavailable }
        if value.range(of: #"^(https?:)?//"#, options: [.regularExpression, .caseInsensitive]) != nil {
            return URL(string: value.hasPrefix("//") ? "https:" + value : value).map(Self.web) ?? .unavailable
        }
        let windows = value.range(of: #"^([a-z]:(?:[\\/]|%5c|%2f)|\\\\)"#, options: [.regularExpression, .caseInsensitive]) != nil
        let explicitFile = value.lowercased().hasPrefix("file:")
        var path: String
        if explicitFile {
            guard let url = URLComponents(string: value), url.user == nil, url.password == nil, url.port == nil,
                  let decoded = url.percentEncodedPath.removingPercentEncoding else { return .unavailable }
            path = decoded
            if path.range(of: #"^/[a-z]:/"#, options: [.regularExpression, .caseInsensitive]) != nil { path.removeFirst() }
            if let host = url.host, !host.isEmpty, host != "localhost" { path = "//" + host + path }
        } else {
            if !windows, value.range(of: #"^[a-z][a-z0-9+.-]*:"#, options: [.regularExpression, .caseInsensitive]) != nil { return .unavailable }
            guard let decoded = value.components(separatedBy: CharacterSet(charactersIn: "?#")).first?.removingPercentEncoding else { return .unavailable }
            path = decoded
        }
        guard !path.isEmpty, !path.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) else { return .unavailable }
        let roots = ["Users", "home", "tmp", "var", "etc", "opt", "mnt", "Volumes", "private", "root", "usr", "bin", "sbin", "lib", "lib64", "srv", "dev", "proc", "sys", "run", "boot", "media", "workspace", "workspaces"]
        let root = workspace.map { $0.hasSuffix("/") ? String($0.dropLast()) : $0 }
        if !explicitFile, path.hasPrefix("/"), !roots.contains(where: { path.hasPrefix("/" + $0 + "/") }),
           !(root.map { path.hasPrefix($0 + "/") } ?? false) {
            // Native has no client web origin for ambiguous root-relative web URLs.
            return .unavailable
        }
        return .workspace(path)
    }
}

struct PathwayMarkdownInlinePart: Identifiable {
    enum Content { case text(String), image(source: String, alt: String, link: URL?) }
    let id: Int
    let content: Content

    /// Suffix tables make failed delimiter lookups constant time, including nested malformed input.
    /// Each lexical state has its own table so a broken outer quote cannot hide a later image.
    private struct DelimiterIndex {
        let characters: [Character]
        let labels: [Int]
        let destinations: [Int]

        init(_ characters: [Character]) {
            self.characters = characters
            let count = characters.count
            var labels = Array(repeating: -1, count: count + 2)
            var destinations = labels
            var angles = labels
            var singleQuotes = labels
            var doubleQuotes = labels
            for index in characters.indices.reversed() {
                let character = characters[index]
                if character == "\\" {
                    labels[index] = labels[index + 2]
                    destinations[index] = destinations[index + 2]
                    angles[index] = angles[index + 2]
                    singleQuotes[index] = singleQuotes[index + 2]
                    doubleQuotes[index] = doubleQuotes[index + 2]
                    continue
                }
                if character == "]" { labels[index] = index }
                else if character == "[" {
                    let end = labels[index + 1]
                    labels[index] = end < 0 ? -1 : labels[end + 1]
                } else { labels[index] = labels[index + 1] }

                angles[index] = character == ">" ? destinations[index + 1] : angles[index + 1]
                singleQuotes[index] = character == "'" ? destinations[index + 1] : singleQuotes[index + 1]
                doubleQuotes[index] = character == "\"" ? destinations[index + 1] : doubleQuotes[index + 1]
                if character == ")" { destinations[index] = index }
                else if character == "(" {
                    let end = destinations[index + 1]
                    destinations[index] = end < 0 ? -1 : destinations[end + 1]
                } else if character == "<" { destinations[index] = angles[index + 1] }
                else if character == "'", index > 0, characters[index - 1].isWhitespace {
                    destinations[index] = singleQuotes[index + 1]
                } else if character == "\"", index > 0, characters[index - 1].isWhitespace {
                    destinations[index] = doubleQuotes[index + 1]
                } else { destinations[index] = destinations[index + 1] }
            }
            self.labels = labels
            self.destinations = destinations
        }

        func labelEnd(after opening: Int) -> Int? {
            guard opening < characters.count, characters[opening] == "[", labels[opening + 1] >= 0 else { return nil }
            return labels[opening + 1]
        }

        func destinationEnd(after opening: Int) -> Int? {
            guard opening < characters.count, characters[opening] == "(", destinations[opening + 1] >= 0 else { return nil }
            return destinations[opening + 1]
        }
    }

    /// Foundation parses image destinations, but drops images nested inside links. Extract complete
    /// inline image spans first so linked images retain both the image and their link.
    struct ParseWork {
        var foundationCharacters = 0
        var exhausted = false
    }

    static func parse(_ text: String) -> [Self] {
        var work = ParseWork()
        return parse(text, work: &work)
    }

    static func parse(_ text: String, work: inout ParseWork) -> [Self] {
        let characters = Array(text)
        work = ParseWork()
        // Valid image spans are disjoint. Rejected nested candidates must not repeatedly hand
        // overlapping suffixes to Foundation; preserve the remaining source verbatim on exhaustion.
        let budget = characters.count * 4
        func reserve(_ count: Int) -> Bool {
            guard count <= budget - work.foundationCharacters else { work.exhausted = true; return false }
            work.foundationCharacters += count
            return true
        }
        var parts: [Self] = []
        var index = 0
        var start = 0
        var codeFence = 0
        let delimiters = DelimiterIndex(characters)
        while index < characters.count {
            if characters[index] == "\\" { index += 2; continue }
            if characters[index] == "`" {
                let count = characters[index...].prefix(while: { $0 == "`" }).count
                if codeFence == 0 { codeFence = count } else if codeFence == count { codeFence = 0 }
                index += count; continue
            }
            guard codeFence == 0, characters[index] == "!", let labelEnd = delimiters.labelEnd(after: index + 1),
                  let destinationEnd = delimiters.destinationEnd(after: labelEnd + 1) else { index += 1; continue }
            guard reserve(destinationEnd - labelEnd + 8) else { break }
            let destination = String(characters[(labelEnd + 1)...destinationEnd])
            guard let attributed = try? AttributedString(markdown: "![Image]" + destination),
                  let source = attributed.runs.first?.imageURL?.absoluteString else { index += 1; continue }
            guard reserve(labelEnd - index - 2) else { break }
            let rawAlt = String(characters[(index + 2)..<labelEnd])
            let alt = (try? AttributedString(markdown: rawAlt)).map { String($0.characters) } ?? rawAlt
            var imageStart = index
            var imageEnd = destinationEnd + 1
            var link: URL?
            if index > start, characters[index - 1] == "[", imageEnd < characters.count, characters[imageEnd] == "]",
               let linkEnd = delimiters.destinationEnd(after: imageEnd + 1) {
                guard reserve(linkEnd - imageEnd + 7) else { break }
                if let linked = try? AttributedString(markdown: "[Image]" + String(characters[(imageEnd + 1)...linkEnd])),
                   let target = linked.runs.first?.link, ["https", "http"].contains(target.scheme?.lowercased() ?? "") {
                    link = target; imageStart -= 1; imageEnd = linkEnd + 1
                }
            }
            if imageStart > start { parts.append(Self(id: start, content: .text(String(characters[start..<imageStart])))) }
            parts.append(Self(id: imageStart, content: .image(source: source, alt: alt, link: link)))
            index = imageEnd; start = imageEnd
        }
        if start < characters.count { parts.append(Self(id: start, content: .text(String(characters[start...])))) }
        return parts
    }
}
