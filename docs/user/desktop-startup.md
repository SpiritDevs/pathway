# Desktop startup

Pathway opens its window while preparing the local server. Agents and terminals wait until the environment is ready, so they can find your installed tools and use your shell settings.

Later launches reuse a recent, valid shell environment while refreshing it in the background. The first launch, a reboot, or changes to shell startup files can require fresh discovery. On Linux, discovery may finish before the window opens so Pathway can select the correct system password store.
