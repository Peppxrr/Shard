// Desktop-owned global shortcuts (RPC hotkeys.bind / event hotkey.pressed).
//
// Windows: unsupported here; the app observes keys itself (uiohook).
// Linux (KDE Plasma): KDE's kglobalaccel service, which lives inside KWin on
// Plasma 6. Shortcuts appear in System Settings > Shortcuts under "Shard" and
// fire while the core runs. Other desktops: unsupported (the app falls back
// to Electron's GlobalShortcuts portal path).
#pragma once

#include <functional>
#include <string>
#include <vector>

namespace shard::platform {

struct ShortcutBinding {
  std::string id;          // hotkey action id, e.g. "save_60"
  std::string accelerator; // Electron accelerator, e.g. "CommandOrControl+Shift+F8"; "" unbinds
  std::string description; // label shown by the desktop
};

struct ShortcutBindResult {
  struct Item {
    std::string id;
    bool ok = false;
    std::string error; // empty when ok
  };
  bool supported = false;
  std::vector<Item> results;
};

// Starts the shortcut service; `onPressed(id)` runs on its thread. Safe to
// call when unsupported. stop is idempotent and joins the thread.
void startGlobalShortcuts(std::function<void(const std::string& id)> onPressed);
void stopGlobalShortcuts();

// Replaces the full set of bound shortcuts (ids missing from `bindings` are
// unbound). Blocks until the desktop answered (bounded).
ShortcutBindResult bindGlobalShortcuts(const std::vector<ShortcutBinding>& bindings);

} // namespace shard::platform
