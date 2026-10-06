# Provider error trace budget

CLI text generation for Codex and Claude keeps at most 16 KiB of stderr: the tail, behind a truncation marker. Stdout used as error text has the same limit. Local trace records keep at most 8,192 characters of a failure cause, as head and tail around a marker. `Cause.pretty` still builds the full string before it is cut.

The trace sink batches records per flush but still appends and rotates synchronously. OpenCode's process-startup helper still retains unbounded output until readiness.

Coordinator generation treats a reused refresh token or an HTTP 401 as terminal. It reports a sanitized "sign in again" reason with `retryModel: false`, so the cloud job fails instead of retrying other environments or models. Other failures keep the normal retry path. The classifier is deliberately narrow; an unrecognized credential message still retries.
