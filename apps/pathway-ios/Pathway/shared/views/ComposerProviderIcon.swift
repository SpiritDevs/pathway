import SwiftUI

struct ComposerProviderIcon: View {
    let provider: PathwayServerProvider?

    var body: some View {
        if let provider {
            let branding = PathwayThreadProvider(driver: provider.driver, name: provider.name)
            Group {
                if let asset = branding.iconAssetName {
                    Image(asset).resizable().scaledToFit()
                } else {
                    Text(String(provider.name.prefix(2)).uppercased()).font(.caption2.weight(.medium))
                }
            }
            .frame(width: 16, height: 16)
            .foregroundStyle(provider.driver == "claudeAgent" ? Color(red: 0.85, green: 0.47, blue: 0.34) : .primary)
            .accessibilityHidden(true)
        }
    }
}
