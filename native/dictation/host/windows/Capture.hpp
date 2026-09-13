#pragma once
#include "Protocol.hpp"
#include <audioclient.h>
#include <mmdeviceapi.h>
#include <functiondiscoverykeys_devpkey.h>
#include <propvarutil.h>
#include <cmath>
#include <algorithm>
#include <filesystem>
#include <future>
#include <memory>

inline winrt::com_ptr<IMMDeviceEnumerator> audioDevices() {
    return winrt::create_instance<IMMDeviceEnumerator>(__uuidof(MMDeviceEnumerator));
}
inline std::wstring deviceId(IMMDevice* device) {
    LPWSTR raw = nullptr;
    check(device->GetId(&raw));
    std::wstring result(raw);
    CoTaskMemFree(raw);
    return result;
}
inline JsonArray microphones() {
    auto devices = audioDevices();
    winrt::com_ptr<IMMDevice> defaultDevice;
    std::wstring defaultId;
    if (SUCCEEDED(devices->GetDefaultAudioEndpoint(eCapture, eConsole, defaultDevice.put()))) defaultId = deviceId(defaultDevice.get());
    winrt::com_ptr<IMMDeviceCollection> collection;
    check(devices->EnumAudioEndpoints(eCapture, DEVICE_STATE_ACTIVE, collection.put()));
    UINT count = 0;
    check(collection->GetCount(&count));
    JsonArray result;
    for (UINT index = 0; index < count; ++index) {
        winrt::com_ptr<IMMDevice> device;
        check(collection->Item(index, device.put()));
        winrt::com_ptr<IPropertyStore> properties;
        check(device->OpenPropertyStore(STGM_READ, properties.put()));
        PROPVARIANT name;
        PropVariantInit(&name);
        auto status = properties->GetValue(PKEY_Device_FriendlyName, &name);
        const auto id = deviceId(device.get());
        const std::wstring title = SUCCEEDED(status) && name.vt == VT_LPWSTR ? name.pwszVal : L"Microphone";
        PropVariantClear(&name);
        result.Append(object({{L"id", json(id)}, {L"name", json(title)}, {L"isDefault", json(id == defaultId)}}));
    }
    return result;
}

/// WASAPI converts the pinned device's mix format to 16 kHz mono. PCM16 is written here.
class WaveWriter {
    Handle file;
    std::uint32_t frames = 0;
    unsigned meterFrames = 0;
    double squares = 0;
    std::function<void(double, double)> level;
    void write(const void* bytes, DWORD count) {
        DWORD written = 0;
        if (!WriteFile(file.value, bytes, count, &written, nullptr) || written != count) fail("Could not write temporary audio.");
    }
    void header() {
        const std::uint32_t dataSize = frames * 2, riffSize = dataSize + 36;
        const std::uint32_t formatSize = 16, rate = 16000, byteRate = 32000;
        const std::uint16_t pcm = 1, channels = 1, alignment = 2, bits = 16;
        LARGE_INTEGER beginning{};
        if (!SetFilePointerEx(file.value, beginning, nullptr, FILE_BEGIN)) fail("Could not finalize temporary audio.");
        write("RIFF", 4); write(&riffSize, 4); write("WAVEfmt ", 8); write(&formatSize, 4);
        write(&pcm, 2); write(&channels, 2); write(&rate, 4); write(&byteRate, 4); write(&alignment, 2); write(&bits, 2);
        write("data", 4); write(&dataSize, 4);
    }
public:
    WaveWriter(const std::wstring& path, std::function<void(double, double)> level) : level(std::move(level)) {
        auto destination = std::filesystem::path(path);
        if (!destination.is_absolute() || destination.extension() != L".wav") fail("Capture needs an absolute temporary .wav path.");
        file.value = CreateFileW(path.c_str(), GENERIC_WRITE, FILE_SHARE_READ, nullptr, CREATE_NEW, FILE_ATTRIBUTE_TEMPORARY, nullptr);
        if (file.value == INVALID_HANDLE_VALUE) fail("Capture path already exists or cannot be created.");
        try { header(); }
        catch (...) { CloseHandle(file.value); file.value = nullptr; DeleteFileW(path.c_str()); throw; }
    }
    void append(const float* samples, UINT count, bool silent) {
        count = std::min(count, 4'800'000U - frames);
        std::vector<std::int16_t> pcm(count);
        for (UINT index = 0; index < count; ++index) {
            const float value = silent || !std::isfinite(samples[index]) ? 0 : std::clamp(samples[index], -1.0F, 1.0F);
            pcm[index] = static_cast<std::int16_t>(std::lround(value * 32767));
            squares += static_cast<double>(value) * value;
            ++meterFrames;
            ++frames;
            if (meterFrames == 800) {
                const auto rms = std::sqrt(squares / 800);
                level(frames / 16.0, std::clamp((20 * std::log10(std::max(rms, .00001)) + 60) / 60, 0.0, 1.0));
                squares = 0;
                meterFrames = 0;
            }
        }
        if (count) write(pcm.data(), count * 2);
    }
    double finish() { header(); return frames / 16.0; }
};

