// The GLib main-loop thread started by platform::prepareObs dispatches
// linux-pipewire's portal callbacks, which write the screencast source's
// settings (obs_source_save). Code that reads those settings from another
// thread runs the read on this thread instead (capture_linux.cpp).
#pragma once

#include <functional>

namespace shard::platform::glib {

// Runs `fn` on the GLib default main context (directly when no loop thread
// owns it) and waits for it. False when it did not run within ~2 s (`fn`
// may still run later; it must only capture state it owns by value).
bool invokeSync(std::function<void()> fn);

} // namespace shard::platform::glib
