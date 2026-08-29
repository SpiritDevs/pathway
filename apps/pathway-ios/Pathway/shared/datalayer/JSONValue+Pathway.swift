import Foundation

extension JSONValue {
    var objectValue: [String: JSONValue]? {
        guard case let .object(value) = self else { return nil }
        return value
    }

    var arrayValue: [JSONValue]? {
        guard case let .array(value) = self else { return nil }
        return value
    }

    var stringValue: String? {
        guard case let .string(value) = self else { return nil }
        return value
    }

    var boolValue: Bool? {
        guard case let .bool(value) = self else { return nil }
        return value
    }

    var intValue: Int? {
        guard case let .number(value) = self else { return nil }
        return Int(exactly: value)
    }

    var displayString: String? {
        switch self {
        case let .string(value): value
        case let .object(value):
            value["message"]?.stringValue
                ?? value["detail"]?.stringValue
                ?? value["reason"]?.stringValue
        default: nil
        }
    }
}
