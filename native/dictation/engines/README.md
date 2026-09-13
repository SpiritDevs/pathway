# Dictation engines

These persistent JSON-lines workers adapt Sotto's `Engine/worker.cpp` and retained
`TextEngine/worker.cpp` from commit
[`f40309e7c59f2f1308d17d3da755b0485e43d92e`](https://github.com/davis7dotsh/sotto/tree/f40309e7c59f2f1308d17d3da755b0485e43d92e).
The Whisper decoding, Silero silence detection, greedy Qwen decoding, ChatML
tokenization boundary, per-request context clearing, and request bounds come from
those workers. Pathway adds Windows process handling, UTF-8 paths, configurable
acceleration, CPU fallback, five-minute audio, and its cleanup instructions.

Sotto's MIT notice and model/dependency license texts are in `notices/`. CMake
copies these and the exact upstream native dependency notices beside the built
workers. Package the `notices` directory with the executables.

## Build

Run from the repository root with Node 22.18 or later, CMake 3.24 or later, and a
C++17 compiler. On macOS, use Xcode command-line tools. On Windows, use Visual
Studio 2022 Build Tools with the C++ desktop workload and Windows SDK.

```sh
node scripts/build-dictation-engines.mjs
node scripts/smoke-dictation-engines.mjs
```

The default Mac build targets Apple Silicon/macOS 14 and embeds Metal kernels.
The default Windows build targets x64 and uses CPU inference without a GPU SDK.
`--cpu` disables Metal/Vulkan at build time. Windows `--gpu` builds Vulkan and
requires the Vulkan SDK. `--speech` or `--cleanup` builds one worker. Additional
CMake configure arguments follow `--`. Set `PATHWAY_CMAKE` to use a specific
CMake executable.

The script builds the workers separately because their ggml versions are
independent, then copies the selected configuration to:

```text
native/dictation/build/engines/pathway-speech-engine[.exe]
native/dictation/build/engines/pathway-cleanup-engine[.exe]
native/dictation/build/engines/notices/
```

Build directories and fetched source archives are gitignored. No model weights
are fetched by the build or basic smoke command. Windows CPU defaults avoid
AVX/AVX2/FMA/F16C requirements; optimized release builds may enable those CMake
flags for a narrower hardware target.

Dependencies are fetched from immutable source archives and verified by SHA-256:

| Dependency                                                                                                  | Commit                                     | Archive SHA-256                                                    |
| ----------------------------------------------------------------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------ |
| [whisper.cpp v1.9.3](https://github.com/ggml-org/whisper.cpp/tree/371b5a7561823ab2bb32142d2751e35e7534727b) | `371b5a7561823ab2bb32142d2751e35e7534727b` | `89051d8fca516a3ad1f5c2f8f9d2fccb089afbaec338fca3f8731999babc6f81` |
| [llama.cpp b10516](https://github.com/ggml-org/llama.cpp/tree/b95502ba9aa0eb73a2f4fc8878d7fbe6a847a0b9)     | `b95502ba9aa0eb73a2f4fc8878d7fbe6a847a0b9` | `c2ec2a837346b7ecb2a0ff4e2ac343667067b02dd795f296573d50bdf11cc37f` |

## Desktop integration

`DictationModels({ directory, onChange, isModelInUse? })` owns only the supplied
isolated model directory. `initialize()` verifies existing artifacts without
network access. `download(id)` is the explicit setup action and returns a promise
for complete installation. `cancel(id)` and `remove(id)` wait for partial-file
cleanup. `dispose()` aborts transfers and waits for them to settle. Errors reject
the download promise and update the model state. Cancelled downloads reject with
`AbortError` and return to the missing state.

Each speech model has its own small Silero artifact. This makes each installation
and removal independent and atomic. A model becomes installed only after both
artifacts pass size/SHA-256 checks and the staging directory is renamed into
place. State `bytes` includes Silero's 885,098 bytes; the speech weight sizes in
the catalog remain exact. Stream progress notifications are limited to five per
second, with additional artifact-completion and terminal updates.

Call `setLoaded(id, loaded)` from inference's `onLoadedChange` callback. Supply
`isModelInUse` from the controller to block removal during capture/processing.
Await `inference.unload()` before removing loaded weights, particularly on
Windows where a process can retain file mappings until it exits. One manager
owns one model directory; do not share it between running desktop instances.

`DictationInference({ engineDirectory, modelDirectory, device?, onLoadedChange? })`
provides `transcribe({ audioPath, modelId, language, terms, signal? })` and
`cleanup({ text, terms, language?, signal? })`, both returning `Promise<string>`. `warmed`
and `getLoadedModelIds()` report loaded workers. Loading starts only when a
request arrives and never downloads anything. Matching models are reused.
Switching speech models closes the old process. `unload()` and `dispose()` wait
for process termination. The controller owns idle timers and cleanup failure
fallback, and must retain the original transcript.

Pass the selected speech language to cleanup when available. The default `auto`
first classifies the quoted text's language in a separate generation limited to
16 tokens, then edits using that code. Both generations reuse the same loaded
weights, clear their KV state, and share one 60-second deadline. Explicit-language
requests skip classification.

Cleanup uses multilingual demonstrations and a trusted reminder after the
quoted transcript. A llama.cpp grammar constrains the private model answer to a
`language`/`text` JSON object. The worker validates it and returns only `text` in
the existing result event. Transcript text and dictionary terms are tokenized
with special-token parsing disabled, so spoken ChatML markers cannot introduce
conversation roles. The model is the upstream
[non-thinking Qwen3-4B-Instruct-2507](https://huggingface.co/Qwen/Qwen3-4B-Instruct-2507).

Runtime device selection is `auto`, `cpu`, or `gpu`. `auto` uses a compiled,
available GPU and retries model/context loading on CPU if allocation fails.
`cpu` also disables llama operation and KV offload. `gpu` reports an error when
no supported GPU is available. Runtime device selection does not install GPU
drivers or fetch a different binary.

## Models

The exact manifests live in `apps/desktop/src/dictation/DictationModels.ts`.
Hashes and sizes below were checked against the publisher's Hugging Face tree
API and LFS metadata on 2026-09-12. Every URL resolves a commit, never `main`.

| Artifact                                                                                                                                                                     |         Bytes | SHA-256                                                            |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------: | ------------------------------------------------------------------ |
| [Whisper Base multilingual](https://huggingface.co/ggerganov/whisper.cpp/blob/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-base.bin)                                        |   147,951,465 | `60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe` |
| [Whisper Small multilingual](https://huggingface.co/ggerganov/whisper.cpp/blob/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-small.bin)                                      |   487,601,967 | `1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b` |
| [Whisper large-v3-turbo](https://huggingface.co/ggerganov/whisper.cpp/blob/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-large-v3-turbo.bin)                                 | 1,624,555,275 | `1fc70f774d38eb169993ac391eea357ef47c88757ef72ee5943879b7e8e2bc69` |
| [Qwen3-4B-Instruct-2507 Q4_K_M](https://huggingface.co/unsloth/Qwen3-4B-Instruct-2507-GGUF/blob/a06e946bb6b655725eafa393f4a9745d460374c9/Qwen3-4B-Instruct-2507-Q4_K_M.gguf) | 2,497,281,120 | `3605803b982cb64aead44f6c1b2ae36e3acdb41d8e46c8a94c6533bc4c67e597` |
| [Silero VAD v6.2.0](https://huggingface.co/ggml-org/whisper-vad/blob/9ffd54a1e1ee413ddf265af9913beaf518d1639b/ggml-silero-v6.2.0.bin)                                        |       885,098 | `2aa269b785eeb53a82983a20501ddf7c1d9c48e33ab63a41391ac6c9f7fb6987` |

## Protocol and verification

Workers use stdin/stdout JSON lines; diagnostics go to stderr. Pass `--model`,
`--parent-pid`, `--device`, optional `--threads 1..32`, and `--vad-model` for
speech. Startup emits `ready` or `error`. Requests carry a unique `id`:

```json
{"type":"transcribe","id":"turn-1","path":"/tmp/audio.wav","language":"auto","prompt":"Pathway, Élodie"}
{"type":"correct","id":"turn-2","text":"dictated text","language":"auto","terms":["Pathway"]}
```

Responses are `progress`, `result`, or `error`, with the same ID. Native request
lines are bounded to 64 KiB. Speech accepts mono 16 kHz PCM16/float32 WAVs,
0.2 seconds through five minutes, up to 32 MiB. Text input/output is bounded to
24 KiB. Cleanup has an 8,192-token context, 2,048 output-token limit, and 60-second
decode deadline. Reaching a limit fails instead of returning truncated output.

The TypeScript client bounds each response line to 64 KiB, verifies response IDs,
and enforces startup/inference deadlines. Cancellation kills the captured child
process. Workers also wait for OS parent-exit events, including during loading
or inference. Neither worker polls its parent or runs a server.

```sh
vp test run native/dictation/engines/tests/DictationModels.test.ts native/dictation/engines/tests/DictationInference.test.ts
node scripts/smoke-dictation-engines.mjs
```

For real inference, explicitly install Base and Qwen into a temporary model
directory through `DictationModels.download()`, then run:

```sh
node scripts/smoke-dictation-engines.mjs --model-directory /tmp/pathway-models --audio native/dictation/build/speech-gpu/_deps/whisper-src/samples/jfk.wav
```

This optional smoke checks transcription, warm reuse, Unicode paths, five-minute
silence, duration rejection, cleanup meaning/language, and unloading. It does not
download weights. Run again with `--device cpu` to exercise CPU inference. A
small model-quality sample is not a general accuracy benchmark; native Windows
hardware and broader multilingual recordings still require validation.

The quality cases are in `tests/cleanup-quality.mjs`. Every case runs with both
`auto` and an explicit source language. `--repeat 2` runs the matrix twice,
reversing case order in the second iteration to check reuse across languages.
The runner prints all results and fails if any assertion fails; it does not
accept a fallback transcript as successful cleanup.

### Current validation limits

On 2026-09-12, the Apple Silicon Metal and CPU-only builds compiled, and the
27 downloader/protocol fixture tests passed. Real Base inference passed the JFK
transcript, repeated use of one loaded model, five-minute silence, Unicode WAV
paths, and duration rejection.

The final Metal cleanup run passed all 48 checks: 12 cases, automatic and explicit
languages, and two iterations with reversed case order. The cases cover English,
Spanish, and French corrections, fillers, repeats, quantities, negations, names,
and preserving a dictated request to translate. The original failing assertions
remain intact. On this machine with cached weights, median cleanup times were
1.69 seconds for automatic language detection and 1.43 seconds for explicit
languages. These are fixture timings, not general latency guarantees.

The CPU-only cleanup build passed all 24 checks in one iteration with the same
weights and assertions. The short CPU fixtures took roughly 8 to 13 seconds.
The default packaged engine directory was restored
to the Metal build after this run.

Grammar-constrained output fixes the answer format; it does not prove semantic
accuracy. The controller must still validate candidates and retain the original
transcript when cleanup fails or produces an unsafe change. Native Windows
hardware, additional languages, and longer real recordings remain unverified.
