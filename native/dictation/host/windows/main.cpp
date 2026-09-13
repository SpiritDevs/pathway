#include "Protocol.hpp"
#include "Capture.hpp"
#include "Insertion.hpp"
#include "Shortcut.hpp"
#include "Permissions.hpp"
#include <shellapi.h>
#include <wtsapi32.h>
#include <condition_variable>
#include <deque>
#include <fstream>

class TaskQueue {
    std::mutex mutex;
    std::condition_variable wake;
    std::deque<std::function<void()>> tasks;
    bool closed = false;
    std::thread thread;
public:
    TaskQueue() : thread([this] {
        winrt::init_apartment(winrt::apartment_type::multi_threaded);
        for (;;) {
            std::function<void()> action;
            {
                std::unique_lock lock(mutex);
                wake.wait(lock, [this] { return closed || !tasks.empty(); });
                if (tasks.empty()) break;
                action = std::move(tasks.front()); tasks.pop_front();
            }
            action();
        }
        winrt::uninit_apartment();
    }) {}
    void post(std::function<void()> task) {
        { std::lock_guard lock(mutex); if (closed) return; tasks.push_back(std::move(task)); }
        wake.notify_one();
    }
    ~TaskQueue() {
        { std::lock_guard lock(mutex); closed = true; }
        wake.notify_one(); thread.join();
    }
};

constexpr UINT dispatchMessage = WM_APP + 1;
static std::function<void(const wchar_t*)> interruption;
static LRESULT CALLBACK windowProcedure(HWND window, UINT message, WPARAM wParam, LPARAM lParam) {
    if (message == dispatchMessage) {
        std::unique_ptr<std::function<void()>> task(reinterpret_cast<std::function<void()>*>(lParam));
        (*task)(); return 0;
    }
    if (message == WM_WTSSESSION_CHANGE && wParam == WTS_SESSION_LOCK && interruption) interruption(L"screen-lock");
    if (message == WM_POWERBROADCAST && wParam == PBT_APMSUSPEND && interruption) interruption(L"sleep");
    return DefWindowProcW(window, message, wParam, lParam);
}
static void onMain(HWND window, std::function<void()> operation) {
    auto task = std::make_unique<std::function<void()>>(std::move(operation));
    if (!PostMessageW(window, dispatchMessage, 0, reinterpret_cast<LPARAM>(task.get()))) fail("Native message loop is unavailable.");
    task.release();
}

static int selfTest() {
    const PermissionRequestPlan microphoneOnly(object({{L"request", json(true)}, {L"permission", json(L"microphone")}}));
    if (!microphoneOnly.microphone || microphoneOnly.accessibility) fail("Microphone-only routing failed.");
    const PermissionRequestPlan accessibilityOnly(object({{L"request", json(true)}, {L"permission", json(L"accessibility")}}));
    if (accessibilityOnly.microphone || !accessibilityOnly.accessibility) fail("Accessibility-only routing failed.");
    const PermissionRequestPlan legacy(object({{L"request", json(true)}}));
    if (!legacy.microphone || !legacy.accessibility) fail("Legacy permission routing failed.");
    const PermissionRequestPlan readOnly(object({{L"request", json(false)}, {L"permission", json(L"microphone")}}));
    if (readOnly.microphone || readOnly.accessibility) fail("Permission check must not prompt.");
    wchar_t temporary[MAX_PATH]{};
    if (!GetTempPathW(MAX_PATH, temporary)) fail("No temporary directory.");
    auto path = std::filesystem::path(temporary) / (L"pathway-host-test-" + std::to_wstring(GetCurrentProcessId()) + L".wav");
    int levels = 0;
    {
        WaveWriter writer(path.wstring(), [&](double, double level) { if (level < 0 || level > 1) fail("Invalid level."); ++levels; });
        std::vector<float> samples(16000);
        for (unsigned index = 0; index < samples.size(); ++index) samples[index] = static_cast<float>(.3 * std::sin(index * 2 * 3.141592653589793 * 440 / 16000));
        writer.append(samples.data(), static_cast<UINT>(samples.size()), false);
        if (writer.finish() != 1000 || levels != 20) fail("WAV duration or level window is incorrect.");
    }
    std::ifstream input(path, std::ios::binary);
    std::vector<char> bytes((std::istreambuf_iterator<char>(input)), std::istreambuf_iterator<char>());
    input.close();
    DeleteFileW(path.c_str());
    if (bytes.size() != 32044 || std::string(bytes.data(), 4) != "RIFF" || std::string(bytes.data() + 8, 4) != "WAVE") fail("Invalid WAV header.");
    // Deliberately no system clipboard or real microphone changes in self-tests.
    std::cout << "PASS: permission routing, PCM16 WAV header, duration and levels\n";
    return 0;
}

