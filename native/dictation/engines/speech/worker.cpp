// Adapted from Sotto Engine/worker.cpp at f40309e7c59f2f1308d17d3da755b0485e43d92e.
// Copyright (c) 2026 Davis. MIT license; see ../notices/Sotto-LICENSE.txt.
// Pathway modifications: platform lifetime, device selection, and bounded desktop dictation.
#include "whisper.h"
#include "json.hpp"

// whisper.cpp vendors dr_wav inside miniaudio. Compile only its file decoder;
// microphone ownership and recording permissions stay in the desktop host.
#define MA_NO_DEVICE_IO
#define MA_NO_THREADING
#define MA_NO_ENCODING
#define MA_NO_GENERATION
#define MA_NO_RESOURCE_MANAGER
#define MA_NO_NODE_GRAPH
#define MA_NO_ENGINE
#define MA_NO_FLAC
#define MA_NO_MP3
#define MINIAUDIO_IMPLEMENTATION
#include "miniaudio.h"

#include <algorithm>
#include <array>
#include <charconv>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <iostream>
#include <memory>
#include <optional>
#include <string>
#include <thread>
#include <variant>
#include <vector>
#include "../Process.h"

namespace {

using json = nlohmann::json;
using Clock = std::chrono::steady_clock;
constexpr size_t maxRequestBytes = 64 * 1024;
constexpr size_t minSamples = WHISPER_SAMPLE_RATE / 5;
constexpr size_t maxSamples = WHISPER_SAMPLE_RATE * 300;

void emit(const json &event) {
    std::cout << event.dump(-1, ' ', false, json::error_handler_t::replace) << '\n' << std::flush;
    if (!std::cout) std::_Exit(0); // The app closed its end of the pipe.
}

void emitError(const std::string &message, const std::string &id = {}) {
    json event = {{"type", "error"}, {"message", message}};
    if (!id.empty()) event["id"] = id;
    emit(event);
}

void libraryLog(ggml_log_level level, const char *message, void *) {
    // No debug logs: upstream debug output can contain decoded tokens.
    if (level == GGML_LOG_LEVEL_ERROR || level == GGML_LOG_LEVEL_WARN) {
        std::fputs(message, stderr);
    }
}


struct Audio {
    std::vector<float> samples;
    double duration;
    bool silent;
};

std::variant<Audio, std::string> readAudio(const std::string &path) {
    std::error_code error;
    if (!std::filesystem::is_regular_file(std::filesystem::u8path(path), error)) {
        return "The recording is missing or is not a regular file.";
    }
    const auto bytes = std::filesystem::file_size(std::filesystem::u8path(path), error);
    if (error || bytes > 32 * 1024 * 1024) {
        return "The recording cannot be read or exceeds the 32 MB limit.";
    }

    ma_dr_wav wav{};
    #ifdef _WIN32
    const bool opened = ma_dr_wav_init_file_w(&wav, std::filesystem::u8path(path).c_str(), nullptr);
#else
    const bool opened = ma_dr_wav_init_file(&wav, path.c_str(), nullptr);
#endif
    if (!opened) {
        return "The recording is not a readable WAV file.";
    }
    const auto finish = [&wav](ma_dr_wav *) { ma_dr_wav_uninit(&wav); };
    const std::unique_ptr<ma_dr_wav, decltype(finish)> guard(&wav, finish);
    if (wav.channels != 1 || wav.sampleRate != WHISPER_SAMPLE_RATE) {
        return "The recording must be mono, 16 kHz WAV audio.";
    }
    if (!((wav.translatedFormatTag == 1 && wav.bitsPerSample == 16) ||
          (wav.translatedFormatTag == 3 && wav.bitsPerSample == 32))) {
        return "The recording must use PCM16 or float32 WAV samples.";
    }
    if (wav.totalPCMFrameCount < minSamples || wav.totalPCMFrameCount > maxSamples) {
        return "Record between 0.2 seconds and 5 minutes of audio.";
    }

    std::vector<float> samples(static_cast<size_t>(wav.totalPCMFrameCount));
    const auto frames = ma_dr_wav_read_pcm_frames_f32(&wav, samples.size(), samples.data());
    if (frames != samples.size()) return "The recording is incomplete.";

    double squareSum = 0;
    float peak = 0;
    for (auto &sample : samples) {
        if (!std::isfinite(sample)) return "The recording contains invalid audio samples.";
        sample = std::clamp(sample, -1.0f, 1.0f);
        squareSum += static_cast<double>(sample) * sample;
        peak = std::max(peak, std::abs(sample));
    }
    // This is deliberately conservative. Whisper's no-speech probability does
    // the semantic filtering; an amplitude gate just avoids decoding silence.
    const bool silent = peak < 0.002f || std::sqrt(squareSum / samples.size()) < 0.0003;
    const double duration = static_cast<double>(samples.size()) / WHISPER_SAMPLE_RATE;
    return Audio{std::move(samples), duration, silent};
}

std::string trim(std::string text) {
    constexpr auto space = " \t\r\n";
    const auto first = text.find_first_not_of(space);
    if (first == std::string::npos) return {};
    return text.substr(first, text.find_last_not_of(space) - first + 1);
}

struct Progress {
    const std::string &id;
    int last = -1;
};

void reportProgress(whisper_context *, whisper_state *, int value, void *opaque) {
    auto &progress = *static_cast<Progress *>(opaque);
    value = std::clamp(value, 0, 100);
    if (value <= progress.last) return;
    progress.last = value;
    emit({{"type", "progress"}, {"id", progress.id}, {"value", value / 100.0}});
}

std::optional<std::string> stringField(const json &request, const char *key) {
    const auto field = request.find(key);
    if (field == request.end() || !field->is_string()) return std::nullopt;
    const auto value = field->get<std::string>();
    if (value.find('\0') != std::string::npos) return std::nullopt;
    return value;
}

void transcribe(whisper_context *context, whisper_vad_context *vad, int threads, const json &request) {
    const auto id = stringField(request, "id");
    if (!id || id->empty() || id->size() > 256) {
        emitError("A transcription request needs a nonempty id (up to 256 bytes).");
        return;
    }
    const auto path = stringField(request, "path");
    if (!path || path->empty() || path->size() > 4096) {
        emitError("A transcription request needs a valid WAV path.", *id);
        return;
    }
    const auto language = request.contains("language") ? stringField(request, "language") : std::optional<std::string>("auto");
    if (!language || (*language != "auto" && whisper_lang_id(language->c_str()) < 0)) {
        emitError("The requested language is not supported.", *id);
        return;
    }
    const auto prompt = request.contains("prompt") ? stringField(request, "prompt") : std::optional<std::string>("");
    if (!prompt || prompt->size() > 8192) {
        emitError("Custom vocabulary must be a string of at most 8192 bytes.", *id);
        return;
    }

    const auto start = Clock::now();
    auto loaded = readAudio(*path);
    if (const auto failure = std::get_if<std::string>(&loaded)) {
        emitError(*failure, *id);
        return;
    }
    auto &audio = std::get<Audio>(loaded);
    Progress progress{*id};
    reportProgress(nullptr, nullptr, 0, &progress);
    std::string text;
    std::string detectedLanguage = *language;
    if (!audio.silent) {
        // A small CPU-only Silero pass rejects fan noise, tones, and other
        // nonspeech that Whisper can otherwise turn into invented sentences.
        // Its recurrent state is reset on each call, just like the ASR context.
        if (!whisper_vad_detect_speech(vad, audio.samples.data(), static_cast<int>(audio.samples.size()))) {
            emitError("Local speech detection failed. Try recording again.", *id);
            return;
        }
        auto detection = whisper_vad_default_params();
        detection.threshold = 0.5f;
        detection.min_speech_duration_ms = 120;
        const std::unique_ptr<whisper_vad_segments, decltype(&whisper_vad_free_segments)> segments(
            whisper_vad_segments_from_probs(vad, detection), whisper_vad_free_segments);
        if (!segments) {
            emitError("Local speech detection failed. Try recording again.", *id);
            return;
        }
        audio.silent = whisper_vad_segments_n_segments(segments.get()) == 0;
        // Keep the complete recording when there is speech; this avoids cutting
        // off quiet word boundaries or short pauses inside a sentence.
    }
    if (!audio.silent) {
        auto parameters = whisper_full_default_params(WHISPER_SAMPLING_BEAM_SEARCH);
        parameters.n_threads = threads;
        parameters.no_context = true; // Never leak one dictation into the next.
        parameters.no_timestamps = true;
        parameters.translate = false;
        parameters.print_special = false;
        parameters.print_progress = false;
        parameters.print_realtime = false;
        parameters.print_timestamps = false;
        parameters.suppress_blank = true;
        parameters.suppress_nst = true;
        parameters.language = language->c_str();
        parameters.initial_prompt = prompt->empty() ? nullptr : prompt->c_str();
        parameters.carry_initial_prompt = !prompt->empty();
        parameters.temperature = 0;
        parameters.temperature_inc = 0; // Deterministic, bounded dictation latency.
        parameters.beam_search.beam_size = 5;
        parameters.no_speech_thold = 0.6f;
        parameters.progress_callback = reportProgress;
        parameters.progress_callback_user_data = &progress;

        if (whisper_full(context, parameters, audio.samples.data(), static_cast<int>(audio.samples.size())) != 0) {
            emitError("Local transcription failed. Try recording again.", *id);
            return;
        }
        const auto lang = whisper_lang_str(whisper_full_lang_id(context));
        if (lang) detectedLanguage = lang;
        for (int i = 0; i < whisper_full_n_segments(context); ++i) {
            if (whisper_full_get_segment_no_speech_prob(context, i) > parameters.no_speech_thold) continue;
            // Whisper owns punctuation and word spacing. Only trim the outside.
            text += whisper_full_get_segment_text(context, i);
            if (text.size() > 24 * 1024) { emitError("The transcript exceeds the 24 KB output limit.", *id); return; }
        }
    }
    reportProgress(nullptr, nullptr, 100, &progress);
    emit({{"type", "result"}, {"id", *id}, {"text", trim(std::move(text))},
          {"duration", audio.duration}, {"elapsed", std::chrono::duration<double>(Clock::now() - start).count()},
          {"language", detectedLanguage}});
}

} // namespace