struct CaptureState {
    std::wstring id, path, device;
    Handle stop{CreateEventW(nullptr, TRUE, FALSE, nullptr)};
    std::atomic<bool> cancelled{false}, disconnected{false}, admission{true}, done{false}, ownsFile{false};
    double duration = 0;
    std::string error;
    std::promise<void> started;
};
class DeviceNotifications : public IMMNotificationClient {
    std::atomic<ULONG> references{1};
    std::shared_ptr<CaptureState> state;
public:
    explicit DeviceNotifications(std::shared_ptr<CaptureState> state) : state(std::move(state)) {}
    ULONG STDMETHODCALLTYPE AddRef() override { return ++references; }
    ULONG STDMETHODCALLTYPE Release() override { auto count = --references; if (!count) delete this; return count; }
    HRESULT STDMETHODCALLTYPE QueryInterface(REFIID iid, void** result) override {
        if (iid == __uuidof(IUnknown) || iid == __uuidof(IMMNotificationClient)) { *result = static_cast<IMMNotificationClient*>(this); AddRef(); return S_OK; }
        *result = nullptr; return E_NOINTERFACE;
    }
    void lost(LPCWSTR id) {
        if (id && state->device == id) { state->disconnected = true; state->admission = false; SetEvent(state->stop.value); }
    }
    HRESULT STDMETHODCALLTYPE OnDeviceStateChanged(LPCWSTR id, DWORD status) override { if (status != DEVICE_STATE_ACTIVE) lost(id); return S_OK; }
    HRESULT STDMETHODCALLTYPE OnDeviceRemoved(LPCWSTR id) override { lost(id); return S_OK; }
    HRESULT STDMETHODCALLTYPE OnDeviceAdded(LPCWSTR) override { return S_OK; }
    HRESULT STDMETHODCALLTYPE OnDefaultDeviceChanged(EDataFlow, ERole, LPCWSTR) override { return S_OK; }
    HRESULT STDMETHODCALLTYPE OnPropertyValueChanged(LPCWSTR, const PROPERTYKEY) override { return S_OK; }
};