int wmain(int argc, wchar_t** argv) {
    try {
        winrt::init_apartment(winrt::apartment_type::multi_threaded);
        if (argc > 1 && std::wstring(argv[1]) == L"--self-test") return selfTest();
        WNDCLASSW windowClass{};
        windowClass.lpfnWndProc = windowProcedure;
        windowClass.hInstance = GetModuleHandleW(nullptr);
        windowClass.lpszClassName = L"PathwayDictationHost";
        if (!RegisterClassW(&windowClass)) fail("Could not register native message window.");
        HWND window = CreateWindowExW(WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE, windowClass.lpszClassName, L"Pathway Dictation", WS_POPUP,
            0, 0, 0, 0, nullptr, nullptr, windowClass.hInstance, nullptr);
        if (!window) fail("Could not create native message window.");
        WTSRegisterSessionNotification(window, NOTIFY_FOR_THIS_SESSION);
        CaptureController capture;
        ShortcutMonitor shortcut;
        TextInsertion insertion(window);
        TaskQueue commands, deliveries;
        std::atomic<bool> shuttingDown{false};
        interruption = [&](const wchar_t* reason) {
            insertion.cancel(); capture.closeAdmission(L"", true);
            emit(object({{L"type", json(L"cancel")}, {L"reason", json(reason)}}));
            commands.post([&] { try { capture.finish(L"", true); } catch (...) {} });
        };
        auto shutdown = [&](std::optional<JsonObject> command) {
            insertion.cancel(); capture.closeAdmission(L"", true);
            onMain(window, [&] { shortcut.stop(); });
            commands.post([&, command] {
                try { capture.finish(L"", true); } catch (...) {}
                deliveries.post([&, command] {
                    if (command) respond(*command, [] { return object({{L"shutdown", json(true)}}); });
                    onMain(window, [] { PostQuitMessage(0); });
                });
            });
        };
        std::thread input([&] {
            winrt::init_apartment(winrt::apartment_type::multi_threaded);
            std::string line;
            while (std::getline(std::cin, line)) {
                if (shuttingDown) break;
                try {
                    JsonObject command;
                    if (line.size() > 2'097'152 || !JsonObject::TryParse(winrt::to_hstring(line), command) || !command.HasKey(L"requestId") || !command.HasKey(L"type")) {
                        emit(object({{L"type", json(L"error")}, {L"message", json(L"Invalid JSON-lines command.")}})); continue;
                    }
                    const auto type = string(command, L"type");
                    if (type == L"shutdown") { shuttingDown = true; shutdown(command); break; }
                    if (type == L"configureShortcut") {
                        onMain(window, [&, command] { respond(command, [&] { return shortcut.configure(string(command, L"shortcut"), command.GetNamedBoolean(L"enabled")); }); });
                    } else if (type == L"startCapture") {
                        try {
                            const auto state = capture.reserveStart(command);
                            commands.post([&, command, state] { respond(command, [&] { return capture.start(state); }); });
                        } catch (...) {
                            const auto error = std::current_exception();
                            respond(command, [error]() -> IJsonValue { std::rethrow_exception(error); });
                        }
                    } else if (type == L"insert") {
                        const auto ticket = insertion.ticket();
                        deliveries.post([&, command, ticket] { respond(command, [&] { return insertion.insert(string(command, L"text"), ticket); }); });
                    } else {
                        const auto id = std::wstring(command.GetNamedString(L"id", L""));
                        if (type == L"cancelCapture" || type == L"stopCapture") {
                            capture.closeAdmission(id, type == L"cancelCapture");
                            if (type == L"cancelCapture") insertion.cancel();
                        }
                        commands.post([&, command, type, id] { respond(command, [&]() -> IJsonValue {
                            if (type == L"enumerate") return microphones();
                            if (type == L"permissions") return permissions(command);
                            if (type == L"stopCapture" || type == L"cancelCapture") return capture.finish(id, type == L"cancelCapture");
                            fail("Unknown native dictation command.");
                            return nullptr;
                        }); });
                    }
                } catch (...) { emit(object({{L"type", json(L"error")}, {L"message", json(L"Invalid native dictation command.")}})); }
            }
            if (!shuttingDown.exchange(true)) shutdown({});
            winrt::uninit_apartment();
        });
        JsonArray shortcuts;
        for (auto name : {L"right-control", L"right-option", L"F8"}) shortcuts.Append(json(name));
        emit(object({{L"type", json(L"ready")}, {L"protocolVersion", json(1.0)}, {L"platform", json(L"win32")}, {L"shortcuts", shortcuts}}));
        MSG message{};
        while (GetMessageW(&message, nullptr, 0, 0) > 0) { TranslateMessage(&message); DispatchMessageW(&message); }
        input.join();
        interruption = {};
        shortcut.stop();
        WTSUnRegisterSessionNotification(window);
        DestroyWindow(window);
        return 0;
    } catch (const winrt::hresult_error& error) { std::cerr << winrt::to_string(error.message()) << '\n'; }
      catch (const std::exception& error) { std::cerr << error.what() << '\n'; }
    return 1;
}
