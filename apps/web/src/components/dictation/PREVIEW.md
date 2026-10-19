# Dictation UI preview

The development-only route `/settings/dictation/preview` renders the production settings components with an isolated bridge and sample data. The normal browser settings navigation never exposes dictation. The preview route redirects away in production.

The primary agent owns server launches, browser verification, and screenshots. After signing in to the isolated development app, open this route and select a page and configuration. No model download, microphone capture, cloud dictionary update, or clipboard write runs through this fixture bridge.

Available pages include the Setup intro, setup-access, setup-models, setup-test, Models, History, Dictionary, Settings, and Overlay. Setup initially shows only its intro card. Select Set Up Dictation inside it to open the wizard. The three setup stage pages open the dialog directly for captures. The overlay imports `createDictationWidgetHtml` from the desktop through Vite and runs its actual document in a sandboxed iframe with a fixture bridge.

Useful captures:

| Page         | Configuration                                                                                 |
| ------------ | --------------------------------------------------------------------------------------------- |
| setup        | setup                                                                                         |
| setup-access | setup, setup-access-ready, permissions-denied, setup-windows                                  |
| setup-models | setup-models, downloading, verifying, download-error                                          |
| setup-test   | setup-test, setup-test-recording, setup-test-result                                           |
| Models       | ready, models-missing                                                                         |
| History      | ready                                                                                         |
| Dictionary   | ready, offline                                                                                |
| Settings     | ready, disabled, windows, microphone-test                                                     |
| Overlay      | ready, recording-hold, recording-locked, processing, result, unconfirmed, cleanup-unavailable |

Hover over the idle overlay to reveal Record, Settings, and History. Select History to see the five-entry panel. Fixture captures establish presentation only. Keep the visible fixture label in review evidence and distinguish them from real native capture, inference, insertion, and permission checks.

`fixtures.ts` exports the state configurations and history entries for other isolated screenshot tooling. Production UI actions use the canonical `DictationBridge`; dictionary saves use `saveDictationDictionary` from the account coordinator.

The setup wizard uses explicit permission actions. `microphone` requests microphone access, `accessibility` opens the native draggable-app permission window on Mac, and `refresh` checks status without prompting. Status refreshes on window focus, without polling. Existing installed models are reused; verification must finish before the test stage. Finish later keeps downloads and cancels any active microphone test.
