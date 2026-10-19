#pragma once
// Delivery adapts Sotto's one-attempt transaction and clipboard revision ownership policy.
// Copyright (c) 2026 Davis. MIT license; see ../LICENSE-Sotto.
#include "Protocol.hpp"
#include <UIAutomation.h>
#include <ole2.h>
#include <chrono>
#include <optional>

struct ClipboardFormat {
    UINT format;
    HANDLE data;
    ClipboardFormat(UINT format, HANDLE data) : format(format), data(data) {}
    ClipboardFormat(ClipboardFormat&& other) noexcept : format(other.format), data(other.data) { other.data = nullptr; }
    ClipboardFormat(const ClipboardFormat&) = delete;
    ~ClipboardFormat() {
        if (!data) return;
        switch (format) {
        case CF_BITMAP: case CF_DSPBITMAP: case CF_PALETTE: DeleteObject(data); break;
        case CF_ENHMETAFILE: case CF_DSPENHMETAFILE: DeleteEnhMetaFile(static_cast<HENHMETAFILE>(data)); break;
        case CF_METAFILEPICT: case CF_DSPMETAFILEPICT:
            if (auto picture = static_cast<METAFILEPICT*>(GlobalLock(data))) { DeleteMetaFile(picture->hMF); GlobalUnlock(data); }
            GlobalFree(data); break;
        default: GlobalFree(data); break;
        }
    }
};
struct ClipboardOpen {
    bool opened;
    explicit ClipboardOpen(HWND owner) : opened(OpenClipboard(owner) != FALSE) {}
    ~ClipboardOpen() { if (opened) CloseClipboard(); }
};
class ClipboardLease {
    HWND owner;
    std::vector<ClipboardFormat> snapshot;
    DWORD original = 0, owned = 0;
    bool staged = false;
public:
    explicit ClipboardLease(HWND owner) : owner(owner) {}
    bool capture() {
        ClipboardOpen clipboard(owner);
        if (!clipboard.opened) return false;
        original = GetClipboardSequenceNumber();
        UINT format = 0;
        std::size_t bytes = 0;
        SetLastError(ERROR_SUCCESS);
        while ((format = EnumClipboardFormats(format)) != 0) {
            if (format == CF_OWNERDISPLAY || snapshot.size() >= 512) return false;
            HANDLE source = GetClipboardData(format);
            if (!source) return false;
            bytes += GlobalSize(source);
            if (bytes > 32 * 1024 * 1024) return false;
            HANDLE copy = OleDuplicateData(source, static_cast<CLIPFORMAT>(format), 0);
            if (!copy) return false;
            snapshot.emplace_back(format, copy);
            SetLastError(ERROR_SUCCESS);
        }
        return GetLastError() == ERROR_SUCCESS && GetClipboardSequenceNumber() == original;
    }
    bool stage(const std::wstring& text) {
        HGLOBAL allocation = GlobalAlloc(GMEM_MOVEABLE, (text.size() + 1) * sizeof(wchar_t));
        if (!allocation) return false;
        void* memory = GlobalLock(allocation);
        if (!memory) { GlobalFree(allocation); return false; }
        memcpy(memory, text.c_str(), (text.size() + 1) * sizeof(wchar_t));
        GlobalUnlock(allocation);
        ClipboardOpen clipboard(owner);
        if (!clipboard.opened || GetClipboardSequenceNumber() != original) { GlobalFree(allocation); return false; }
        if (!EmptyClipboard()) { GlobalFree(allocation); return false; }
        staged = true;
        const bool written = SetClipboardData(CF_UNICODETEXT, allocation) != nullptr;
        if (!written) GlobalFree(allocation);
        owned = GetClipboardSequenceNumber();
        return written;
    }
    bool unchanged() const { return staged && GetClipboardSequenceNumber() == owned; }
    ~ClipboardLease() {
        if (!staged) return;
        // A target may still have the clipboard open while handling paste.
        for (int attempt = 0; attempt < 10; ++attempt) {
            if (!unchanged()) return;
            ClipboardOpen clipboard(owner);
            if (clipboard.opened) {
                if (!unchanged() || !EmptyClipboard()) return;
                for (auto& item : snapshot) {
                    if (SetClipboardData(item.format, item.data)) item.data = nullptr;
                }
                return;
            }
            std::this_thread::sleep_for(std::chrono::milliseconds(50));
        }
    }
};

