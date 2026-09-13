# Dictation processing belongs to the desktop client

Dictation records and processes speech on the desktop where the user speaks, even when Pathway connects to a remote environment. Microphone access, speech and cleanup models, operating-system permissions, and text insertion therefore belong to that desktop; environment selection cannot redirect audio or inference. This gives up remote compute offloading in exchange for predictable device ownership and keeps the feature usable across applications on that computer.

Pathway Cloud sign-in remains required. The personal dictionary syncs through the user's account, while text history and hardware preferences stay on each desktop. Local inference does not prevent dictionary synchronization, and connecting to a different environment does not change either record's owner.
