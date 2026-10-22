// Linux (Wayland-only) process and libobs boundary.
//
// libobs-opengl renders through EGL on the compositor's wl_display. The
// staged OBS plugins are loaded explicitly from <coreBin>/obs-plugins/64bit:
// obs_load_all_modules would also scan the system OBS plugin directories and
// mix an installed OBS's modules into the core.
//
// linux-pipewire talks to xdg-desktop-portal through GDBus asynchronous
// calls whose replies are dispatched on the GLib default main context. The
// OBS frontend iterates it from Qt; the headless core runs a GLib main loop
// thread for the lifetime of libobs instead.
#include "platform/platform.h"

#include "log.h"
#include "platform/linux/glib_thread.h"

#include <glib.h>
#include <obs-module.h>
#include <obs-nix-platform.h>
#include <wayland-client.h>

#include <dirent.h>
#include <signal.h>
#include <sys/prctl.h>
#include <sys/resource.h>
#include <unistd.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cerrno>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <deque>
#include <filesystem>
#include <functional>
#include <fstream>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <tuple>
#include <vector>

namespace shard {

namespace fs = std::filesystem;

namespace {

std::atomic<bool> gTerminationRequested{false};

void onTerminationSignal(int)
{
  gTerminationRequested.store(true);
}

wl_display* gDisplay = nullptr;
GMainLoop* gGlibLoop = nullptr;
std::thread gGlibThread;

std::string readTrimmed(const fs::path& path)
{
  std::ifstream in(path);
  std::string value;
  std::getline(in, value);
  while (!value.empty() && (value.back() == '\n' || value.back() == ' '))
    value.pop_back();
  return value;
}

uint32_t readHex(const fs::path& path)
{
  const std::string text = readTrimmed(path);
  return text.empty() ? 0 : static_cast<uint32_t>(std::strtoul(text.c_str(), nullptr, 16));
}

// "Intel Corporation Meteor Lake-P [Intel Arc Graphics]" from the system PCI
// id database (hwdata); empty when unavailable.
std::string pciName(uint32_t vendor, uint32_t device)
{
  for (const char* file : {"/usr/share/hwdata/pci.ids", "/usr/share/misc/pci.ids"}) {
    std::ifstream in(file);
    if (!in)
      continue;
    char vendorKey[8], deviceKey[8];
    std::snprintf(vendorKey, sizeof(vendorKey), "%04x  ", vendor);
    std::snprintf(deviceKey, sizeof(deviceKey), "\t%04x  ", device);
    std::string line, vendorName;
    while (std::getline(in, line)) {
      if (vendorName.empty()) {
        if (line.rfind(vendorKey, 0) == 0)
          vendorName = line.substr(6);
        continue;
      }
      if (!line.empty() && line[0] != '\t' && line[0] != '#')
        break; // next vendor: device not listed
      if (line.rfind(deviceKey, 0) == 0)
        return vendorName + " " + line.substr(7);
    }
    return vendorName;
  }
  return {};
}

// ------------------------------------------------------------- outputs ----

struct OutputState {
  uint32_t globalName = 0;
  wl_output* output = nullptr;
  std::string name;
  std::string description;
  std::string make, model;
  int32_t x = 0, y = 0;
  int32_t width = 0, height = 0; // current mode, physical pixels
};

void outputGeometry(void* data, wl_output*, int32_t x, int32_t y, int32_t, int32_t, int32_t, const char* make,
                    const char* model, int32_t)
{
  auto* state = static_cast<OutputState*>(data);
  state->x = x;
  state->y = y;
  state->make = make ? make : "";
  state->model = model ? model : "";
}

void outputMode(void* data, wl_output*, uint32_t flags, int32_t width, int32_t height, int32_t)
{
  if (flags & WL_OUTPUT_MODE_CURRENT) {
    auto* state = static_cast<OutputState*>(data);
    state->width = width;
    state->height = height;
  }
}

void outputDone(void*, wl_output*) {}
void outputScale(void*, wl_output*, int32_t) {}

void outputName(void* data, wl_output*, const char* name)
{
  static_cast<OutputState*>(data)->name = name ? name : "";
}

void outputDescription(void* data, wl_output*, const char* description)
{
  static_cast<OutputState*>(data)->description = description ? description : "";
}

const wl_output_listener kOutputListener = {outputGeometry, outputMode,  outputDone,
                                            outputScale,    outputName, outputDescription};

void registryGlobal(void* data, wl_registry* registry, uint32_t name, const char* interface, uint32_t version)
{
  if (std::strcmp(interface, wl_output_interface.name) != 0)
    return;
  auto* outputs = static_cast<std::deque<OutputState>*>(data);
  OutputState state;
  state.globalName = name;
  state.output = static_cast<wl_output*>(wl_registry_bind(registry, name, &wl_output_interface, std::min(version, 4u)));
  outputs->push_back(std::move(state));
}

void registryGlobalRemove(void*, wl_registry*, uint32_t) {}

const wl_registry_listener kRegistryListener = {registryGlobal, registryGlobalRemove};

} // namespace

namespace platform {
namespace glib {

bool invokeSync(std::function<void()> fn)
{
  struct Call {
    std::function<void()> fn;
    std::mutex mutex;
    std::condition_variable done;
    bool finished = false;
  };
  auto* call = new std::shared_ptr<Call>(std::make_shared<Call>());
  std::shared_ptr<Call> state = *call;
  state->fn = std::move(fn);
  // Runs right here when no thread owns the default context; otherwise it
  // is queued for the loop thread. The heap shared_ptr keeps the state alive
  // for a call that only runs after this function gave up waiting.
  g_main_context_invoke(
      nullptr,
      [](gpointer data) -> gboolean {
        auto* holder = static_cast<std::shared_ptr<Call>*>(data);
        std::shared_ptr<Call> c = *holder;
        delete holder;
        c->fn();
        std::lock_guard<std::mutex> lock(c->mutex);
        c->finished = true;
        c->done.notify_all();
        return G_SOURCE_REMOVE;
      },
      call);
  std::unique_lock<std::mutex> lock(state->mutex);
  return state->done.wait_for(lock, std::chrono::seconds(2), [&] { return state->finished; });
}

} // namespace glib

std::optional<int> runPreCoreEntry(int, char**)
{
  return std::nullopt;
}

void initCoreProcess()
{
  // The core never outlives the app that started it.
  prctl(PR_SET_PDEATHSIG, SIGTERM);
  // A closed stdout/stderr pipe or WebSocket peer must surface as EPIPE.
  signal(SIGPIPE, SIG_IGN);
  struct sigaction action = {};
  action.sa_handler = onTerminationSignal;
  sigemptyset(&action.sa_mask);
  sigaction(SIGTERM, &action, nullptr);
  sigaction(SIGINT, &action, nullptr);
}

bool terminationRequested()
{
  return gTerminationRequested.load();
}

bool prepareObs(std::string& error)
{
  if (!gDisplay) {
    gDisplay = wl_display_connect(nullptr);
    if (!gDisplay) {
      const char* name = std::getenv("WAYLAND_DISPLAY");
      error = std::string("No Wayland session: could not connect to ") +
              (name && *name ? std::string("WAYLAND_DISPLAY=") + name : std::string("wayland-0 (WAYLAND_DISPLAY unset)")) +
              " (" + std::strerror(errno) + "). Shard on Linux requires a Wayland desktop session.";
      return false;
    }
  }
  obs_set_nix_platform(OBS_NIX_PLATFORM_WAYLAND);
  obs_set_nix_platform_display(gDisplay);

  if (!gGlibLoop) {
    gGlibLoop = g_main_loop_new(nullptr, FALSE);
    gGlibThread = std::thread([loop = gGlibLoop] { g_main_loop_run(loop); });
  }
  return true;
}

void releaseObs()
{
  if (gGlibLoop) {
    // A plain g_main_loop_quit before the thread entered g_main_loop_run
    // would be lost (run resets the running flag). An idle source on the
    // default context is dispatched whenever the loop runs, so it always
    // ends it.
    g_idle_add(
        [](gpointer loop) -> gboolean {
          g_main_loop_quit(static_cast<GMainLoop*>(loop));
          return G_SOURCE_REMOVE;
        },
        gGlibLoop);
    if (gGlibThread.joinable())
      gGlibThread.join();
    g_main_loop_unref(gGlibLoop);
    gGlibLoop = nullptr;
  }
  if (gDisplay) {
    wl_display_disconnect(gDisplay);
    gDisplay = nullptr;
  }
}

void loadObsModules(const std::string& coreBinDir)
{
  const fs::path binDir = fs::path(coreBinDir) / "obs-plugins" / "64bit";
  const fs::path dataRoot = fs::path(coreBinDir) / "data" / "obs-plugins";
  std::error_code ec;
  std::vector<fs::path> modules;
  for (const auto& entry : fs::directory_iterator(binDir, ec))
    if (entry.path().extension() == ".so" && entry.is_regular_file(ec))
      modules.push_back(entry.path());
  if (ec)
    logFormat("[obs] cannot list %s: %s", binDir.string().c_str(), ec.message().c_str());
  std::sort(modules.begin(), modules.end());

  int loaded = 0;
  for (const auto& path : modules) {
    const std::string name = path.stem().string();
    const std::string data = (dataRoot / name).string();
    obs_module_t* module = nullptr;
    const int opened = obs_open_module(&module, path.string().c_str(), data.c_str());
    if (opened != MODULE_SUCCESS) {
      logFormat("[obs] module %s failed to open (code %d)", name.c_str(), opened);
      continue;
    }
    if (!obs_init_module(module)) {
      logFormat("[obs] module %s failed to initialize", name.c_str());
      continue;
    }
    loaded++;
  }
  obs_post_load_modules();
  logFormat("[obs] loaded %d of %zu modules from %s", loaded, modules.size(), binDir.string().c_str());
}

const char* graphicsModule()
{
  return "libobs-opengl";
}

GraphicsAdapterInfo selectGraphicsAdapter()
{
  // EGL renders on the compositor's GPU, which is the boot VGA device on
  // hybrid laptops (KWin drives the panel from the integrated GPU). OBS's
  // OpenGL device has no adapter index; 0 is the only valid value.
  GraphicsAdapterInfo info;
  std::error_code ec;
  fs::path chosen;
  for (const auto& entry : fs::directory_iterator("/sys/class/drm", ec)) {
    const std::string node = entry.path().filename().string();
    const bool card = node.rfind("card", 0) == 0 && node.find('-') == std::string::npos;
    const bool render = node.rfind("renderD", 0) == 0;
    if (!card && !render)
      continue;
    const fs::path device = entry.path() / "device";
    if (!readHex(device / "vendor"))
      continue;
    if (readTrimmed(device / "boot_vga") == "1") {
      chosen = device;
      break;
    }
    if (chosen.empty() || (card && chosen.parent_path().filename().string().rfind("renderD", 0) == 0))
      chosen = device;
  }
  if (!chosen.empty()) {
    info.vendorId = readHex(chosen / "vendor");
    const uint32_t deviceId = readHex(chosen / "device");
    info.name = pciName(info.vendorId, deviceId);
    if (info.name.empty()) {
      char fallback[32];
      std::snprintf(fallback, sizeof(fallback), "%04x:%04x", info.vendorId, deviceId);
      info.name = fallback;
    }
  }
  logFormat("[obs] graphics adapter (EGL/Wayland): %s", info.name.empty() ? "unknown" : info.name.c_str());
  return info;
}

std::vector<MonitorInfo> listMonitors()
{
  std::vector<MonitorInfo> result;
  wl_display* display = wl_display_connect(nullptr);
  if (!display)
    return result;
  // deque: output listeners hold element addresses, and an output plugged in
  // during the second roundtrip still appends here.
  std::deque<OutputState> outputs;
  wl_registry* registry = wl_display_get_registry(display);
  wl_registry_add_listener(registry, &kRegistryListener, &outputs);
  wl_display_roundtrip(display); // globals
  for (auto& output : outputs)
    wl_output_add_listener(output.output, &kOutputListener, &output);
  wl_display_roundtrip(display); // output events
  // Wayland has no primary output and the registry order is not stable;
  // order by desktop position, then connector name. The output at the
  // desktop origin is treated as primary.
  std::sort(outputs.begin(), outputs.end(), [](const OutputState& a, const OutputState& b) {
    return std::tie(a.x, a.y, a.name) < std::tie(b.x, b.y, b.name);
  });
  bool primaryAssigned = false;
  for (size_t i = 0; i < outputs.size(); i++) {
    const auto& output = outputs[i];
    MonitorInfo info;
    info.index = static_cast<int>(i);
    info.id = output.name;
    info.name = !output.description.empty() ? output.description
              : !output.model.empty()        ? output.make + " " + output.model
                                             : output.name;
    info.width = output.width > 0 ? static_cast<uint32_t>(output.width) : 0;
    info.height = output.height > 0 ? static_cast<uint32_t>(output.height) : 0;
    info.primary = output.x == 0 && output.y == 0 && !primaryAssigned;
    primaryAssigned = primaryAssigned || info.primary;
    result.push_back(std::move(info));
  }
  if (!primaryAssigned && !result.empty())
    result.front().primary = true;
  for (auto& output : outputs)
    wl_output_destroy(output.output);
  wl_registry_destroy(registry);
  wl_display_disconnect(display);
  return result;
}

} // namespace platform

bool processElevated()
{
  return geteuid() == 0;
}

const char* processPriorityClassName()
{
  errno = 0;
  const int nice = getpriority(PRIO_PROCESS, 0);
  if (errno)
    return "unknown";
  if (nice <= -15)
    return "high";
  if (nice < 0)
    return "above_normal";
  if (nice == 0)
    return "normal";
  return nice < 10 ? "below_normal" : "idle";
}

std::optional<bool> hagsEnabled(uint64_t)
{
  return std::nullopt;
}

} // namespace shard