struct FocusedField {
    winrt::com_ptr<IUIAutomationElement> element;
    winrt::com_ptr<IUIAutomationTextPattern> textPattern;
    winrt::com_ptr<IUIAutomationTextRange> selection;
    HWND window = nullptr;
    int pid = 0;
};
inline bool modifiersHeld() {
    for (int key : {VK_SHIFT, VK_CONTROL, VK_MENU, VK_LWIN, VK_RWIN}) if (GetAsyncKeyState(key) & 0x8000) return true;
    return false;
}
class TextInsertion {
    std::atomic<std::uint64_t> generation{0};
    winrt::com_ptr<IUIAutomation> automation;
    HWND clipboardOwner;
    using Clock = std::chrono::steady_clock;
    std::optional<FocusedField> focus() {
        FocusedField result;
        result.window = GetForegroundWindow();
        if (!result.window || FAILED(automation->GetFocusedElement(result.element.put())) || !result.element) return {};
        BOOL password = TRUE, enabled = FALSE, focused = FALSE;
        CONTROLTYPEID control = 0;
        if (FAILED(result.element->get_CurrentIsPassword(&password)) || password ||
            FAILED(result.element->get_CurrentIsEnabled(&enabled)) || !enabled ||
            FAILED(result.element->get_CurrentHasKeyboardFocus(&focused)) || !focused ||
            FAILED(result.element->get_CurrentControlType(&control)) ||
            (control != UIA_EditControlTypeId && control != UIA_DocumentControlTypeId && control != UIA_ComboBoxControlTypeId) ||
            FAILED(result.element->get_CurrentProcessId(&result.pid)) || result.pid == static_cast<int>(GetCurrentProcessId())) return {};
        DWORD foregroundPid = 0;
        GetWindowThreadProcessId(result.window, &foregroundPid);
        if (foregroundPid != static_cast<DWORD>(result.pid)) return {};
        if (FAILED(result.element->GetCurrentPatternAs(UIA_TextPatternId, __uuidof(IUIAutomationTextPattern), result.textPattern.put_void()))) return {};
        winrt::com_ptr<IUIAutomationTextRangeArray> selections;
        int count = 0;
        if (FAILED(result.textPattern->GetSelection(selections.put())) ||
            FAILED(selections->get_Length(&count)) || count != 1 || FAILED(selections->GetElement(0, result.selection.put()))) return {};
        VARIANT readOnly;
        VariantInit(&readOnly);
        HRESULT access = result.selection->GetAttributeValue(UIA_IsReadOnlyAttributeId, &readOnly);
        const bool editable = SUCCEEDED(access) && readOnly.vt == VT_BOOL && readOnly.boolVal == VARIANT_FALSE;
        VariantClear(&readOnly);
        if (!editable || GetForegroundWindow() != result.window) return {};
        return result;
    }
    bool matches(const FocusedField& expected, bool caret = true) {
        auto current = focus();
        if (!current || current->window != expected.window || current->pid != expected.pid) return false;
        BOOL same = FALSE;
        if (FAILED(automation->CompareElements(current->element.get(), expected.element.get(), &same)) || !same) return false;
        if (!caret) return true;
        int start = 1, end = 1;
        return SUCCEEDED(current->selection->CompareEndpoints(TextPatternRangeEndpoint_Start, expected.selection.get(), TextPatternRangeEndpoint_Start, &start)) &&
            SUCCEEDED(current->selection->CompareEndpoints(TextPatternRangeEndpoint_End, expected.selection.get(), TextPatternRangeEndpoint_End, &end)) && start == 0 && end == 0;
    }
    static std::optional<std::wstring> documentText(const FocusedField& field) {
        winrt::com_ptr<IUIAutomationTextRange> document;
        BSTR text = nullptr;
        if (FAILED(field.textPattern->get_DocumentRange(document.put())) || FAILED(document->GetText(1'048'577, &text))) return {};
        std::wstring result = text ? std::wstring(text, SysStringLen(text)) : std::wstring();
        SysFreeString(text);
        if (result.size() > 1'048'576) return {};
        return result;
    }
    static std::optional<std::wstring> expectedDocument(const FocusedField& field, const std::wstring& text) {
        auto before = documentText(field);
        if (!before) return {};
        winrt::com_ptr<IUIAutomationTextRange> prefix;
        if (FAILED(field.textPattern->get_DocumentRange(prefix.put())) ||
            FAILED(prefix->MoveEndpointByRange(TextPatternRangeEndpoint_End, field.selection.get(), TextPatternRangeEndpoint_Start))) return {};
        BSTR leading = nullptr, selected = nullptr;
        if (FAILED(prefix->GetText(1'048'577, &leading))) return {};
        const auto position = SysStringLen(leading);
        SysFreeString(leading);
        if (FAILED(field.selection->GetText(1'048'577, &selected))) return {};
        const auto length = SysStringLen(selected);
        SysFreeString(selected);
        if (position > before->size() || length > before->size() - position) return {};
        return before->substr(0, position) + text + before->substr(position + length);
    }
public:
    explicit TextInsertion(HWND clipboardOwner) : clipboardOwner(clipboardOwner) {}
    void cancel() { ++generation; }
    std::uint64_t ticket() const { return generation.load(); }
    JsonObject insert(const std::wstring& text, std::uint64_t token) {
        const auto deadline = Clock::now() + std::chrono::seconds(4);
        auto allowed = [&] { return token == generation.load() && Clock::now() < deadline; };
        if (!allowed() || text.empty() || text.size() > 1'048'576) return insertionResult(L"manual", L"No usable text to insert.");
        if (!automation) {
            automation = winrt::create_instance<IUIAutomation>(CLSID_CUIAutomation8);
            // Bound calls to hung application providers. All UIA runs on a dedicated helper thread.
            auto automation2 = automation.try_as<IUIAutomation2>();
            if (automation2) { automation2->put_ConnectionTimeout(200); automation2->put_TransactionTimeout(200); }
        }
        auto target = focus();
        if (!target || !allowed()) return insertionResult(L"manual", L"No verified editable field is focused.");
        auto expected = expectedDocument(*target, text);
        if (!matches(*target) || modifiersHeld() || !allowed()) return insertionResult(L"manual", L"Focus or keyboard modifiers changed.");
        ClipboardLease clipboard(clipboardOwner);
        if (!clipboard.capture() || !matches(*target) || !allowed() || !clipboard.stage(text))
            return insertionResult(L"manual", L"The clipboard could not be preserved.");
        if (!matches(*target) || modifiersHeld() || !allowed() || !clipboard.unchanged() || GetForegroundWindow() != target->window)
            return insertionResult(L"manual", L"Insertion conditions changed before paste.");
        INPUT inputs[4]{};
        for (auto& input : inputs) input.type = INPUT_KEYBOARD;
        inputs[0].ki.wVk = VK_CONTROL;
        inputs[1].ki.wVk = 'V';
        inputs[2].ki.wVk = 'V'; inputs[2].ki.dwFlags = KEYEVENTF_KEYUP;
        inputs[3].ki.wVk = VK_CONTROL; inputs[3].ki.dwFlags = KEYEVENTF_KEYUP;
        const auto sent = SendInput(4, inputs, sizeof(INPUT));
        if (sent == 0) return insertionResult(L"manual", L"Windows blocked paste into this application.");
        if (sent != 4) {
            // Release any synthetic keys left down by a partial dispatch, without sending text again.
            INPUT releases[2] = {inputs[2], inputs[3]};
            SendInput(2, releases, sizeof(INPUT));
        }
        for (int attempt = 0; attempt < 8; ++attempt) {
            if (attempt) std::this_thread::sleep_for(std::chrono::milliseconds(100));
            if (!allowed() || !matches(*target, false)) continue;
            auto after = documentText(*target);
            if (expected && after && *expected == *after) return insertionResult(L"inserted");
        }
        return insertionResult(L"unconfirmed", L"Paste was sent once; the application did not confirm it.");
    }
};
