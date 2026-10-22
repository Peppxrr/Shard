// Window information on KDE Plasma (Wayland) through a KWin script.
//
// Wayland gives clients no view of other clients' windows. KWin's scripting
// API does, so the core loads a small generated script into the running KWin
// (org.kde.KWin /Scripting loadScript + run). The script pushes the complete
// window list and output layout to the core over the session bus with
// callDBus(<core unique name>, kObjectPath, kInterface, "Update", json)
// whenever windows appear, disappear, activate or change caption, minimized,
// fullscreen state or geometry. The core owns one sd-bus connection and a
// thread that serves the Update method; calls from anyone but KWin's own bus
// name are rejected. Without KWin (or when the script fails to load)
// windowInfoAvailable() stays false.
#include "platform/window_system.h"

#include "kwin_outputs.h"
#include "log.h"

#include <nlohmann/json.hpp>
#include <systemd/sd-bus.h>

#include <unistd.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <map>
#include <mutex>
#include <string>
#include <thread>
#include <unordered_map>

namespace shard::platform {

namespace {

constexpr const char* kObjectPath = "/dev/shard/KWinBridge";
constexpr const char* kInterface = "dev.shard.KWinBridge";

// %SERVICE% is replaced with the core's unique bus name.
constexpr const char* kScriptTemplate = R"JS(
(function () {
  var service = "%SERVICE%";
  function rect(r) {
    return r ? [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)] : [0, 0, 0, 0];
  }
  function onCurrentDesktop(w) {
    if (w.onAllDesktops) return true;
    var current = workspace.currentDesktop, desktops = w.desktops || [];
    for (var i = 0; i < desktops.length; i++)
      if (desktops[i] && current && desktops[i].id === current.id) return true;
    return false;
  }
  function push() {
    var windows = [], outputs = [], list = workspace.windowList(), active = workspace.activeWindow;
    for (var i = 0; i < list.length; i++) {
      var w = list[i];
      if (!w || w.deleted || w.popupWindow || w.desktopWindow) continue;
      windows.push({
        id: String(w.internalId), pid: w.pid || 0, caption: w.caption || "", cls: w.resourceClass || "",
        frame: rect(w.frameGeometry), client: rect(w.clientGeometry), minimized: !!w.minimized,
        fullScreen: !!w.fullScreen, normal: !!w.normalWindow, special: !!w.specialWindow, dialog: !!w.dialog,
        skipTaskbar: !!w.skipTaskbar, hidden: !!w.hidden, desktop: onCurrentDesktop(w), active: w === active
      });
    }
    var screens = workspace.screens || [];
    for (var j = 0; j < screens.length; j++)
      outputs.push({name: screens[j].name, geometry: rect(screens[j].geometry), scale: screens[j].devicePixelRatio || 1});
    callDBus(service, "/dev/shard/KWinBridge", "dev.shard.KWinBridge", "Update",
             JSON.stringify({windows: windows, outputs: outputs}));
  }
  function on(signal, handler) {
    try { if (signal) signal.connect(handler); } catch (e) {}
  }
  function watch(w) {
    if (!w) return;
    on(w.captionChanged, push);
    on(w.minimizedChanged, push);
    on(w.fullScreenChanged, push);
    on(w.desktopsChanged, push);
    // Interactive moves/resizes report once when finished, not per frame.
    on(w.frameGeometryChanged, function () { if (!w.move && !w.resize) push(); });
    on(w.interactiveMoveResizeFinished, push);
  }
  var initial = workspace.windowList();
  for (var i = 0; i < initial.length; i++) watch(initial[i]);
  on(workspace.windowAdded, function (w) { watch(w); push(); });
  on(workspace.windowRemoved, push);
  on(workspace.windowActivated, push);
  on(workspace.currentDesktopChanged, push);
  on(workspace.screensChanged, push);
  push();
})();
)JS";

struct WindowRecord {
  TopLevelWindow window;
  bool active = false;
};

struct State {
  std::mutex mutex;
  std::condition_variable updated;
  bool available = false;  // KWin script reported at least once
  bool bridgeDone = false; // bridge thread exited (or failed to start)
  std::vector<WindowRecord> windows; // KWin stacking order
  std::vector<kwin::Output> outputs;
  uint32_t foregroundPid = 0;
  std::unordered_map<std::string, uintptr_t> handles; // KWin internalId -> handle (never reused)
  uintptr_t nextHandle = 1;
  std::string kwinOwner; // unique name owning org.kde.KWin
};

