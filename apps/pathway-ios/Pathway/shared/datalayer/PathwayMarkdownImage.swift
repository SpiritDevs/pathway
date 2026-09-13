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
    enum Content { case text(String), image(source: String, alt: String, link: URL?), asset(companyID: String, assetID: String), workspaceFile(source: String, label: String) }
    let id: Int
    let content: Content

    /// Foundation parses image destinations, but drops images nested inside links. Extract complete
    /// inline image spans first so linked images retain both the image and their link.
    static func parse(_ text: String) -> [Self] {
        let characters = Array(text)
        var parts: [Self] = []
        var index = 0
        var start = 0
        var codeFence = 0
        func endOf(_ begin: Int, open: Character, close: Character) -> Int? {
            guard begin < characters.count, characters[begin] == open else { return nil }
            var depth = 1
            var cursor = begin + 1
            var angle = false
            var quote: Character?
            while cursor < characters.count {
                let character = characters[cursor]
                if character == "\\" { cursor += 2; continue }
                if open == "(" {
                    if let current = quote { if character == current { quote = nil }; cursor += 1; continue }
                    if character == "<" { angle = true }
                    if character == ">" { angle = false }
                    if angle { cursor += 1; continue }
                    if (character == "\"" || character == "'"), cursor > begin + 1, characters[cursor - 1].isWhitespace { quote = character; cursor += 1; continue }
                }
                if character == open { depth += 1 }
                if character == close { depth -= 1; if depth == 0 { return cursor } }
                cursor += 1
            }
            return nil
        }
        while index < characters.count {
            if characters[index] == "\\" { index += 2; continue }
            if characters[index] == "`" {
                let count = characters[index...].prefix(while: { $0 == "`" }).count
                if codeFence == 0 { codeFence = count } else if codeFence == count { codeFence = 0 }
                index += count; continue
            }
            // An escaped image marker leaves its opening bracket in the scanner. It must
            // remain literal text rather than being reinterpreted as an independent file link.
            let startsPlainLink = characters[index] == "[" && (index == 0 || characters[index - 1] != "!")
            if codeFence == 0, startsPlainLink, let labelEnd = endOf(index, open: "[", close: "]"),
               let destinationEnd = endOf(labelEnd + 1, open: "(", close: ")"),
               let attributed = try? AttributedString(markdown: "[Asset]" + String(characters[(labelEnd + 1)...destinationEnd])),
               let target = attributed.runs.first?.link?.absoluteString, let asset = PathwayAssetReference.parse(target) {
                if index > start { parts.append(Self(id: start, content: .text(String(characters[start..<index])))) }
                parts.append(Self(id: index, content: .asset(companyID: asset.companyID, assetID: asset.assetID)))
                index = destinationEnd + 1; start = index; continue
            }
            if codeFence == 0, startsPlainLink, let labelEnd = endOf(index, open: "[", close: "]"),
               let destinationEnd = endOf(labelEnd + 1, open: "(", close: ")"),
               let attributed = try? AttributedString(markdown: "[File]" + String(characters[(labelEnd + 1)...destinationEnd])),
               let target = attributed.runs.first?.link,
               target.scheme == nil || target.scheme == "file",
               ["mp4", "mov", "m4v", "png", "jpg", "jpeg", "gif", "heic", "heif", "webp", "pdf", "csv", "zip", "docx", "xlsx", "mp3", "m4a", "wav"].contains(target.pathExtension.lowercased()) {
                if index > start { parts.append(Self(id: start, content: .text(String(characters[start..<index])))) }
                let label = String(characters[(index + 1)..<labelEnd])
                parts.append(Self(id: index, content: .workspaceFile(source: target.absoluteString, label: label)))
                index = destinationEnd + 1; start = index; continue
            }
            guard codeFence == 0, characters[index] == "!", let labelEnd = endOf(index + 1, open: "[", close: "]"),
                  let destinationEnd = endOf(labelEnd + 1, open: "(", close: ")") else { index += 1; continue }
            let destination = String(characters[(labelEnd + 1)...destinationEnd])
            guard let attributed = try? AttributedString(markdown: "![Image]" + destination),
                  let source = attributed.runs.first?.imageURL?.absoluteString else { index += 1; continue }
            let rawAlt = String(characters[(index + 2)..<labelEnd])
            let alt = (try? AttributedString(markdown: rawAlt)).map { String($0.characters) } ?? rawAlt
            var imageStart = index
            var imageEnd = destinationEnd + 1
            var link: URL?
            if index > start, characters[index - 1] == "[", imageEnd < characters.count, characters[imageEnd] == "]",
               let linkEnd = endOf(imageEnd + 1, open: "(", close: ")"),
               let linked = try? AttributedString(markdown: "[Image]" + String(characters[(imageEnd + 1)...linkEnd])),
               let target = linked.runs.first?.link, ["https", "http"].contains(target.scheme?.lowercased() ?? "") {
                link = target; imageStart -= 1; imageEnd = linkEnd + 1
            }
            if imageStart > start { parts.append(Self(id: start, content: .text(String(characters[start..<imageStart])))) }
            if let asset = PathwayAssetReference.parse(source) {
                parts.append(Self(id: imageStart, content: .asset(companyID: asset.companyID, assetID: asset.assetID)))
            } else { parts.append(Self(id: imageStart, content: .image(source: source, alt: alt, link: link))) }
            index = imageEnd; start = imageEnd
        }
        if start < characters.count { parts.append(Self(id: start, content: .text(String(characters[start...])))) }
        return parts
    }
}

struct PathwayAssetReference: Equatable {
    let companyID: String
    let assetID: String
    static func parse(_ value: String) -> Self? {
        guard value.range(of: #"^pathway-asset:[a-zA-Z0-9_-]+/[a-zA-Z0-9_-]+$"#, options: .regularExpression) != nil else { return nil }
        let identifiers = value.dropFirst("pathway-asset:".count).split(separator: "/")
        guard identifiers.count == 2 else { return nil }
        return Self(companyID: String(identifiers[0]), assetID: String(identifiers[1]))
    }
}
