#pragma once
#include "Protocol.hpp"
#include <shellapi.h>

struct PermissionRequestPlan {
    bool microphone = false;
    bool accessibility = false;
    explicit PermissionRequestPlan(const JsonObject& command) {
        std::wstring selected;
        if (command.HasKey(L"permission")) {
            selected = string(command, L"permission");
            if (selected != L"microphone" && selected != L"accessibility") fail("permission must be microphone or accessibility.");
        }
        const bool request = command.GetNamedBoolean(L"request", false);
        microphone = request && (selected.empty() || selected == L"microphone");
        accessibility = request && (selected.empty() || selected == L"accessibility");
    }
};

inline std::wstring microphonePermission() {
    bool allowed = false;
    for (HKEY root : {HKEY_LOCAL_MACHINE, HKEY_CURRENT_USER}) {
        for (const wchar_t* suffix : {L"", L"\\NonPackaged"}) {
            const auto key = std::wstring(L"SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone") + suffix;
            wchar_t value[64]{};
            DWORD bytes = sizeof(value);
            if (RegGetValueW(root, key.c_str(), L"Value", RRF_RT_REG_SZ, nullptr, value, &bytes) == ERROR_SUCCESS) {
                if (_wcsicmp(value, L"Deny") == 0) return L"denied";
                if (_wcsicmp(value, L"Allow") == 0) allowed = true;
            }
        }
    }
    return allowed ? L"granted" : L"unknown";
}

inline JsonObject permissions(const JsonObject& command) {
    const PermissionRequestPlan plan(command);
    auto microphone = microphonePermission();
    if (plan.microphone && microphone != L"granted") ShellExecuteW(nullptr, L"open", L"ms-settings:privacy-microphone", nullptr, nullptr, SW_SHOWNORMAL);
    // Win32 desktop apps have no AX consent prompt. A selected accessibility request opens no microphone UI.
    // UIPI is checked at delivery, so this reports availability of the interactive desktop only.
    HDESK desktop = OpenInputDesktop(0, FALSE, DESKTOP_READOBJECTS);
    const bool interactive = desktop != nullptr;
    if (desktop) CloseDesktop(desktop);
    return object({{L"microphone", json(microphone)}, {L"accessibility", json(interactive ? L"granted" : L"denied")},
        {L"inputMonitoring", json(interactive ? L"granted" : L"denied")}});
}
