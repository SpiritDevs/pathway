import Foundation
import SwiftUI

enum SettingsAccountLoadState<Value> {
    case loading
    case loaded(Value)
    case failed(String)
}

struct SettingsAccountErrorView: View {
    let message: String
    let retry: () -> Void

    var body: some View {
        ContentUnavailableView {
            Label("Couldn't Load Settings", systemImage: "exclamationmark.triangle")
        } description: {
            Text(message)
        } actions: {
            Button("Try Again", action: retry)
        }
    }
}

struct SettingsAccountLoadingRows: View {
    var count = 3

    var body: some View {
        ForEach(0..<count, id: \.self) { index in
            LabeledContent {
                Text(index.isMultiple(of: 2) ? "Loading" : "—")
            } label: {
                Label("Loading settings", systemImage: "circle.dotted")
            }
        }
        .redacted(reason: .placeholder)
        .accessibilityHidden(true)
    }
}

struct SettingsStatusLabel: View {
    let status: String

    private var displayValue: String {
        status
            .replacingOccurrences(of: "_", with: " ")
            .split(separator: " ")
            .map { $0.capitalized }
            .joined(separator: " ")
    }

    private var color: Color {
        switch status.lowercased() {
        case "active", "paid", "included": .green
        case "payment_due", "past_due", "suspended", "failed": .red
        case "paused", "pending", "pending_change", "trial": .orange
        default: .secondary
        }
    }

    var body: some View {
        Text(displayValue)
            .font(.caption.weight(.semibold))
            .foregroundStyle(color)
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(color.opacity(0.12), in: Capsule())
            .accessibilityLabel("Status: \(displayValue)")
    }
}

enum SettingsAccountFormatting {
    static func date(from timestamp: Double?) -> Date? {
        guard let timestamp else { return nil }
        let seconds = timestamp > 10_000_000_000 ? timestamp / 1_000 : timestamp
        return Date(timeIntervalSince1970: seconds)
    }

    static func dateText(_ timestamp: Double?, locale: Locale) -> String? {
        date(from: timestamp)?.formatted(
            Date.FormatStyle(date: .abbreviated, time: .omitted, locale: locale)
        )
    }

    static func money(
        minorUnits: Double,
        currencyCode: String,
        locale: Locale
    ) -> String {
        (minorUnits / 100).formatted(
            .currency(code: currencyCode.isEmpty ? "USD" : currencyCode)
                .locale(locale)
        )
    }

    static func displayError(_ error: Error) -> String {
        if error is CancellationError { return "The request was cancelled." }
        let message = error.localizedDescription.trimmingCharacters(in: .whitespacesAndNewlines)
        return message.isEmpty ? "Pathway couldn't load this information. Please try again." : message
    }

    static func plainText(fromHTML html: String) -> String {
        var value = html
        for separator in ["</p>", "<br>", "<br/>", "<br />", "</li>", "</h1>", "</h2>", "</h3>"] {
            value = value.replacingOccurrences(of: separator, with: "\n", options: .caseInsensitive)
        }
        value = value.replacingOccurrences(
            of: "<[^>]+>",
            with: "",
            options: .regularExpression
        )
        let entities = [
            "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": "\"",
            "&#39;": "'", "&nbsp;": " "
        ]
        for (entity, replacement) in entities {
            value = value.replacingOccurrences(of: entity, with: replacement)
        }
        return value
            .split(separator: "\n", omittingEmptySubsequences: true)
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
            .joined(separator: "\n\n")
    }
}
