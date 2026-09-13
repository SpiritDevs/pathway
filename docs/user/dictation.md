# Dictation

Dictation turns your voice into text for the app you are using. It is available in the Pathway
desktop app on Apple Silicon Macs and Windows x64. Sign in to your Pathway account to use it.

Recording and AI processing stay on this desktop, including when your agents run in a remote
environment. After you download the models, dictation can work offline with your cached dictionary.

## Set up dictation

Open **Settings > Dictation**. Before setup is complete, you see an introduction card with
**Set Up Dictation**. Select it to open the setup wizard. The regular configuration views appear
after you finish setup.

The wizard walks through permissions, model downloads, and a microphone test:

1. Grant the access requested by your operating system.
2. Download the recommended speech and cleanup models, about 4.12 GB in total. The models are
   separate from the Pathway download. Wait for download verification to finish.
3. Choose **System default** or a specific microphone, then use **Test microphone** to record and
   review a short phrase. A test does not insert text, change your clipboard, or enter History.
4. Choose your shortcut and finish setup to enable dictation.

On Mac, dictation needs Microphone and Accessibility access. Microphone access uses the macOS
permission prompt. For Accessibility, Pathway opens System Settings with a small permission panel
showing the app to allow. Drag the app from that panel into the Accessibility list and turn on its
switch. You can also click the app to reveal it in Finder. Use the panel's back button or return to
Pathway to recheck access and continue setup.

Windows requires microphone access for desktop apps under
**Settings > Privacy & security > Microphone**. The permission step shows access that still needs
attention.

## Record and insert text

The default shortcut is **Fn / Globe** on Mac and **Right Control** on Windows. Settings also offers
Right Control, Right Option on Mac or Right Alt on Windows, and F8. Choose another shortcut if your
keyboard or another app uses the default.

| Action                            | What happens                                                                                  |
| --------------------------------- | --------------------------------------------------------------------------------------------- |
| Hold the shortcut                 | Record while held. Release to finish and transcribe.                                          |
| Double-tap the shortcut           | Start locked recording, leaving your hands free.                                              |
| Tap again during locked recording | Finish and transcribe. The checkmark does the same thing.                                     |
| Press Escape                      | Cancel recording or processing. The cancel button also discards the recording.                |
| Select Record on the bar          | Start locked recording. Record dictation is also in the tray or menu bar and command palette. |

The waveform shows microphone activity. After you finish, the bar shows **Transcribing…**. Each
recording can last five minutes. A countdown appears near the limit, then Pathway finishes normally.

Pathway inserts into the editable field focused when processing finishes. Automatic insertion
preserves your previous clipboard and does not submit a message or form. If no usable field is
focused, the result panel shows your text with **Copy text**. The clipboard changes only when you
select Copy. If insertion could not be confirmed, check the destination before copying to avoid a
duplicate.

If your microphone disconnects, Pathway shows usable captured speech for review without inserting
it. Screen lock, sleep, and explicit cancellation discard unfinished dictation. If no speech is
detected, record again.

## Models and cleanup

After setup, **Models** offers Whisper Base, about 148 MB, Whisper Small, about 488 MB, and the
recommended Whisper Turbo, about 1.62 GB. Download a model and select **Use model** to switch.
Downloads show progress and verification, with cancellation and retry controls.

The Qwen cleanup model is about 2.50 GB. **Clean up dictation** is on by default to remove fillers,
repetitions, and spoken self-corrections. You can turn it off. If cleanup is unavailable, Pathway
keeps the recognized text and indicates that cleanup did not complete. If the cleanup model is
still loading, your recognized text is delivered immediately while the model gets ready for later
recordings. Once loaded, cleanup has a five-second limit so a slow pass does not leave your
transcript waiting indefinitely.

Removing the selected speech model turns dictation off. Select another downloaded speech model and
enable it again. Removing models does not delete your dictionary or history.

## Dictionary and history

**Dictionary** organizes words into named lists, such as Personal and Work. Every list applies to
every dictation. Add preferred spellings and corrections, for example, "path way" becoming
"Pathway". Conflicting corrections must be resolved before saving. Lists do not expand a phrase
into a paragraph.

The dictionary syncs through your personal Pathway account. Offline dictation uses the last synced
copy. Connect to edit it. Changes apply to your next recording.
If another desktop saves while you are editing, Pathway keeps your draft and prevents it from
overwriting the newer dictionary. Copy any edits you want to keep, then choose **Discard changes**
to load the latest dictionary before editing again.

**History** stays on this desktop and keeps both the original recognized text and the cleaned
result. No audio is saved in History. Search entries, copy either version, or delete individual
entries or all history. The default retention is 30 days. Settings offers 1 day, 7 days, 30 days,
90 days, 1 year, or **Until I delete it**. Turning off **Save dictation history** stops future saving;
existing entries still follow retention and deletion settings.

## Bar, language, and memory settings

The small idle bar appears at the bottom of your screen. Hover for Record, Settings, History, and
**Hide bar**. Hiding it leaves your recording shortcut working and brings the bar back when you
activate dictation. You can also show it again from the tray or menu-bar control.
History opens the five latest dictations with Copy actions and a link to the full History page.
Turn off **Show idle bar** in Settings to hide it between every recording. Recording and processing
feedback still appears.

In **Settings**, choose a spoken language or **Detect automatically**, change the microphone and
shortcut, and set how long models remain in memory. The default is five idle minutes. Other choices
are after every dictation, 15 minutes, or until Pathway quits. Unloading frees memory and keeps the
downloaded files. Models start loading while you record, so loading can overlap your speech.

## Closing Pathway and turning dictation off

Starting Pathway keeps its main window open when dictation is enabled. Closing the main window
keeps Pathway running. Use its tray or menu-bar
control to reopen it, record, open settings or history, turn dictation off, or quit. **Quit Pathway**
stops dictation. Enabling dictation does not change your launch-at-login preference.

Turning dictation off cancels unfinished work and releases its microphone, shortcut, and model
memory. Downloads already installed, dictionary entries, and history remain. Signing out or
switching accounts stops active dictation and clears the previous account's text from view.
