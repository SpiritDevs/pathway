import CryptoKit
import Foundation

/// Local file names are derived from authenticated identity, never from user-entered paths.
enum PathwayAccountStorage {
    static func identity(fromToken token: String) -> String? {
        let parts = token.split(separator: ".")
        guard parts.count == 3 else { return nil }
        var payload = String(parts[1]).replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        payload += String(repeating: "=", count: (4 - payload.count % 4) % 4)
        guard let data = Data(base64Encoded: payload),
              let fields = try? JSONDecoder().decode(JSONValue.self, from: data).objectValue,
              let subject = fields["sub"]?.stringValue, !subject.isEmpty,
              let issuer = fields["iss"]?.stringValue, !issuer.isEmpty else { return nil }
        // This only partitions local data. Authentication remains owned by Clerk and the server.
        return "\(issuer)\n\(subject)"
    }

    static func directory(for identity: String, root: URL = .applicationSupportDirectory) -> URL {
        let digest = SHA256.hash(data: Data(identity.utf8)).map { String(format: "%02x", $0) }.joined()
        return root.appending(path: "Pathway/Accounts/\(digest)", directoryHint: .isDirectory)
    }
}
