# Usage estimates

The Usage page estimates the API-equivalent cost of tokens recorded in local Claude and Codex transcripts. These estimates are separate from subscription allowances and are not an invoice. Cursor, Grok, and OpenCode transcript costs are not included.

Each connected environment scans the enabled provider instances configured on that environment, including custom homes and Codex archives. Shared transcript directories count once across connected environments. Claude transcripts can contribute project totals; Codex date folders are not treated as projects.

If a transcript or directory cannot be read, readable records still contribute and the page marks coverage as incomplete. Missing transcript directories contribute no usage. Deleting transcripts removes that history from future scans. Servers with an incompatible usage format are excluded and listed in the coverage notice until updated.

Cost estimates use native model rates when available. Models without a known rate still contribute tokens but no estimated cost. Cached input uses the model's cache price when reported by the rate source.
