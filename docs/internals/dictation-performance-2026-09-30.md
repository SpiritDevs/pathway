# Long dictations on Apple M1

Dictations longer than about 20 seconds waited well over the time a short one did, then usually
arrived without cleanup. On the test Mac (Apple M1, 16 GiB, Whisper Small, English), local history
showed cleanup falling back for 11 of 15 recordings of 20 seconds or more, versus 13 of 98 shorter
ones.

## Causes

- Qwen cleanup of a 140-word transcript took 5.9–6.6 seconds warm, past the five-second desktop
  deadline. The desktop waited out the deadline, delivered the recognized text, and killed the
  worker. The next recording then had to reload Qwen (3.7–27 seconds on this Mac), so short
  follow-up dictations also lost cleanup.
- Transcription started only after capture stopped and grew with length: about 70 ms per second
  of audio for Whisper Small. Whisper Turbo was slower on this Mac (about 6.0 versus 3.3 seconds
  for a 48-second clip).

## Changes

- Cleanup requests carry `timeoutMs`. The worker stops at the deadline and stays loaded; the desktop
  kills it only two seconds later as a backstop.
- Recordings are processed while capture continues. Partial speech requests read the growing WAV
  and commit through the last sentence Whisper ends clear of the live edge, cut at a Silero pause.
  Cleanup runs on whole sentences as they are committed. At stop, an unfinished partial step is
  interrupted, only the tail is transcribed, and the last sentences are cleaned. The previous
  chunk's final words are Whisper's prompt so sentences continue across cuts.
- Speech and cleanup may each run one request at a time, concurrently.

See the [design](dictation-design.md) and [engine documentation](../../native/dictation/engines/README.md).

## Measured wait after release

A harness drove the real `DictationController` and `DictationInference` with the production
engines. A fake capture host wrote PCM16 into a WAV in real time, with the header layout
`AVAudioFile` uses while recording, and emitted level events every 50 ms. Timing runs from the
stop call to text insertion. Recordings are synthetic Samantha speech. Each process ran a warm-up
recording first; baseline and updated builds alternated.

| Recording | Before (ms)   | After (ms)    | Cleanup before → after |
| --------- | ------------- | ------------- | ---------------------- |
| 13 s      | ~3,900 median | ~4,000 median | applied → applied      |
| 28.6 s    | 6,275 / 5,646 | 3,678 / 4,332 | applied → applied      |
| 47.8 s    | 8,910 / 8,361 | 2,960 / 2,701 | fell back → applied    |
| 67.3 s    | 8,352 / 7,701 | 3,307 / 3,282 | fell back → applied    |

The 13-second medians are from six runs per build; recordings under 15 seconds take the same path
as before. The updated 47.8-second transcript kept every word and placed cuts at sentence ends.
Timings on a machine running other apps varied by up to about 1.5 seconds between runs.

## Limits

Synthetic speech has shorter pauses than most people, so it is a harder case for cutting, but it
is not a real-microphone test. Windows capture shares the same growing-file layout and read access
but has not been run. Chunk cleanup cannot resolve a spoken correction that refers back across a
sentence already committed.
