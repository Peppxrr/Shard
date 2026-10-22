// Windows hotkeys stay in the app (uiohook keyboard hook); the core reports
// hotkeys.bind as unsupported.
#include "platform/global_shortcuts.h"

namespace shard::platform {

void startGlobalShortcuts(std::function<void(const std::string&)>) {}

void stopGlobalShortcuts() {}

ShortcutBindResult bindGlobalShortcuts(const std::vector<ShortcutBinding>&)
{
  return {};
}

} // namespace shard::platform
