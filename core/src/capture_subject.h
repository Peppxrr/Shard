#pragma once

#include <cstdint>
#include <string>

namespace shard {

// What SourceManager captures. Window subjects come from GameSystem's primary
// session; the platform capture backend resolves them to a live window.
struct CaptureSubject {
  enum class Kind { None, Monitor, Window };
  Kind kind = Kind::None;
  std::string exe;   // lowercase exe basename (window subjects), e.g. "eldenring.exe"
  std::string title; // window title (may be empty)
  std::string cls;   // window class / Wayland app id (may be empty)
  std::string name;  // display name (game name / "Desktop")
  uint32_t pid = 0;  // process id (window subjects)

  bool operator==(const CaptureSubject& o) const
  {
    return kind == o.kind && exe == o.exe && title == o.title && cls == o.cls && pid == o.pid && name == o.name;
  }
  bool operator!=(const CaptureSubject& o) const { return !(*this == o); }
};

} // namespace shard