State& state()
{
  static State instance;
  return instance;
}

std::thread gThread;
std::atomic<bool> gRun{false};

int rectValue(const nlohmann::json& rect, size_t index)
{
  return rect.is_array() && rect.size() == 4 && rect[index].is_number() ? rect[index].get<int>() : 0;
}

void applyUpdate(const nlohmann::json& payload)
{
  std::vector<kwin::Output> outputs;
  for (const auto& output : payload.value("outputs", nlohmann::json::array())) {
    const auto& geometry = output.value("geometry", nlohmann::json::array());
    kwin::Output o;
    o.name = output.value("name", "");
    o.x = rectValue(geometry, 0);
    o.y = rectValue(geometry, 1);
    o.width = rectValue(geometry, 2);
    o.height = rectValue(geometry, 3);
    o.scale = output.value("scale", 1.0);
    if (o.scale <= 0)
      o.scale = 1.0;
    outputs.push_back(std::move(o));
  }

  auto& s = state();
  std::lock_guard<std::mutex> lock(s.mutex);
  std::vector<WindowRecord> windows;
  uint32_t foreground = 0;
  for (const auto& item : payload.value("windows", nlohmann::json::array())) {
    const std::string id = item.value("id", "");
    const bool hidden = item.value("hidden", false);
    const bool minimized = item.value("minimized", false);
    // listWindows() reports visible windows only (minimized ones included,
    // like iconic Win32 windows). KWin may also mark minimized windows
    // hidden, so only non-minimized hidden windows are dropped.
    if (id.empty() || (hidden && !minimized))
      continue;
    auto [handleIt, inserted] = s.handles.emplace(id, s.nextHandle);
    if (inserted)
      s.nextHandle++;

    WindowRecord record;
    TopLevelWindow& w = record.window;
    w.handle = handleIt->second;
    w.pid = item.value("pid", 0u);
    w.title = item.value("caption", "");
    w.cls = item.value("cls", "");
    const auto& client = item.value("client", nlohmann::json::array());
    w.x = rectValue(client, 0);
    w.y = rectValue(client, 1);
    w.width = rectValue(client, 2);
    w.height = rectValue(client, 3);
    w.minimized = minimized;
    w.fullscreen = item.value("fullScreen", false);
    const bool onDesktop = item.value("desktop", true);
    // Normal application windows and dialogs, not docks/panels/OSDs/
    // notifications (KWin's specialWindow) or taskbar-less helper surfaces
    // (like WS_EX_TOOLWINDOW, e.g. Xwayland Video Bridge), and only on the
    // current virtual desktop, like a non-cloaked Win32 window.
    w.eligible = !item.value("special", false) && (item.value("normal", false) || item.value("dialog", false)) &&
                 !item.value("skipTaskbar", false) && !hidden && onDesktop;

    // Area in physical pixels: logical client size times the scale of the
    // output holding the window's centre.
    double scale = 1.0;
    const int cx = w.x + w.width / 2, cy = w.y + w.height / 2;
    for (const auto& o : outputs) {
      const bool intersects = w.x < o.x + o.width && w.x + w.width > o.x && w.y < o.y + o.height &&
                              w.y + w.height > o.y;
      w.onScreen = w.onScreen || intersects;
      if (cx >= o.x && cx < o.x + o.width && cy >= o.y && cy < o.y + o.height)
        scale = o.scale;
    }
    if (outputs.empty())
      w.onScreen = w.width > 0 && w.height > 0;
    w.onScreen = w.onScreen && !hidden && onDesktop;
    w.area = static_cast<long>(static_cast<double>(w.width) * w.height * scale * scale);
    w.captureable = w.eligible && !w.minimized && w.onScreen && w.area >= 320L * 200L;
    record.active = item.value("active", false);
    if (record.active)
      foreground = w.pid;
    windows.push_back(std::move(record));
  }
  s.windows = std::move(windows);
  s.outputs = std::move(outputs);
  s.foregroundPid = foreground;
  if (!s.available)
    logFormat("[kwin] window bridge active (%zu windows, %zu outputs)", s.windows.size(), s.outputs.size());
  s.available = true;
  s.updated.notify_all();
}

