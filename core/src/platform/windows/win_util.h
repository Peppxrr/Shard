// Small Win32 helpers shared by the Windows platform implementation files.
#pragma once

#include <windows.h>

#include <string>

namespace shard::win {

// UTF-16 (Win32 strings, WASAPI device ids) -> UTF-8.
inline std::string utf8FromWide(const wchar_t* w)
{
  if (!w || !*w)
    return {};
  const int len = WideCharToMultiByte(CP_UTF8, 0, w, -1, nullptr, 0, nullptr, nullptr);
  if (len <= 1)
    return {};
  std::string out(static_cast<size_t>(len - 1), '\0');
  WideCharToMultiByte(CP_UTF8, 0, w, -1, out.data(), len, nullptr, nullptr);
  return out;
}

} // namespace shard::win
