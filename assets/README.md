# Brand icons

`prod/pathway-macos-1024.png` is the source of truth for the Pathway app icon on every release channel and client.

Run `vp run icons:export` from the repository root to regenerate the tracked macOS, Linux, Windows, and web assets. The exporter keeps the existing development, nightly, and production filenames because packaging and hosted builds select those paths by channel, but every output contains the same Pathway mark.

The development favicon exports are also copied to `apps/web/public`. Run `vp run icons:check` to verify that every generated asset and public copy matches the canonical source without changing files.

Do not edit the generated PNG or ICO files directly.