int onUpdate(sd_bus_message* message, void*, sd_bus_error* error)
{
  auto& s = state();
  const char* sender = sd_bus_message_get_sender(message);
  {
    std::lock_guard<std::mutex> lock(s.mutex);
    if (!sender || s.kwinOwner != sender)
      return sd_bus_error_set(error, SD_BUS_ERROR_ACCESS_DENIED, "only KWin may update the window list");
  }
  const char* json = nullptr;
  int r = sd_bus_message_read(message, "s", &json);
  if (r < 0)
    return r;
  try {
    applyUpdate(nlohmann::json::parse(json ? json : "{}"));
  } catch (const std::exception& e) {
    logFormat("[kwin] bad window update: %s", e.what());
  }
  return sd_bus_reply_method_return(message, "");
}

const sd_bus_vtable kVtable[] = {
    SD_BUS_VTABLE_START(0),
    SD_BUS_METHOD("Update", "s", "", onUpdate, SD_BUS_VTABLE_UNPRIVILEGED),
    SD_BUS_VTABLE_END,
};

std::string busError(int r, const sd_bus_error& error)
{
  if (error.message)
    return error.message;
  return std::string("errno ") + std::to_string(-r);
}

bool callKWin(sd_bus* bus, const char* path, const char* interface, const char* method, sd_bus_message** reply,
              std::string& failure, const char* types = nullptr, const char* a = nullptr, const char* b = nullptr)
{
  sd_bus_error error = SD_BUS_ERROR_NULL;
  int r = 0;
  if (!types)
    r = sd_bus_call_method(bus, "org.kde.KWin", path, interface, method, &error, reply, "");
  else if (b)
    r = sd_bus_call_method(bus, "org.kde.KWin", path, interface, method, &error, reply, types, a, b);
  else
    r = sd_bus_call_method(bus, "org.kde.KWin", path, interface, method, &error, reply, types, a);
  if (r < 0)
    failure = busError(r, error);
  sd_bus_error_free(&error);
  return r >= 0;
}

void bridgeThread(std::string pluginName, std::string scriptPath)
{
  sd_bus* bus = nullptr;
  sd_bus_slot* slot = nullptr;
  bool loaded = false;
  auto fail = [](const std::string& what) {
    logFormat("[kwin] window information unavailable: %s", what.c_str());
  };

  int r = sd_bus_open_user(&bus);
  if (r < 0) {
    fail("no session bus (errno " + std::to_string(-r) + ")");
    std::lock_guard<std::mutex> lock(state().mutex);
    state().bridgeDone = true;
    state().updated.notify_all();
    return;
  }
  do {
    std::string failure;
    sd_bus_message* reply = nullptr;
    sd_bus_error error = SD_BUS_ERROR_NULL;
    r = sd_bus_call_method(bus, "org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus",
                           "GetNameOwner", &error, &reply, "s", "org.kde.KWin");
    const char* owner = nullptr;
    if (r < 0 || sd_bus_message_read(reply, "s", &owner) < 0 || !owner) {
      sd_bus_error_free(&error);
      sd_bus_message_unref(reply);
      fail("KWin is not running on the session bus (not a KDE Plasma session)");
      break;
    }
    {
      std::lock_guard<std::mutex> lock(state().mutex);
      state().kwinOwner = owner;
    }
    sd_bus_message_unref(reply);
    reply = nullptr;

    const char* unique = nullptr;
    if (sd_bus_get_unique_name(bus, &unique) < 0 || !unique) {
      fail("no unique bus name");
      break;
    }
    r = sd_bus_add_object_vtable(bus, &slot, kObjectPath, kInterface, kVtable, nullptr);
    if (r < 0) {
      fail("cannot export the bridge object (errno " + std::to_string(-r) + ")");
      break;
    }

    std::string script = kScriptTemplate;
    script.replace(script.find("%SERVICE%"), 9, unique);
    {
      std::ofstream out(scriptPath, std::ios::trunc);
      out << script;
      if (!out) {
        fail("cannot write " + scriptPath);
        break;
      }
    }

    // A previous core that crashed may have left its script loaded.
    callKWin(bus, "/Scripting", "org.kde.kwin.Scripting", "unloadScript", nullptr, failure, "s", pluginName.c_str());
    if (!callKWin(bus, "/Scripting", "org.kde.kwin.Scripting", "loadScript", &reply, failure, "ss",
                  scriptPath.c_str(), pluginName.c_str())) {
      fail("loadScript failed: " + failure);
      break;
    }
    int32_t id = -1;
    sd_bus_message_read(reply, "i", &id);
    sd_bus_message_unref(reply);
    reply = nullptr;
    if (id < 0) {
      fail("KWin refused the script (loadScript returned " + std::to_string(id) + ")");
      break;
    }
    loaded = true;
    const std::string objectPath = "/Scripting/Script" + std::to_string(id);
    if (!callKWin(bus, objectPath.c_str(), "org.kde.kwin.Script", "run", nullptr, failure) &&
        !callKWin(bus, "/Scripting", "org.kde.kwin.Scripting", "start", nullptr, failure)) {
      fail("running the script failed: " + failure);
      break;
    }
    logFormat("[kwin] window bridge script %s loaded (id %d, service %s)", pluginName.c_str(), id, unique);

    while (gRun.load()) {
      r = sd_bus_process(bus, nullptr);
      if (r < 0) {
        logFormat("[kwin] session bus failed (errno %d)", -r);
        break;
      }
      if (r > 0)
        continue;
      sd_bus_wait(bus, 200 * 1000);
    }
  } while (false);

  if (loaded) {
    std::string failure;
    callKWin(bus, "/Scripting", "org.kde.kwin.Scripting", "unloadScript", nullptr, failure, "s", pluginName.c_str());
  }
  std::remove(scriptPath.c_str());
  sd_bus_slot_unref(slot);
  sd_bus_flush_close_unref(bus);
  {
    std::lock_guard<std::mutex> lock(state().mutex);
    state().available = false;
    state().bridgeDone = true;
    state().windows.clear();
    state().outputs.clear();
    state().foregroundPid = 0;
  }
  state().updated.notify_all();
}

} // namespace

