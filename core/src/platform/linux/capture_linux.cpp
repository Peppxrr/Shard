// Linux (Wayland) capture backend (platform/capture_backend.h).
//
//   desktop  pipewire-desktop-capture-source (monitor-only xdg-desktop-portal
//            ScreenCast). The portal shows a picker the first time; its restore token is
//            persisted in <configDir>/linux-capture.json and passed back on
//            create, so later sessions and source rebuilds start silently.
//   window   A new reference to the desktop screencast (Wayland offers no
//            silent per-window capture). The scene item is cropped to the
//            target window using KWin's geometry when known and not
//            fullscreen.
//   hook     vkcapture-source (obs-vkcapture) when the plugin is staged. Games
//            opt in with OBS_VKCAPTURE=1 (Steam: `OBS_VKCAPTURE=1 %command%`);
//            the Vulkan layer is registered per user at first use.
//   audio    pulse_output_capture / pulse_input_capture (PipeWire's Pulse
//            server); per-application capture is not supported.
//   events   logind PrepareForSleep(false) on the system bus -> onResume.
#include "platform/capture_backend.h"

#include "capture_resilience.h"
#include "log.h"
#include "platform/linux/glib_thread.h"
#include "platform/linux/kwin_outputs.h"
#include "platform/platform.h"
#include "platform/window_system.h"

#include <obs-module.h>
#include <systemd/sd-bus.h>

#include <signal.h>
#include <unistd.h>

#include <algorithm>
#include <atomic>
#include <cctype>
#include <cerrno>
#include <climits>
#include <chrono>
#include <cmath>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <iterator>
#include <memory>
#include <mutex>
#include <sstream>
#include <thread>
#include <tuple>
#include <unordered_map>
#include <vector>

