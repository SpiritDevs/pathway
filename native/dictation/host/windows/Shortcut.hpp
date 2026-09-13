#pragma once
#include "Protocol.hpp"

class ShortcutMonitor {
    inline static ShortcutMonitor* instance = nullptr;
    HHOOK hook = nullptr;
    UINT_PTR timer = 0;
    bool down = false, blocked = false, escapeDown = false;
    DWORD key = VK_RCONTROL;
    std::wstring shortcut = L"right-control";
    static void CALLBACK watchdog(HWND, UINT, UINT_PTR, DWORD) {
        if (instance && instance->down && !(GetAsyncKeyState(instance->key) & 0x8000)) {
            instance->edge(false); instance->blocked = false;
        }
    }
    void edge(bool pressed) {
        if (down == pressed) return;
        down = pressed;
        emit(object({{L"type", json(pressed ? L"shortcut-down" : L"shortcut-up")}, {L"shortcut", json(shortcut)}, {L"timestampMs", json(static_cast<double>(GetTickCount64()))}}));
        if (timer) { KillTimer(nullptr, timer); timer = 0; }
        if (pressed) timer = SetTimer(nullptr, 0, 120, watchdog);
    }
    bool otherModifiers() const {
        for (DWORD modifier : {VK_LCONTROL, VK_RCONTROL, VK_LMENU, VK_RMENU, VK_LSHIFT, VK_RSHIFT, VK_LWIN, VK_RWIN}) {
            if (modifier != key && (GetAsyncKeyState(modifier) & 0x8000)) return true;
        }
        return false;
    }
    static LRESULT CALLBACK callback(int code, WPARAM message, LPARAM data) {
        if (code == HC_ACTION && instance) {
            auto event = reinterpret_cast<const KBDLLHOOKSTRUCT*>(data);
            if (!(event->flags & LLKHF_INJECTED)) instance->receive(event->vkCode, message == WM_KEYDOWN || message == WM_SYSKEYDOWN);
        }
        return CallNextHookEx(nullptr, code, message, data);
    }
public:
    void receive(DWORD eventKey, bool pressed) {
        if (eventKey == VK_ESCAPE) {
            if (pressed && !escapeDown) {
                emit(object({{L"type", json(L"cancel")}, {L"reason", json(L"escape")}}));
                blocked = down;
            }
            escapeDown = pressed;
            return;
        }
        if (eventKey == key) {
            if (!pressed) { edge(false); blocked = false; return; }
            if (blocked || down) return;
            if (otherModifiers()) { blocked = true; return; }
            edge(true);
        } else if (pressed && down && !blocked) {
            blocked = true;
            emit(object({{L"type", json(L"cancel")}, {L"reason", json(L"shortcut-interrupted")}}));
        }
    }
    JsonObject configure(const std::wstring& value, bool enabled) {
        if (value != L"right-control" && value != L"right-option" && value != L"F8") fail("Windows does not expose a portable Fn key. Choose Right Control, Right Alt/Option, or F8.");
        stop();
        shortcut = value;
        key = value == L"F8" ? VK_F8 : value == L"right-option" ? VK_RMENU : VK_RCONTROL;
        if (enabled) {
            instance = this;
            hook = SetWindowsHookExW(WH_KEYBOARD_LL, callback, GetModuleHandleW(nullptr), 0);
            if (!hook) { instance = nullptr; fail("Could not install the Windows shortcut listener."); }
            blocked = (GetAsyncKeyState(key) & 0x8000) != 0;
        }
        return object({{L"enabled", json(enabled)}, {L"shortcut", json(shortcut)}});
    }
    void stop() {
        if (down) emit(object({{L"type", json(L"cancel")}, {L"reason", json(L"shortcut-interrupted")}}));
        down = blocked = escapeDown = false;
        if (timer) { KillTimer(nullptr, timer); timer = 0; }
        if (hook) { UnhookWindowsHookEx(hook); hook = nullptr; }
        if (instance == this) instance = nullptr;
    }
    ~ShortcutMonitor() { stop(); }
};
