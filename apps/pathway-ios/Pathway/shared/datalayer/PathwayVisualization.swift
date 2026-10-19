import Foundation

struct PathwayVisualization: Equatable {
    let path: String
    let title: String

    static func parse(_ text: String) -> Self? {
        let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let prefix = "visualize"
        guard text.hasPrefix(prefix), text.hasSuffix("") else { return nil }
        struct Reference: Decodable { let path: String; let title: String? }
        let json = String(text.dropFirst(prefix.count).dropLast())
        guard let data = json.data(using: .utf8), let reference = try? JSONDecoder().decode(Reference.self, from: data),
              reference.path.utf16.count <= 1024,
              reference.path.rangeOfCharacter(from: .controlCharacters) == nil,
              reference.path.range(of: #"^(?:/|[A-Za-z]:[\\/]|\\\\)"#, options: .regularExpression) != nil,
              reference.path.range(of: #"\.html?$"#, options: [.regularExpression, .caseInsensitive]) != nil else { return nil }
        let filename = reference.path.components(separatedBy: CharacterSet(charactersIn: "/\\")).last ?? "Visualization"
        let fallback = filename.replacingOccurrences(of: #"\.html?$"#, with: "", options: [.regularExpression, .caseInsensitive])
            .replacingOccurrences(of: #"[-_]+"#, with: " ", options: .regularExpression)
        let title = reference.title?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return Self(path: reference.path, title: title.isEmpty ? fallback : title)
    }
}
