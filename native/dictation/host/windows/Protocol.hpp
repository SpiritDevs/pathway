#pragma once
#include <windows.h>
#include <winrt/base.h>
#include <winrt/Windows.Data.Json.h>
#include <winrt/Windows.Foundation.Collections.h>
#include <atomic>
#include <cstdio>
#include <cstdint>
#include <cstring>
#include <stdexcept>
#include <functional>
#include <iostream>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

using winrt::Windows::Data::Json::JsonObject;
using winrt::Windows::Data::Json::JsonArray;
using winrt::Windows::Data::Json::JsonValue;
using winrt::Windows::Data::Json::IJsonValue;
inline IJsonValue json(const std::wstring& value) { return JsonValue::CreateStringValue(value); }
inline IJsonValue json(const wchar_t* value) { return JsonValue::CreateStringValue(value); }
inline IJsonValue json(double value) { return JsonValue::CreateNumberValue(value); }
inline IJsonValue json(bool value) { return JsonValue::CreateBooleanValue(value); }
inline JsonObject object(std::initializer_list<std::pair<std::wstring, IJsonValue>> fields) {
    JsonObject result;
    for (const auto& [key, value] : fields) result.Insert(key, value);
    return result;
}
inline void emit(const JsonObject& message) {
    static std::mutex mutex;
    std::lock_guard lock(mutex);
    std::cout << winrt::to_string(message.Stringify()) << '\n' << std::flush;
}
inline void respond(const JsonObject& command, const std::function<IJsonValue()>& operation) {
    try { emit(object({{L"requestId", command.GetNamedValue(L"requestId")}, {L"ok", json(true)}, {L"result", operation()}})); }
    catch (const winrt::hresult_error& error) {
        emit(object({{L"requestId", command.GetNamedValue(L"requestId")}, {L"ok", json(false)}, {L"error", JsonValue::CreateStringValue(error.message())}}));
    } catch (const std::exception& error) {
        emit(object({{L"requestId", command.GetNamedValue(L"requestId")}, {L"ok", json(false)}, {L"error", JsonValue::CreateStringValue(winrt::to_hstring(error.what()))}}));
    }
}
inline void fail(const char* message) { throw std::runtime_error(message); }
inline void check(HRESULT result) { winrt::check_hresult(result); }
inline std::wstring string(const JsonObject& value, const wchar_t* key) { return std::wstring(value.GetNamedString(key)); }
inline JsonObject insertionResult(const wchar_t* status, const wchar_t* reason = L"") {
    auto result = object({{L"status", json(status)}});
    if (*reason) result.Insert(L"reason", json(reason));
    return result;
}
struct Handle {
    HANDLE value = nullptr;
    explicit Handle(HANDLE value = nullptr) : value(value) {}
    ~Handle() { if (value && value != INVALID_HANDLE_VALUE) CloseHandle(value); }
    Handle(const Handle&) = delete;
    Handle& operator=(const Handle&) = delete;
};