namespace shard::capture {

namespace fs = std::filesystem;

namespace {

// Monitor-only portal capture: its picker offers screens only, and screen
// restore tokens restore reliably. A window picked in the combined picker of
// pipewire-screen-capture-source can never be restored ("Could not find
// window id"). OBS registers it flagged obsolete; the combined type is the
// fallback when it is missing.
constexpr const char* kDesktopSourceId = "pipewire-desktop-capture-source";
constexpr const char* kCombinedDesktopSourceId = "pipewire-screen-capture-source";
constexpr const char* kHookSourceId = "vkcapture-source";
// vkcapture "window" value that matches no client: a desktop subject must
// not pick up whichever Vulkan game connected last.
constexpr const char* kNoHookClient = "\x01shard-no-client";

std::string lower(std::string value)
{
  std::transform(value.begin(), value.end(), value.begin(),
                 [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
  return value;
}

bool sourceTypeRegistered(const char* id)
{
  const char* type = nullptr;
  for (size_t i = 0; obs_enum_input_types(i, &type); i++)
    if (type && std::strcmp(type, id) == 0)
      return true;
  return false;
}

// ------------------------------------------------------- restore token ---

struct DesktopState {
  std::string restoreToken;
  int monitor = -1; // config.capture.monitor the token was granted for
};

fs::path desktopStatePath(const Config& config)
{
  return fs::path(config.configDir) / "linux-capture.json";
}

DesktopState loadDesktopState(const Config& config)
{
  DesktopState state;
  std::ifstream in(desktopStatePath(config));
  if (!in)
    return state;
  try {
    const auto json = nlohmann::json::parse(in);
    state.restoreToken = json.value("restoreToken", "");
    state.monitor = json.value("monitor", -1);
  } catch (const std::exception& e) {
    logFormat("[capture] ignoring unreadable %s: %s", desktopStatePath(config).string().c_str(), e.what());
  }
  return state;
}

std::mutex gDesktopStateMutex;
DesktopState gPersisted;
bool gPersistedLoaded = false;

obs_data_t* desktopSettings(const Config& config)
{
  std::lock_guard<std::mutex> lock(gDesktopStateMutex);
  if (!gPersistedLoaded) {
    gPersisted = loadDesktopState(config);
    gPersistedLoaded = true;
  }
  obs_data_t* s = obs_data_create();
  obs_data_set_bool(s, "ShowCursor", true);
  // A token restores the screen chosen before; when the configured monitor
  // changed the user has to pick again.
  if (!gPersisted.restoreToken.empty() && gPersisted.monitor == config.capture.monitor)
    obs_data_set_string(s, "RestoreToken", gPersisted.restoreToken.c_str());
  return s;
}

// ------------------------------------------------------ vkcapture layer ---

std::string fileContent(const fs::path& path)
{
  std::ifstream in(path, std::ios::binary);
  return in ? std::string(std::istreambuf_iterator<char>(in), std::istreambuf_iterator<char>()) : std::string();
}

bool writeIfChanged(const fs::path& path, const std::string& content, std::error_code& ec)
{
  if (fs::exists(path, ec) && fileContent(path) == content)
    return true;
  const fs::path temp = path.string() + ".tmp";
  {
    std::ofstream out(temp, std::ios::binary | std::ios::trunc);
    out << content;
    if (!out)
      return false;
  }
  fs::rename(temp, path, ec);
  return !ec;
}

// Vulkan loaders find implicit layers in ~/.local/share/vulkan; Steam's
// pressure-vessel container imports them too. The layer library is copied to
// a stable per-user path because the staged runtime may live on a per-launch
// mount (AppImage). The layer stays dormant unless OBS_VKCAPTURE=1.
void registerVulkanLayer()
{
  char self[PATH_MAX];
  const ssize_t n = readlink("/proc/self/exe", self, sizeof(self) - 1);
  if (n <= 0)
    return;
  const fs::path staged = fs::path(std::string(self, static_cast<size_t>(n))).parent_path() / "vkcapture";
  const fs::path layerLib = staged / "libVkLayer_obs_vkcapture.so";
  std::error_code ec;
  if (!fs::exists(layerLib, ec)) {
    logFormat("[capture] vkcapture layer not staged (%s); Vulkan game capture needs a system obs-vkcapture",
              layerLib.string().c_str());
    return;
  }
  for (const char* dir : {"/usr/share/vulkan/implicit_layer.d", "/etc/vulkan/implicit_layer.d"}) {
    const fs::path manifest = fs::path(dir) / "obs_vkcapture_64.json";
    if (fs::exists(manifest, ec)) {
      logFormat("[capture] using the system obs-vkcapture layer (%s)", manifest.string().c_str());
      logFormat("[capture] Vulkan/Proton games need the Steam launch option `OBS_VKCAPTURE=1 %%command%%`");
      return;
    }
  }

  const char* homeEnv = std::getenv("HOME");
  if (!homeEnv || !*homeEnv)
    return;
  const char* dataEnv = std::getenv("XDG_DATA_HOME");
  const fs::path dataHome = dataEnv && *dataEnv ? fs::path(dataEnv) : fs::path(homeEnv) / ".local" / "share";
  const fs::path libDir = dataHome / "shard" / "vkcapture";
  const fs::path manifestDir = dataHome / "vulkan" / "implicit_layer.d";
  fs::create_directories(libDir, ec);
  fs::create_directories(manifestDir, ec);
  for (const char* name : {"libVkLayer_obs_vkcapture.so", "libobs_glcapture.so"}) {
    const fs::path source = staged / name;
    if (!fs::exists(source, ec))
      continue;
    if (!writeIfChanged(libDir / name, fileContent(source), ec)) {
      logFormat("[capture] cannot install %s into %s", name, libDir.string().c_str());
      return;
    }
  }

  // Upstream src/obs_vkcapture.json.in (v1.5.6) with the per-user library path.
  const nlohmann::json manifest = {
      {"file_format_version", "1.1.2"},
      {"layer",
       {{"name", "VK_LAYER_OBS_vkcapture_64"},
        {"type", "GLOBAL"},
        {"library_path", (libDir / "libVkLayer_obs_vkcapture.so").string()},
        {"api_version", "1.3.221"},
        {"implementation_version", "1"},
        {"description", "OBS Linux game capture"},
        {"functions", {{"vkNegotiateLoaderLayerInterfaceVersion", "OBS_Negotiate"}}},
        {"enable_environment", {{"OBS_VKCAPTURE", "1"}}},
        {"disable_environment", {{"DISABLE_OBS_VKCAPTURE", "1"}}}}},
  };
  const fs::path manifestPath = manifestDir / "shard_obs_vkcapture_64.json";
  if (!writeIfChanged(manifestPath, manifest.dump(2) + "\n", ec)) {
    logFormat("[capture] cannot write %s", manifestPath.string().c_str());
    return;
  }
  logFormat("[capture] vkcapture Vulkan layer registered (%s)", manifestPath.string().c_str());
  logFormat("[capture] Vulkan/Proton games need the Steam launch option `OBS_VKCAPTURE=1 %%command%%`");
}

// Case-insensitive match of subject.exe among the connected vkcapture
// clients (the layer reports the original-case image name, e.g.
// "VRChat.exe"). Empty when none matches: "" = newest connected client.
std::string hookClientFor(obs_source_t* hook, const CaptureSubject& subject)
{
  if (subject.kind != CaptureSubject::Kind::Window)
    return kNoHookClient;
  std::string match;
  obs_properties_t* props = obs_source_properties(hook);
  if (obs_property_t* list = props ? obs_properties_get(props, "window") : nullptr) {
    const size_t count = obs_property_list_item_count(list);
    for (size_t i = 0; i < count && match.empty(); i++) {
      const char* client = obs_property_list_item_string(list, i);
      if (client && *client && lower(client) == subject.exe)
        match = client;
    }
  }
  obs_properties_destroy(props);
  return match;
}

// ---------------------------------------------------------------- outputs --

// KWin outputs in listMonitors() order (desktop position, then name).
std::vector<platform::kwin::Output> sortedOutputs()
{
  auto outputs = platform::kwin::outputs();
  std::sort(outputs.begin(), outputs.end(), [](const auto& a, const auto& b) {
    return std::tie(a.x, a.y, a.name) < std::tie(b.x, b.y, b.name);
  });
  return outputs;
}

int outputIndexAt(const std::vector<platform::kwin::Output>& outputs, int x, int y)
{
  for (size_t i = 0; i < outputs.size(); i++) {
    const auto& o = outputs[i];
    if (x >= o.x && x < o.x + o.width && y >= o.y && y < o.y + o.height)
      return static_cast<int>(i);
  }
  return -1;
}

// ------------------------------------------------------------------ audio --

void appendPulseDevices(nlohmann::json& out, const char* sourceId, bool isInput)
{
  obs_properties_t* props = obs_get_source_properties(sourceId);
  if (!props)
    return;
  if (obs_property_t* list = obs_properties_get(props, "device_id")) {
    const size_t count = obs_property_list_item_count(list);
    for (size_t i = 0; i < count; i++) {
      const char* id = obs_property_list_item_string(list, i);
      const char* name = obs_property_list_item_name(list, i);
      if (!id || !*id || std::strcmp(id, "default") == 0)
        continue;
      out.push_back({{"id", id}, {"name", name && *name ? name : id}, {"isInput", isInput}, {"isVoicemeeter", false}});
    }
  }
  obs_properties_destroy(props);
}

} // namespace

const MethodNames& methodNames()
{
  static const MethodNames names{"pipewire_desktop", "pipewire_desktop_window", "vkcapture", "window capture"};
  return names;
}

// ---------------------------------------------------------------- sources --

// Monitor index (listMonitors()/KWin output order) the screencast was
// requested for; window crops apply only to windows on that output.
static std::atomic<int> gStreamMonitor{-1};

obs_source_t* createDesktopSource(const Config& config)
{
  const char* id = sourceTypeRegistered(kDesktopSourceId) ? kDesktopSourceId : kCombinedDesktopSourceId;
  obs_data_t* s = desktopSettings(config);
  obs_source_t* source = obs_source_create(id, "desktop-capture", s, nullptr);
  obs_data_release(s);
  if (!source)
    logFormat("[capture] %s unavailable (xdg-desktop-portal ScreenCast missing?)", id);
  gStreamMonitor.store(source ? config.capture.monitor : -1);
  return source;
}

// The portal session cannot be restarted through settings (update only reads
// ShowCursor), and writing the settings here would race linux-pipewire's
// portal callback saving the restore token. SourceManager's rebuild path
// recreates the source, restoring silently with the persisted token.
void retryDesktopSource(obs_source_t*, const Config&) {}

void persistDesktopState(obs_source_t* desktop, const Config& config)
{
  if (!desktop)
    return;
  // linux-pipewire writes "RestoreToken" (obs_source_save) from its portal
  // callback on the GLib main-loop thread; obs_data is unsynchronized, so
  // read it on that thread too.
  auto token = std::make_shared<std::string>();
  obs_source_t* ref = obs_source_get_ref(desktop);
  if (!ref)
    return;
  const bool read = platform::glib::invokeSync([ref, token] {
    obs_data_t* settings = obs_source_get_settings(ref);
    if (settings)
      *token = obs_data_get_string(settings, "RestoreToken");
    obs_data_release(settings);
    obs_source_release(ref);
  });
  if (!read || token->empty())
    return;

  std::lock_guard<std::mutex> lock(gDesktopStateMutex);
  if (gPersistedLoaded && *token == gPersisted.restoreToken && gPersisted.monitor == config.capture.monitor)
    return;
  gPersisted = {*token, config.capture.monitor};
  gPersistedLoaded = true;
  const nlohmann::json json = {{"restoreToken", *token}, {"monitor", config.capture.monitor}};
  const fs::path path = desktopStatePath(config);
  std::error_code ec;
  if (!writeIfChanged(path, json.dump(2) + "\n", ec))
    logFormat("[capture] cannot persist the screencast restore token to %s", path.string().c_str());
  else
    logFormat("[capture] screencast restore token saved");
}

obs_source_t* createHookSource()
{
  if (!sourceTypeRegistered(kHookSourceId))
    return nullptr;
  static std::once_flag layerOnce;
  std::call_once(layerOnce, registerVulkanLayer);
  // vkcapture's cursor setup/teardown round-trips on libobs' shared Wayland
  // display. Let any released hook finish its deferred destroy (OBS destroy
  // task thread, FIFO) first: concurrent dispatch from both threads corrupted
  // libwayland's proxy map (SIGSEGV in wl_cursor_init during recreation).
  obs_queue_task(OBS_TASK_DESTROY, [](void*) {}, nullptr, true);
  obs_data_t* s = obs_data_create();
  obs_data_set_string(s, "window", kNoHookClient);
  obs_data_set_bool(s, "show_cursor", true);
  obs_data_set_bool(s, "allow_transparency", false);
  obs_source_t* source = obs_source_create(kHookSourceId, "game-capture", s, nullptr);
  obs_data_release(s);
  return source;
}

obs_source_t* createWindowSource(obs_source_t* desktop)
{
  return desktop ? obs_source_get_ref(desktop) : nullptr;
}

void targetGameSources(obs_source_t*, obs_source_t* hook, const CaptureSubject& subject)
{
  // The window source is the desktop screencast; only its crop follows the
  // subject (windowSceneCrop).
  if (!hook)
    return;
  obs_data_t* d = obs_data_create();
  obs_data_set_string(d, "window", hookClientFor(hook, subject).c_str());
  obs_source_update(hook, d);
  obs_data_release(d);
}

void retryWindowSource(obs_source_t*, const CaptureSubject&) {}

std::string retryHookSource(obs_source_t* hook, const CaptureSubject& subject)
{
  const std::string client = hookClientFor(hook, subject);
  obs_data_t* d = obs_data_create();
  obs_data_set_string(d, "window", client.c_str());
  obs_source_update(hook, d);
  obs_data_release(d);
  return client == kNoHookClient ? std::string("none") : client.empty() ? std::string("newest") : client;
}

bool windowSourceIsIndependent()
{
  return false;
}

bool hookRecreationResets()
{
  // Games connect to the plugin's socket, not to one source instance.
  return false;
}

std::string hookUnavailableReason(uint32_t pid)
{
  // The vkcapture layer (Vulkan, incl. DXVK/VKD3D under Proton) or the
  // OpenGL capture library is mapped into a game started with
  // OBS_VKCAPTURE=1 (or obs-gamecapture). The layer loads when the game
  // creates its Vulkan instance, so "not loaded" is re-checked every 5 s
  // while "loaded" is final for that process.
  struct Entry {
    bool loaded = false;
    std::chrono::steady_clock::time_point checked;
  };
  static std::mutex mutex;
  static std::unordered_map<uint32_t, Entry> cache;
  if (!pid)
    return {};
  const auto now = std::chrono::steady_clock::now();
  std::lock_guard<std::mutex> lock(mutex);
  auto it = cache.find(pid);
  if (it != cache.end() && (it->second.loaded || now - it->second.checked < std::chrono::seconds(5)))
    return it->second.loaded ? std::string() : std::string("vkcapture_not_enabled");

  std::ifstream maps("/proc/" + std::to_string(pid) + "/maps");
  if (!maps)
    return {}; // exited or not ours: no claim about the cause
  bool loaded = false;
  for (std::string line; !loaded && std::getline(maps, line);)
    loaded = line.find("libVkLayer_obs_vkcapture.so") != std::string::npos ||
             line.find("libobs_glcapture.so") != std::string::npos;
  // Drop entries of processes that are gone so pid reuse cannot inherit them.
  for (auto e = cache.begin(); e != cache.end();)
    e = processAlive(e->first) ? std::next(e) : cache.erase(e);
  cache[pid] = {loaded, now};
  return loaded ? std::string() : std::string("vkcapture_not_enabled");
}

// ---------------------------------------------------------------- targets --

uintptr_t findSubjectWindow(const CaptureSubject& subject)
{
  uintptr_t best = 0;
  int bestScore = -1;
  long bestArea = -1;
  if (!subject.pid)
    return 0;
  for (const auto& w : platform::listWindows(subject.pid)) {
    int score = 0;
    if (!subject.cls.empty() && w.cls == subject.cls)
      score += 2;
    if (!subject.title.empty() && w.title == subject.title)
      score += 1;
    if (score > bestScore || (score == bestScore && w.area > bestArea)) {
      best = w.handle;
      bestScore = score;
      bestArea = w.area;
    }
  }
  return best;
}

bool windowMinimized(uintptr_t window)
{
  platform::TopLevelWindow w;
  return window && platform::queryWindow(window, w) && w.minimized;
}

bool windowLiveForPid(uintptr_t window, uint32_t pid)
{
  platform::TopLevelWindow w;
  return window && platform::queryWindow(window, w) && w.pid == pid;
}

std::optional<WindowIdentity> windowIdentity(uintptr_t window)
{
  platform::TopLevelWindow w;
  if (!window || !platform::queryWindow(window, w))
    return std::nullopt;
  return WindowIdentity{w.title, w.cls};
}

std::optional<CaptureSize> windowClientSize(uintptr_t window)
{
  platform::TopLevelWindow w;
  if (!window || !platform::queryWindow(window, w) || w.width <= 0 || w.height <= 0)
    return std::nullopt;
  const auto outputs = sortedOutputs();
  const int index = outputIndexAt(outputs, w.x + w.width / 2, w.y + w.height / 2);
  const double scale = index >= 0 ? outputs[index].scale : 1.0;
  return CaptureSize{static_cast<uint32_t>(std::lround(w.width * scale)),
                     static_cast<uint32_t>(std::lround(w.height * scale))};
}

// The window source is the desktop screencast of one output. Crop it to the
// window's client rectangle when the window sits on the output the stream was
// requested for, that output's physical size matches the stream (the screen
// picked in the portal), and the window is not fullscreen; scale = stream
// pixels per KWin logical pixel.
WindowSceneCrop windowSceneCrop(uintptr_t window, uint32_t sourceWidth, uint32_t sourceHeight)
{
  WindowSceneCrop result;
  platform::TopLevelWindow w;
  if (!window || !sourceWidth || !sourceHeight || !platform::queryWindow(window, w) || w.minimized ||
      w.fullscreen || w.width <= 0 || w.height <= 0)
    return result;
  const auto outputs = sortedOutputs();
  const int index = outputIndexAt(outputs, w.x + w.width / 2, w.y + w.height / 2);
  // Identical monitors share a shape; only the requested output qualifies.
  if (index < 0 || index != gStreamMonitor.load())
    return result;
  const auto& o = outputs[index];
  if (o.width <= 0 || o.height <= 0)
    return result;
  const double scaleX = static_cast<double>(sourceWidth) / o.width;
  const double scaleY = static_cast<double>(sourceHeight) / o.height;
  // A stream of another output (or a window picked in the portal) has a
  // different shape; keep the uncropped surface then.
  if (std::abs(scaleX - o.scale) > 0.02 || std::abs(scaleY - o.scale) > 0.02)
    return result;

  const auto clampPx = [](double value, uint32_t limit) {
    return static_cast<int64_t>(std::clamp<double>(std::lround(value), 0.0, static_cast<double>(limit)));
  };
  const int64_t left = clampPx((w.x - o.x) * scaleX, sourceWidth);
  const int64_t top = clampPx((w.y - o.y) * scaleY, sourceHeight);
  const int64_t right = clampPx((w.x - o.x + w.width) * scaleX, sourceWidth);
  const int64_t bottom = clampPx((w.y - o.y + w.height) * scaleY, sourceHeight);
  const CaptureSize visible{static_cast<uint32_t>(std::max<int64_t>(0, right - left)),
                            static_cast<uint32_t>(std::max<int64_t>(0, bottom - top))};
  if (!visible.valid())
    return result;
  result.valid = true;
  result.left = static_cast<uint32_t>(left);
  result.top = static_cast<uint32_t>(top);
  result.right = sourceWidth - static_cast<uint32_t>(right);
  result.bottom = sourceHeight - static_cast<uint32_t>(bottom);
  result.clientSize = visible;
  return result;
}

// The window source aliases the desktop screencast and never acquires a
// window of its own.
std::optional<uintptr_t> acquiredWindow(obs_source_t*, uint32_t)
{
  return std::nullopt;
}

// Display identity = 1 + index in listMonitors() order; 0 when unknown.
uintptr_t displayForTarget(bool windowSubject, uintptr_t window, int monitorIndex)
{
  return selectCaptureMonitor(
      windowSubject, window, monitorIndex,
      [](uintptr_t handle) -> uintptr_t {
        platform::TopLevelWindow w;
        if (!platform::queryWindow(handle, w))
          return 0;
        const int index = outputIndexAt(sortedOutputs(), w.x + w.width / 2, w.y + w.height / 2);
        return index >= 0 ? static_cast<uintptr_t>(index) + 1 : 0;
      },
      [](int index) -> uintptr_t { return index >= 0 ? static_cast<uintptr_t>(index) + 1 : 0; });
}

// HDR state of Wayland outputs is not exposed to clients; it stays unknown.
CaptureDisplayState queryCaptureDisplay(uintptr_t display)
{
  CaptureDisplayState result;
  result.monitor = display;
  if (!display)
    return result;
  const auto monitors = platform::listMonitors();
  if (display <= monitors.size()) {
    const auto& m = monitors[display - 1];
    result.name = m.id.empty() ? m.name : m.id;
  }
  return result;
}

// A zombie has exited (only its exit status remains), like a signaled
// process handle on Windows. kill() still succeeds for it.
bool processAlive(uint32_t pid)
{
  if (pid == 0 || (kill(static_cast<pid_t>(pid), 0) != 0 && errno != EPERM))
    return false;
  std::ifstream stat("/proc/" + std::to_string(pid) + "/stat");
  std::string text((std::istreambuf_iterator<char>(stat)), std::istreambuf_iterator<char>());
  const size_t close = text.rfind(')');
  // "pid (comm) S ...": the state follows the last ')'.
  return close == std::string::npos || close + 2 >= text.size() || (text[close + 2] != 'Z' && text[close + 2] != 'X');
}

// ------------------------------------------------------- system events ---

struct SystemEventSubscription::Impl {
  CaptureRecoveryState* state = nullptr;
  std::atomic<bool> run{true};
  std::thread thread;
};

namespace {

int onPrepareForSleep(sd_bus_message* message, void* userdata, sd_bus_error*)
{
  int sleeping = 0;
  if (sd_bus_message_read(message, "b", &sleeping) >= 0 && !sleeping) {
    logFormat("[capture] system resumed from sleep");
    static_cast<CaptureRecoveryState*>(userdata)->onResume();
  }
  return 0;
}

} // namespace

SystemEventSubscription::SystemEventSubscription(CaptureRecoveryState& state) : impl_(std::make_unique<Impl>())
{
  impl_->state = &state;
  Impl* impl = impl_.get();
  impl_->thread = std::thread([impl] {
    sd_bus* bus = nullptr;
    sd_bus_slot* slot = nullptr;
    int r = sd_bus_open_system(&bus);
    if (r >= 0)
      r = sd_bus_match_signal(bus, &slot, "org.freedesktop.login1", "/org/freedesktop/login1",
                              "org.freedesktop.login1.Manager", "PrepareForSleep", onPrepareForSleep, impl->state);
    if (r < 0) {
      logFormat("[capture] resume notifications unavailable (logind, errno %d)", -r);
    } else {
      while (impl->run.load()) {
        r = sd_bus_process(bus, nullptr);
        if (r < 0)
          break;
        if (r == 0)
          sd_bus_wait(bus, 250 * 1000);
      }
    }
    sd_bus_slot_unref(slot);
    sd_bus_flush_close_unref(bus);
  });
}

SystemEventSubscription::~SystemEventSubscription()
{
  impl_->run.store(false);
  if (impl_->thread.joinable())
    impl_->thread.join();
}

// ------------------------------------------------------------------ audio --

nlohmann::json listAudioDevices()
{
  nlohmann::json out = nlohmann::json::array();
  appendPulseDevices(out, "pulse_output_capture", false);
  appendPulseDevices(out, "pulse_input_capture", true);
  return out;
}

obs_source_t* createAudioDeviceSource(bool input, const std::string& deviceId, const std::string& name)
{
  obs_data_t* s = obs_data_create();
  obs_data_set_string(s, "device_id", deviceId.empty() ? "default" : deviceId.c_str());
  obs_source_t* src = obs_source_create(input ? "pulse_input_capture" : "pulse_output_capture", name.c_str(), s, nullptr);
  obs_data_release(s);
  return src;
}

obs_source_t* createAppAudioSource(const std::string&, const std::string&)
{
  return nullptr;
}

} // namespace shard::capture