void startWindowSystem()
{
  if (gRun.exchange(true))
    return;
  const char* runtime = std::getenv("XDG_RUNTIME_DIR");
  const std::string dir = runtime && *runtime ? runtime : "/tmp";
  // Fixed plugin name: a crashed core's script (still loaded in KWin and
  // calling a dead bus name) is unloaded by the next core's start.
  const std::string pluginName = "shard-window-bridge";
  const std::string scriptPath = dir + "/" + pluginName + "-" + std::to_string(getpid()) + ".js";
  if (gThread.joinable())
    gThread.join();
  auto& s = state();
  {
    std::lock_guard<std::mutex> lock(s.mutex);
    s.bridgeDone = false;
  }
  gThread = std::thread(bridgeThread, pluginName, scriptPath);

  // Give the first report a moment so detection starts with real windows.
  std::unique_lock<std::mutex> lock(s.mutex);
  s.updated.wait_for(lock, std::chrono::seconds(3), [&] { return s.available || s.bridgeDone; });
}

void stopWindowSystem()
{
  gRun.store(false);
  if (gThread.joinable())
    gThread.join();
}

bool windowInfoAvailable()
{
  std::lock_guard<std::mutex> lock(state().mutex);
  return state().available;
}

std::vector<TopLevelWindow> listWindows(uint32_t pid)
{
  auto& s = state();
  std::lock_guard<std::mutex> lock(s.mutex);
  std::vector<TopLevelWindow> out;
  for (const auto& record : s.windows)
    if (!pid || record.window.pid == pid)
      out.push_back(record.window);
  return out;
}

std::vector<uint32_t> visibleWindowPids()
{
  auto& s = state();
  std::lock_guard<std::mutex> lock(s.mutex);
  std::vector<uint32_t> out;
  for (const auto& record : s.windows)
    if (record.window.pid && !record.window.minimized &&
        std::find(out.begin(), out.end(), record.window.pid) == out.end())
      out.push_back(record.window.pid);
  return out;
}

uint32_t foregroundPid()
{
  std::lock_guard<std::mutex> lock(state().mutex);
  return state().foregroundPid;
}

bool queryWindow(uintptr_t handle, TopLevelWindow& out)
{
  auto& s = state();
  std::lock_guard<std::mutex> lock(s.mutex);
  for (const auto& record : s.windows) {
    if (record.window.handle == handle) {
      out = record.window;
      return true;
    }
  }
  return false;
}

namespace kwin {

std::vector<Output> outputs()
{
  std::lock_guard<std::mutex> lock(state().mutex);
  return state().outputs;
}

} // namespace kwin

} // namespace shard::platform
