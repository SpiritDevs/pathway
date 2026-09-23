# Computer Use is a literal mirror of Synara

Pathway ports Synara's Computer Use (Emanuele-web04/synara, MIT) in its entirety rather than a reduced slice. That covers every tool, the patched Cua driver and its Linux browser patch, the permission setup guide, preview, audit history and session recording/replay, the Spaces broker, multi-display work, and the qualification, benchmark and evidence tooling.

The maintainers approved this over the AGENTS.md "yagni" default. The reason is that Synara's native safety work (input admission, held-input release, cancellation, focus restoration) is the expensive part, and a partial port would re-open problems Synara has already solved. Synara's unresolved limits come with the code: macOS live acceptance is not qualified, and Linux is component-level only. The port adapts plumbing to Pathway (MCP toolkits, provider adapters, desktop backend) but does not redesign behavior.

Synara's MIT notice (T3 Tools Inc., Emanuele Di Pietro) and Cua's MIT notice (Cua AI, Inc.) are preserved alongside the imported code.
