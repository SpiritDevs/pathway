# Automatic login error reports

Native Apple clients submit diagnostic reports to the public Convex mutation `loginErrorReports:submit` before authentication. Reports contain an app-generated report ID and installation ID, timestamp, app/OS versions, error domain/code and category. They exclude error descriptions, SDK payloads, account tokens and conversation content.

To enable email delivery, configure this secret in the Convex deployment:

- `RESEND_API_KEY`: a Resend API key with sending access.

Deploy the backend functions and schema with the normal backend release procedure. No email key belongs in the mobile bundle. The sender is fixed on the server at `Pathway <no-reply@pathwayos.app>` and the recipient at `support@pathwayos.app`. Verify `pathwayos.app` in Resend before sending. No sender environment variable is needed.

The server commits each accepted report before acknowledging receipt and schedules email delivery in the same transaction when the notification budget allows it. The screen confirms Cloud receipt, not inbox delivery. If `RESEND_API_KEY` is missing or blank, delivery logs a warning with the report's diagnostic fields in Convex and returns successfully without sending email or scheduling retries. The report remains stored with `sentAt: null` and no delivery attempt recorded. Setting a key later enables delivery for new reports; existing skipped reports can be sent by invoking the internal `loginErrorReports:deliver` action with their row ID.

A failed network request leaves the report on the phone for retry on the next app launch, return to the login screen, or failed sign-in. The phone retains the latest 20 pending reports.

The server accepts at most five reports per installation per rolling hour. The first 100 reports globally in that hour can send email; additional reports are durably stored with `emailSuppressed: true` for diagnostics without sending email. Report IDs deduplicate client retries, and the Resend idempotency key deduplicates email retries. Delivery retries six times over about half an hour. Inspect `loginErrorReports` rows with `sentAt: null` and `attempts: 6` for exhausted deliveries; correct the email configuration/provider problem, reset `attempts` to zero, and invoke the internal `loginErrorReports:deliver` action with the row ID. Delivered reports expire after seven days. Failed reports remain available for investigation.

Use a development Convex deployment and a verified test sender to check actual email delivery before release. Unit tests mock Resend and send no email.
