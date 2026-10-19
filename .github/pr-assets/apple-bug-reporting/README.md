# Bug-report UI evidence

Captured on iPhone 17 Pro / iOS 26.3 on 20 September 2026 using the production SwiftUI screens and temporary offline fixture data. The fixtures only supplied account/project/environment records and model configuration; they are not part of the shipped changes.

- `settings-before.png`: main at `3ee7aeb21`, before bug reporting.
- `settings-after.png`, `preferences.png`, and `report-form.png`: Settings entry, remembered destination, shake preference, and report form.
- `investigation-off.png`, `investigation-on.png`, and `model-picker.png`: the model controls appear when Investigate is enabled. The UI test selected a different model successfully.
- `walkthrough.mp4`: Settings entry, form, investigation switch, and model selection.
- `shake-before.png`: the previous shake behavior opened the full form immediately.
- `shake-confirmation.png` and `shake-full-form.png`: the updated shake flow asks for confirmation in a compact card, then expands to the full form after Report bug.
- `shake.mp4`: the updated confirmation card, shake toggle, and expansion to the full form.

The original two focused UI tests passed for the bug-report screens and shake route. After adding the confirmation step, a focused native UI test passed for compact-card presentation, dismissal without creating a draft, changing the shake preference, and opening/closing the full form only after confirmation. The before version was checked separately. These checks did not submit a report to live Cloud, upload attachments, or start a provider; focused model/server tests cover those contracts and failure paths. Physical-device shake behavior still needs release validation.
