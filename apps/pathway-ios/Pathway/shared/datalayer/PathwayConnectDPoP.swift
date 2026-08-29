import CryptoKit
import Foundation
import Security

struct PathwayDPoPPublicJWK: Codable, Equatable, Sendable {
    let kty: String
    let crv: String
    let x: String
    let y: String

    init(publicKey: P256.Signing.PublicKey) throws {
        let bytes = publicKey.x963Representation
        guard bytes.count == 65, bytes.first == 0x04 else {
            throw PathwayConnectError.invalidProofKey
        }
        kty = "EC"
        crv = "P-256"
        x = Data(bytes[1 ..< 33]).base64URLEncodedString()
        y = Data(bytes[33 ..< 65]).base64URLEncodedString()
    }

    var thumbprint: String {
        let canonical = "{\"crv\":\"\(crv)\",\"kty\":\"\(kty)\",\"x\":\"\(x)\",\"y\":\"\(y)\"}"
        return Data(SHA256.hash(data: Data(canonical.utf8))).base64URLEncodedString()
    }
}

struct PathwayDPoPProof: Sendable {
    let value: String
    let thumbprint: String
}

actor PathwayDPoPSigner {
    private let service = "com.spiritdevs.pathway.connect-dpop"
    private let account = "device-proof-key"
    private var privateKey: P256.Signing.PrivateKey?
    private var cachedJWK: PathwayDPoPPublicJWK?

    func thumbprint() throws -> String {
        try publicJWK().thumbprint
    }

    func proof(
        method: String,
        url: URL,
        accessToken: String? = nil,
        issuedAt: Date = Date(),
        identifier: UUID = UUID()
    ) throws -> PathwayDPoPProof {
        guard let normalizedURL = Self.normalizedHTU(url) else {
            throw PathwayConnectError.invalidURL
        }
        let key = try loadPrivateKey()
        let jwk = try publicJWK()
        let header = Header(typ: "dpop+jwt", alg: "ES256", jwk: jwk)
        let payload = Payload(
            htm: method.uppercased(),
            htu: normalizedURL.absoluteString,
            jti: identifier.uuidString.lowercased(),
            iat: Int(issuedAt.timeIntervalSince1970.rounded(.down)),
            ath: accessToken.map(Self.accessTokenHash)
        )
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        let headerPart = try encoder.encode(header).base64URLEncodedString()
        let payloadPart = try encoder.encode(payload).base64URLEncodedString()
        let input = "\(headerPart).\(payloadPart)"
        let signature = try key.signature(for: Data(input.utf8))
        return PathwayDPoPProof(
            value: "\(input).\(signature.rawRepresentation.base64URLEncodedString())",
            thumbprint: jwk.thumbprint
        )
    }

    static func accessTokenHash(_ accessToken: String) -> String {
        Data(SHA256.hash(data: Data(accessToken.utf8))).base64URLEncodedString()
    }

    static func normalizedHTU(_ url: URL) -> URL? {
        guard
            var components = URLComponents(url: url, resolvingAgainstBaseURL: false),
            components.scheme != nil,
            components.host != nil
        else { return nil }
        components.query = nil
        components.fragment = nil
        switch (components.scheme?.lowercased(), components.port) {
        case ("http", 80), ("https", 443), ("ws", 80), ("wss", 443):
            components.port = nil
        default:
            break
        }
        return components.url
    }

    private func publicJWK() throws -> PathwayDPoPPublicJWK {
        if let cachedJWK { return cachedJWK }
        let jwk = try PathwayDPoPPublicJWK(publicKey: loadPrivateKey().publicKey)
        cachedJWK = jwk
        return jwk
    }

    private func loadPrivateKey() throws -> P256.Signing.PrivateKey {
        if let privateKey { return privateKey }
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne
        ]
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        if status == errSecSuccess {
            guard let data = item as? Data else { throw PathwayConnectError.invalidProofKey }
            let restored = try P256.Signing.PrivateKey(rawRepresentation: data)
            privateKey = restored
            return restored
        }
        guard status == errSecItemNotFound else {
            throw PathwayConnectError.keychain(status)
        }

        let generated = P256.Signing.PrivateKey()
        var insertion = query
        insertion.removeValue(forKey: kSecReturnData as String)
        insertion.removeValue(forKey: kSecMatchLimit as String)
        insertion[kSecValueData as String] = generated.rawRepresentation
        insertion[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let insertionStatus = SecItemAdd(insertion as CFDictionary, nil)
        if insertionStatus == errSecDuplicateItem {
            return try loadExistingPrivateKey()
        }
        guard insertionStatus == errSecSuccess else {
            throw PathwayConnectError.keychain(insertionStatus)
        }
        privateKey = generated
        return generated
    }

    private func loadExistingPrivateKey() throws -> P256.Signing.PrivateKey {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne
        ]
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        guard status == errSecSuccess, let data = item as? Data else {
            throw PathwayConnectError.keychain(status)
        }
        let restored = try P256.Signing.PrivateKey(rawRepresentation: data)
        privateKey = restored
        return restored
    }

    private struct Header: Encodable {
        let typ: String
        let alg: String
        let jwk: PathwayDPoPPublicJWK
    }

    private struct Payload: Encodable {
        let htm: String
        let htu: String
        let jti: String
        let iat: Int
        let ath: String?
    }
}

extension Data {
    fileprivate func base64URLEncodedString() -> String {
        base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}
