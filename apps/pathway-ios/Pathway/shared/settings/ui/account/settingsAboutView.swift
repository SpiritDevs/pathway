import SwiftUI
import UIKit

struct SettingsAboutLinks: Sendable {
    let terms: URL?
    let privacy: URL?
    let status: URL?
    let support: URL?

    static let pathway = SettingsAboutLinks(
        terms: URL(string: "https://www.spiritdevs.com/pathway-terms"),
        privacy: URL(string: "https://www.spiritdevs.com/privacy"),
        status: URL(string: "https://status.spiritdevs.com/"),
        support: URL(string: "mailto:support@spiritdevs.com")
    )
}

@MainActor
struct SettingsAboutView: View {
    let catalog: MobileSettingsCatalog
    let locale: Locale
    let links: SettingsAboutLinks
    let onOpenWhatsNew: @MainActor () -> Void

    @Environment(\.openURL) private var openURL
    @State private var copiedDiagnostics = false
    @State private var copiedVersion = false

    init(
        catalog: MobileSettingsCatalog,
        locale: Locale,
        links: SettingsAboutLinks = .pathway,
        onOpenWhatsNew: @escaping @MainActor () -> Void
    ) {
        self.catalog = catalog
        self.locale = locale
        self.links = links
        self.onOpenWhatsNew = onOpenWhatsNew
    }

    private var version: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "Unknown"
    }

    private var build: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "Unknown"
    }

    private var versionAndBuild: String { "\(version) (\(build))" }

    var body: some View {
        Form {
            Section {
                VStack(spacing: 10) {
                    Image(systemName: "quote.bubble.fill")
                        .font(.system(size: 44))
                        .foregroundStyle(.tint)
                        .accessibilityHidden(true)
                    Text("Pathway").font(.title2.bold())
                    Text("Documents made clear.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 8)
            }

            Section("Updates") {
                Button(action: onOpenWhatsNew) {
                    SettingsIconLabel("What's New", systemName: "sparkles", color: .purple)
                }
            }

            Section("Legal & Status") {
                externalLink("Terms and Conditions", systemImage: "doc.text", url: links.terms)
                externalLink("Privacy Policy", systemImage: "hand.raised", url: links.privacy)
                externalLink("System Status", systemImage: "waveform.path.ecg", url: links.status)
                externalLink("Email Support", systemImage: "envelope", url: links.support)
            }

            Section("App Information") {
                Button {
                    UIPasteboard.general.string = versionAndBuild
                    copiedVersion = true
                    UIAccessibility.post(notification: .announcement, argument: "Version copied")
                } label: {
                    HStack {
                        Text("Version")
                            .foregroundStyle(.primary)
                        Spacer()
                        Text(copiedVersion ? "Copied" : versionAndBuild)
                            .foregroundStyle(.secondary)
                    }
                }
                .accessibilityLabel("Version \(version), build \(build)")
                .accessibilityHint("Double tap to copy")
            }

            Section {
                Button {
                    UIPasteboard.general.string = diagnostics
                    copiedDiagnostics = true
                    UIAccessibility.post(notification: .announcement, argument: "Diagnostics copied")
                } label: {
                    HStack {
                        SettingsIconLabel("Copy Diagnostics", systemName: "doc.on.doc", color: .blue)
                        Spacer()
                        if copiedDiagnostics {
                            Image(systemName: "checkmark")
                                .foregroundStyle(.green)
                                .accessibilityHidden(true)
                        }
                    }
                }
            } header: {
                Text("Diagnostics")
            } footer: {
                Text("Includes app, operating system and device metadata. It excludes names, email addresses, company identifiers, tokens and secrets.")
            }
        }
        .navigationTitle("About")
    }

    @ViewBuilder
    private func externalLink(_ title: String, systemImage: String, url: URL?) -> some View {
        Button {
            guard let url else { return }
            openURL(url)
        } label: {
            HStack {
                SettingsIconLabel(title, systemName: systemImage, color: externalLinkColor(systemImage))
                Spacer()
                Image(systemName: "arrow.up.forward")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .accessibilityHidden(true)
            }
        }
        .disabled(url == nil)
        .accessibilityHint("Opens in your browser")
    }

    private func externalLinkColor(_ systemImage: String) -> Color {
        switch systemImage {
        case "hand.raised": .indigo
        case "waveform.path.ecg": .green
        case "envelope": .blue
        default: .orange
        }
    }

    private var diagnostics: String {
        let device = UIDevice.current
        return [
            "Pathway diagnostics (redacted)",
            "Version: \(version)",
            "Build: \(build)",
            "Operating system: \(device.systemName) \(device.systemVersion)",
            "Device family: \(device.model)",
            "Locale: \(locale.identifier)",
            "Settings schema: \(catalog.schemaVersion)",
            "Settings destination count: \(catalog.destinations.count)"
        ].joined(separator: "\n")
    }
}
