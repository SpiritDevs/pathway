// Pathway process lifetime boundary for the Sotto-derived workers.
#pragma once
#include "ggml-backend.h"

#include <charconv>
#include <climits>
#include <cstdlib>
#include <string>
#include <thread>
#include <vector>

#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include <fcntl.h>
#include <io.h>
#else
#include <cerrno>
#include <sys/event.h>
#include <unistd.h>
#endif

inline bool parseParentPid(const std::string &text, unsigned long &pid) {
    const auto parsed = std::from_chars(text.data(), text.data() + text.size(), pid);
    return parsed.ec == std::errc{} && parsed.ptr == text.data() + text.size() && pid > 1 && pid <= INT_MAX;
}

inline void configurePipes() {
#ifdef _WIN32
    _setmode(_fileno(stdin), _O_BINARY);
    _setmode(_fileno(stdout), _O_BINARY);
#endif
}

inline bool hasGPU() {
    return ggml_backend_dev_by_type(GGML_BACKEND_DEVICE_TYPE_GPU) != nullptr ||
           ggml_backend_dev_by_type(GGML_BACKEND_DEVICE_TYPE_IGPU) != nullptr;
}

// Block on OS process-exit notification even while inference owns the main thread.
// No timer, polling thread, app data access, or network connection is needed.
inline void watchParent(unsigned long expectedPid) {
#ifdef _WIN32
    if (expectedPid <= 1) std::_Exit(2);
    HANDLE parent = OpenProcess(SYNCHRONIZE, FALSE, static_cast<DWORD>(expectedPid));
    if (!parent) std::_Exit(2);
    std::thread([parent] {
        WaitForSingleObject(parent, INFINITE);
        CloseHandle(parent);
        std::_Exit(0);
    }).detach();
#else
    const pid_t parent = getppid();
    if (parent <= 1 || (expectedPid != 0 && expectedPid != static_cast<unsigned long>(parent))) std::_Exit(0);
    const int queue = kqueue();
    if (queue < 0) std::_Exit(2);
    struct kevent change;
    EV_SET(&change, parent, EVFILT_PROC, EV_ADD | EV_ONESHOT, NOTE_EXIT, 0, nullptr);
    if (kevent(queue, &change, 1, nullptr, 0, nullptr) < 0 || getppid() != parent) {
        close(queue);
        std::_Exit(0);
    }
    std::thread([queue] {
        struct kevent event;
        while (kevent(queue, nullptr, 0, &event, 1, nullptr) < 0 && errno == EINTR) {}
        close(queue);
        std::_Exit(0);
    }).detach();
#endif
}

int runEngine(int argc, char **argv);

#ifdef _WIN32
// The Windows CRT's narrow argv uses the system code page. Convert UTF-16 explicitly
// so model directories containing non-ASCII account names reach ggml_fopen as UTF-8.
int wmain(int argc, wchar_t **wideArgv) {
    std::vector<std::string> values;
    values.reserve(argc);
    for (int index = 0; index < argc; ++index) {
        const int size = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, wideArgv[index], -1, nullptr, 0, nullptr, nullptr);
        if (size <= 0) return 2;
        std::string value(static_cast<size_t>(size), '\0');
        if (!WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, wideArgv[index], -1, value.data(), size, nullptr, nullptr)) return 2;
        value.pop_back();
        values.push_back(std::move(value));
    }
    std::vector<char *> args;
    for (auto &value : values) args.push_back(value.data());
    args.push_back(nullptr);
    return runEngine(argc, args.data());
}
#else
int main(int argc, char **argv) { return runEngine(argc, argv); }
#endif
