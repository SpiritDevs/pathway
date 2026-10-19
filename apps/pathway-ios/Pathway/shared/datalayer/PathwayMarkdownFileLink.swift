import Foundation

/// A file reference belongs to the message's environment, never the phone's filesystem.
struct PathwayMarkdownFileLink: Equatable, Identifiable {
    let path: String
    let line: Int?
    var id: String { "\(path):\(line ?? 0)" }

    init?(url: URL) {
        let value = url.absoluteString
        guard !value.hasPrefix("#"), !value.hasPrefix("//") else { return nil }
        let isFileURL = url.isFileURL
        var path: String
        if isFileURL {
            guard let parts = URLComponents(url: url, resolvingAgainstBaseURL: false),
                  parts.user == nil, parts.password == nil, parts.port == nil,
                  let decoded = parts.percentEncodedPath.removingPercentEncoding else { return nil }
            path = decoded
            if path.range(of: #"^/[a-z]:[/\\]"#, options: [.regularExpression, .caseInsensitive]) != nil { path.removeFirst() }
            if let host = parts.host, !host.isEmpty, host != "localhost" { path = "//" + host + path }
        } else {
            guard let decoded = value.components(separatedBy: CharacterSet(charactersIn: "?#")).first?.removingPercentEncoding else { return nil }
            path = decoded
        }
        var line: Int?
        if let position = path.range(of: #":\d+(?::\d+)?$"#, options: .regularExpression) {
            line = Int(path[position].dropFirst().split(separator: ":")[0])
            path = String(path[..<position.lowerBound])
        } else if let fragment = url.fragment?.removingPercentEncoding,
                  fragment.range(of: #"^[Ll]\d+(?:[Cc]\d+)?$"#, options: .regularExpression) != nil {
            line = Int(fragment.dropFirst().prefix(while: \.isNumber))
        }
        let windowsDrive = path.range(of: #"^[a-z]:[/\\]"#, options: [.regularExpression, .caseInsensitive]) != nil
        if !isFileURL, !windowsDrive, let scheme = url.scheme {
            // A bare "file.swift:42" also parses as a URL scheme. Numeric tel/mailto URLs do not identify files.
            guard line != nil, path == scheme, path.contains(".") else { return nil }
        }
        guard !path.isEmpty, !path.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }),
              isFileURL || windowsDrive || path.range(of: #"^[a-z][a-z0-9+.-]*:"#, options: [.regularExpression, .caseInsensitive]) == nil else { return nil }
        self.path = path
        self.line = line.flatMap { $0 > 0 ? $0 : nil }
    }

    /// Normalize lexically: these paths may be on Windows or a remote Mac, not this device.
    func relativePath(in workspace: String) -> String? {
        func normalized(_ value: String) -> String? {
            let value = value.replacingOccurrences(of: "\\", with: "/")
            let prefix = value.hasPrefix("//") ? "//" : value.hasPrefix("/") ? "/" : ""
            var parts: [Substring] = []
            for part in value.split(separator: "/") {
                if part == "." { continue }
                if part == ".." {
                    guard !parts.isEmpty, parts.last?.hasSuffix(":") != true else { return nil }
                    parts.removeLast()
                } else { parts.append(part) }
            }
            return prefix + parts.joined(separator: "/")
        }
        guard let root = normalized(workspace), !root.isEmpty else { return nil }
        let source = path.replacingOccurrences(of: "\\", with: "/")
        let absolute = source.hasPrefix("/") || source.range(of: #"^[a-z]:/"#, options: [.regularExpression, .caseInsensitive]) != nil
        guard let target = normalized(absolute ? source : root + "/" + source) else { return nil }
        let prefix = root.hasSuffix("/") ? root : root + "/"
        let windows = root.hasPrefix("//") || root.range(of: #"^[a-z]:/"#, options: [.regularExpression, .caseInsensitive]) != nil
        guard target.range(of: prefix, options: windows ? [.anchored, .caseInsensitive] : [.anchored]) != nil else { return nil }
        let relative = String(target.dropFirst(prefix.count))
        return relative.isEmpty ? nil : relative
    }
}
