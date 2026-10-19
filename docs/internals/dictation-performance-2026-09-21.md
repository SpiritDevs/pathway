# Dictation processing on Apple M1

The reported delay is after recording ends and before text appears. It is separate
from main-window startup. Dictation audio is processed by desktop-owned Whisper
and Qwen workers; Convex is not in the transcription or cleanup path.

## Bottleneck and change

On the test Mac (Apple M1, 16 GiB), a five-second synthetic English recording took
about 0.7 seconds to transcribe once warm. Qwen cleanup then took 2.2–2.4 seconds.
Longer text can exceed the desktop's five-second cleanup deadline. That deadline
terminates the cleanup worker, delivers the recognized transcript, and leaves the
next recording to prepare Qwen again.

The cleanup worker now proposes short continuations from the current transcript
and verifies them in batches. Qwen and its JSON grammar still choose every output
token; a differing choice discards the unused proposals and resumes decoding from
that choice. Most unchanged passages therefore need fewer sequential model calls.
This adds no model, service or download.

The draft contains only JSON-escaped tokens from the current transcript. The
existing trusted-prefix cache, cancellation, output/context bounds, five-second
desktop fallback and cleanup acceptance guard remain in effect. The selected
speech model and cleanup preference are not changed.

See the [engine documentation](../../native/dictation/engines/README.md) for the
algorithm, build instructions and native quality comparison command.

## Measured processing wait

The baseline is the `pathway4` cleanup worker from Nightly
`0.0.42-nightly.20260920.163`; the new worker is `pathway5`, built from the same
pinned llama.cpp and Qwen weights. Both use the same Whisper Small executable,
English selection and Metal backend. The recordings are synthetic Samantha
speech at 180 words/minute, mono 16 kHz PCM16, lasting 4.90 and 18.61 seconds.

The comparison uses the actual `DictationInference` class, its default five-second
cleanup timeout, and the desktop text-cleanup acceptance guard. Both workers are
prepared before timing. Each pair processes the short clip then the longer clip;
the build order alternates across three rounds. There is no priming transcription
before the first clip, so loaded-model first-inference costs are included. No
builds or other test workers run alongside this timing pass.

| Processing after capture | Previous median | Updated median | Reduction |
| ------------------------ | --------------: | -------------: | --------: |
| 4.90-second recording    |        4,218 ms |       3,432 ms |     18.6% |
| 18.61-second recording   |        6,675 ms |       4,984 ms |     25.3% |

Each median has three observations. On the longer clip, the old worker timed out
and fell back to recognition in all three runs; the updated worker completed
accepted cleanup in all three. Median cleanup wait was 5,047 versus 3,351 ms.
The short clip's cleanup median was 2,633 versus 1,819 ms. Transcripts matched
across builds, and all completed candidates passed the actual desktop guard.

Model preparation is excluded from this table because it normally overlaps
recording. It ranged from 3.95 to 19.08 seconds across these fresh-process runs;
this change does not eliminate model loading. Timings exclude microphone
finalization, native insertion, history writes and UI delivery. They are small
synthetic samples on this M1, not latency guarantees for all recordings.

## Validation

- 64 native quality cases per build (16 fixtures, automatic and explicit language,
  forward and reverse order). Every updated result matched the baseline
  byte-for-byte. This covers English, French, Spanish, corrections, negations,
  quantities, Unicode/JSON escaping, long text and repeated prefixes.
- Three additional CPU-fallback cases on this M1 passed their quality checks and
  matched the previous worker byte-for-byte (correction, negation and repetition).
- 58 focused inference lifecycle, controller and text-processing tests passed,
  including cancellation, worker reuse, timeout fallback and stale output.
- 14 native prompt-lookup checks passed in the build and with AddressSanitizer
  and UndefinedBehaviorSanitizer. Native build and protocol smoke passed.
- Scoped JavaScript lint, formatting and diff whitespace checks passed.

## Scope and verification limits

The shared desktop cleanup worker serves the global shortcut, dictation bar and
setup microphone test. It also runs locally when the selected agent environment
is remote. There are no web/mobile, provider, wire-contract or navigation changes.

Measurements use copied model weights and synthetic audio in temporary state.
They do not record the microphone, paste into an application, sign in, or modify
the installed Nightly app. Native Windows execution and real microphone-to-paste
latency require separate verification. A desktop release must include the rebuilt
cleanup worker before an installed app receives this improvement.