int runEngine(int argc, char **argv) {
    configurePipes();
    std::ios::sync_with_stdio(false);
    std::string device = "auto";
    unsigned long parentPid = 0;
    std::string model;
    std::string vadModel;
    int threads = static_cast<int>(std::clamp(std::thread::hardware_concurrency(), 1u, 8u));
    for (int i = 1; i < argc; ++i) {
        const std::string argument = argv[i];
        if (argument == "--help") {
            std::fputs("Usage: pathway-speech-engine --model PATH --vad-model PATH [--threads 1..32] [--device auto|cpu|gpu] [--parent-pid PID]\nJSON lines on stdin and stdout; diagnostics only on stderr.\n", stderr);
            return 0;
        }
        if ((argument != "--model" && argument != "--vad-model" && argument != "--threads" && argument != "--device" && argument != "--parent-pid") || i + 1 >= argc) {
            emitError("Usage: pathway-speech-engine --model PATH --vad-model PATH [--threads 1..32] [--device auto|cpu|gpu] [--parent-pid PID]");
            return 2;
        }
        const std::string value = argv[++i];
        if (argument == "--device") {
            device = value;
            if (device != "auto" && device != "cpu" && device != "gpu") { emitError("Invalid inference device."); return 2; }
        } else if (argument == "--parent-pid") {
            if (!parseParentPid(value, parentPid)) { emitError("Invalid parent process ID."); return 2; }
        } else if (argument == "--model") {
            model = value;
        } else if (argument == "--vad-model") {
            vadModel = value;
        } else {
            const auto parsed = std::from_chars(value.data(), value.data() + value.size(), threads);
            if (parsed.ec != std::errc{} || parsed.ptr != value.data() + value.size() || threads < 1 || threads > 32) {
                emitError("The thread count must be between 1 and 32.");
                return 2;
            }
        }
    }
    std::error_code error;
    if (model.empty() || !std::filesystem::is_regular_file(std::filesystem::u8path(model), error)) {
        emitError("The local model is missing. Download it in Pathway dictation setup first.");
        return 2;
    }
    if (vadModel.empty() || !std::filesystem::is_regular_file(std::filesystem::u8path(vadModel), error)) {
        emitError("The local speech detector is missing. Download the speech model again in Pathway dictation setup.");
        return 2;
    }

    watchParent(parentPid);
    whisper_log_set(libraryLog, nullptr);
    ggml_log_set(libraryLog, nullptr);
    const bool useGPU = device != "cpu" && hasGPU();
    if (device == "gpu" && !useGPU) { emitError("No supported GPU is available. Select CPU or automatic processing."); return 1; }
    auto parameters = whisper_context_default_params();
    parameters.use_gpu = useGPU;
    parameters.flash_attn = useGPU;
    std::unique_ptr<whisper_context, decltype(&whisper_free)> context(
        whisper_init_from_file_with_params(model.c_str(), parameters), whisper_free);
    if (!context && device == "auto") {
        parameters.use_gpu = false;
        parameters.flash_attn = false;
        context.reset(whisper_init_from_file_with_params(model.c_str(), parameters));
    }
    if (!context) {
        emitError("The model could not be loaded. Check available memory or download it again.");
        return 1;
    }
    auto vadParameters = whisper_vad_default_context_params();
    vadParameters.n_threads = std::min(threads, 2);
    vadParameters.use_gpu = false;
    const std::unique_ptr<whisper_vad_context, decltype(&whisper_vad_free)> vad(
        whisper_vad_init_from_file_with_params(vadModel.c_str(), vadParameters), whisper_vad_free);
    if (!vad) {
        emitError("The local speech detector could not load. Download the speech model again in Pathway dictation setup.");
        return 1;
    }
    emit({{"type", "ready"}, {"engineVersion", whisper_version()}});

    // Fixed-size reads prevent a malformed caller from allocating unbounded RAM.
    std::array<char, maxRequestBytes + 1> buffer{};
    while (std::cin.getline(buffer.data(), buffer.size())) {
        const auto request = json::parse(buffer.data(), nullptr, false);
        if (request.is_discarded() || !request.is_object()) {
            emitError("Expected one JSON object per line.");
            continue;
        }
        const auto type = stringField(request, "type");
        if (type == "quit") return 0;
        if (type != "transcribe") {
            emitError("Unknown request type.", stringField(request, "id").value_or(""));
            continue;
        }
        transcribe(context.get(), vad.get(), threads, request);
    }
    if (!std::cin.eof()) {
        emitError("The request exceeds the 64 KB limit.");
        return 2;
    }
    return 0;
}