class CaptureController {
    std::mutex mutex;
    std::shared_ptr<CaptureState> current;
    std::thread worker;
    static JsonObject result(const CaptureState& state) {
        return object({{L"id", json(state.id)}, {L"path", json(state.path)}, {L"durationMs", json(state.duration)}});
    }
    static void record(std::shared_ptr<CaptureState> state) {
        winrt::init_apartment(winrt::apartment_type::multi_threaded);
        bool started = false, created = false;
        winrt::com_ptr<IAudioClient> client;
        winrt::com_ptr<IMMDeviceEnumerator> devices;
        winrt::com_ptr<IMMNotificationClient> listener;
        std::unique_ptr<WaveWriter> writer;
        try {
            if (!state->admission) fail("Recording was cancelled before startup.");
            devices = audioDevices();
            winrt::com_ptr<IMMDevice> device;
            if (state->device == L"default") check(devices->GetDefaultAudioEndpoint(eCapture, eConsole, device.put()));
            else check(devices->GetDevice(state->device.c_str(), device.put()));
            state->device = deviceId(device.get());
            check(device->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr, client.put_void()));
            WAVEFORMATEX format{};
            format.wFormatTag = WAVE_FORMAT_IEEE_FLOAT;
            format.nChannels = 1; format.nSamplesPerSec = 16000; format.wBitsPerSample = 32;
            format.nBlockAlign = 4; format.nAvgBytesPerSec = 64000;
            if (!state->admission) fail("Recording was cancelled during startup.");
            check(client->Initialize(AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_EVENTCALLBACK | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
                0, 0, &format, nullptr));
            Handle available(CreateEventW(nullptr, FALSE, FALSE, nullptr));
            if (!available.value || !state->stop.value) fail("Could not create microphone events.");
            check(client->SetEventHandle(available.value));
            winrt::com_ptr<IAudioCaptureClient> capture;
            check(client->GetService(__uuidof(IAudioCaptureClient), capture.put_void()));
            writer = std::make_unique<WaveWriter>(state->path, [state](double duration, double level) {
                if (state->admission) emit(object({{L"type", json(L"level")}, {L"id", json(state->id)}, {L"durationMs", json(duration)}, {L"level", json(level)}}));
            });
            created = true;
            state->ownsFile = true;
            listener.attach(new DeviceNotifications(state));
            check(devices->RegisterEndpointNotificationCallback(listener.get()));
            if (!state->admission) fail("Recording was cancelled during startup.");
            check(client->Start());
            started = true;
            state->started.set_value();
            const HANDLE handles[] = {state->stop.value, available.value};
            while (state->admission) {
                const DWORD wait = WaitForMultipleObjects(2, handles, FALSE, INFINITE);
                if (wait == WAIT_OBJECT_0) break;
                if (wait != WAIT_OBJECT_0 + 1) fail("Microphone wait failed.");
                UINT packets = 0;
                check(capture->GetNextPacketSize(&packets));
                while (packets && state->admission) {
                    BYTE* buffer = nullptr;
                    UINT frames = 0;
                    DWORD flags = 0;
                    check(capture->GetBuffer(&buffer, &frames, &flags, nullptr, nullptr));
                    try { writer->append(reinterpret_cast<float*>(buffer), frames, (flags & AUDCLNT_BUFFERFLAGS_SILENT) != 0); }
                    catch (...) { capture->ReleaseBuffer(frames); throw; }
                    check(capture->ReleaseBuffer(frames));
                    check(capture->GetNextPacketSize(&packets));
                }
            }
        } catch (const winrt::hresult_error& error) {
            state->error = winrt::to_string(error.message());
            if (started) state->disconnected = true;
            else state->started.set_exception(std::current_exception());
        } catch (...) {
            state->error = "Microphone capture failed.";
            if (started) state->disconnected = true;
            else state->started.set_exception(std::current_exception());
        }
        if (client && started) client->Stop();
        if (devices && listener) devices->UnregisterEndpointNotificationCallback(listener.get());
        bool usable = false;
        if (writer) {
            try { state->duration = writer->finish(); usable = true; }
            catch (...) { state->error = "Could not finalize temporary audio."; }
            writer.reset();
        }
        if (created && (state->cancelled || !started || !usable)) { DeleteFileW(state->path.c_str()); state->ownsFile = false; }
        state->done = true;
        if (started && !state->cancelled && usable) {
            auto event = result(*state);
            event.Insert(L"type", json(state->disconnected ? L"microphone-disconnected" : L"capture-stopped"));
            if (state->disconnected) event.Insert(L"reason", json(L"The selected microphone disconnected or changed format."));
            emit(event);
        }
        client = nullptr; listener = nullptr; devices = nullptr;
        winrt::uninit_apartment();
    }
public:
    void closeAdmission(const std::wstring& id, bool cancel) {
        std::lock_guard lock(mutex);
        if (!current || (!id.empty() && id != current->id)) return;
        current->admission = false;
        if (cancel) current->cancelled = true;
        SetEvent(current->stop.value);
    }
    std::shared_ptr<CaptureState> reserveStart(const JsonObject& command) {
        auto state = std::make_shared<CaptureState>();
        state->id = string(command, L"id"); state->path = string(command, L"path");
        state->device = std::wstring(command.GetNamedString(L"deviceId", L"default"));
        if (state->id.empty()) fail("Capture id cannot be empty.");
        std::lock_guard lock(mutex);
        if (current && !current->done) fail("A recording is already in progress.");
        current = state;
        return state;
    }
    JsonObject start(const std::shared_ptr<CaptureState>& state) {
        if (worker.joinable()) worker.join();
        auto ready = state->started.get_future();
        worker = std::thread(record, state);
        ready.get();
        return object({{L"id", json(state->id)}});
    }
    JsonObject finish(const std::wstring& id, bool cancel) {
        std::shared_ptr<CaptureState> state;
        {
            std::lock_guard lock(mutex);
            state = current;
            if (state && !id.empty() && id != state->id) fail("Capture id no longer matches.");
        }
        if (!state) {
            if (cancel) return object({{L"cancelled", json(false)}});
            fail("There is no active recording.");
        }
        closeAdmission(id, cancel);
        if (worker.joinable()) worker.join();
        { std::lock_guard lock(mutex); current.reset(); }
        if (cancel) { if (state->ownsFile) DeleteFileW(state->path.c_str()); return object({{L"cancelled", json(true)}}); }
        if (!state->error.empty() && !state->disconnected) fail(state->error.c_str());
        return result(*state);
    }
    ~CaptureController() { closeAdmission(L"", true); if (worker.joinable()) worker.join(); }
};
