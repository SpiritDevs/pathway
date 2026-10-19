# Brand icons

`prod/pathway-macos-1024.png` is the source of truth for the Pathway app icon on every release channel and client.

Keep the area outside the blue rounded-square artwork transparent. An opaque black background in this source propagates into every favicon and desktop export. Resize with the alpha channel intact; do not flatten these assets onto black.

Run `vp run icons:export` from the repository root to regenerate the tracked macOS, Linux, Windows, and web assets. The exporter keeps the existing development, nightly, and production filenames because packaging and hosted builds select those paths by channel, but every output contains the same Pathway mark.

The development favicon exports are also copied to `apps/web/public`. Run `vp run icons:check` to verify that every generated asset and public copy matches the canonical source without changing files.

Do not edit the generated PNG or ICO files directly.

When updating the source, also refresh the checked-in desktop resources (`apps/desktop/resources/icon.png`, `icon.ico`, and `icon.icns`) and the native asset catalog (`apps/pathway-ios/Pathway/Assets.xcassets`). The desktop PNG is 512px, the native in-app logo is 220px, and the macOS catalog sizes are declared in `AppIcon.appiconset/Contents.json`. Generate ICNS renditions using the same `sips` and `iconutil` workflow as `generateMacIconSet` in `scripts/build-desktop-artifact.ts`.

The native iOS `AppIcon-1024.png` is the opaque exception: composite the source onto Pathway blue (`#0866db`) instead of black, leaving its final corner mask to iOS. Keep transparency in the native in-app logo and macOS icons.
