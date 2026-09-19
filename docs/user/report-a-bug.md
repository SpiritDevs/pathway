# Report a bug

On iPhone or iPad, open **Settings → Report a bug**. Choose your team's Pathway project as the destination. Pathway remembers the destination for your signed-in account on this device.

On iPhone, you can also shake the phone to open the report form. Shake reporting starts enabled. Turn it off in Settings or in the report form. Shaking opens the form; it does not send a report.

Describe what went wrong, then choose **Report bug**. Pathway creates a task in the selected project and attaches recent app diagnostics. The title comes from the first line of your description.

Diagnostics include app and device versions, recent connection and request failures, and the screen or task you were viewing. Pathway keeps up to 15 minutes of diagnostic history from the current app session, subject to a size limit. The diagnostic file records when collection began and whether its event or size limit was reached. Request bodies, raw error messages, and credentials are excluded.

Screenshots and conversation contents are optional. Review them before including them. The conversation export includes recent messages from the current thread and marks shortened content. You can review the automatic diagnostics in the form too.

Turn on **Investigate** to choose a provider and model. The picker starts with the connected environment's investigation model. Your selection applies to this report without changing the environment's settings. The agent reads the repository and diagnostic evidence and posts findings as task comments. Suggested changes to the task remain available for review. Implementing a code fix is a separate action.

After submission, choose **Open task** to see the report. Diagnostic files can also be opened from the task on web and desktop. From the Apple task's **Agent work & investigation** controls, you can see progress, stop an investigation, or start one later.

If the environment is unavailable, the report still saves to Pathway Cloud. Investigation can be started later from the task. If Cloud or an attachment upload fails, Pathway keeps the draft for retry. A retry continues saving the same task and its missing evidence. Closing the form preserves your draft; **Discard** removes the local draft and leaves any task already saved in Pathway intact.

This version is for team members who already have access to the destination project. Settings reporting is also available in the shared Apple app on visionOS; shake reporting is specific to iPhone.
