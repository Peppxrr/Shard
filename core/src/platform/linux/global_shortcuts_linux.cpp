// Global shortcuts through KDE's kglobalaccel (inside KWin on Plasma 6).
//
// One thread owns a session-bus connection and makes every kglobalaccel
// call, so registration, the pressed signal and re-registration after a
// KWin/kglobalaccel restart (NameOwnerChanged) never race. Registered as
// component "com.shard.app" ("Shard"), one action per hotkey id; nothing is
// unregistered on exit (KDE keeps the entries, inert while Shard is closed).
//
// kglobalaccel demarshals every QKeySequence as a struct of exactly four
// int32 and aborts the compositor on anything else: keys are always sent as
// (ai) with four elements, flags as uint32, and only the methods below
// (doRegister(as), setShortcutKeys(as,a(ai),u) -> a(ai), unregister(ss) -> b)
// are called.
#include "platform/global_shortcuts.h"

#include "log.h"

#include <systemd/sd-bus.h>

#include <algorithm>
#include <atomic>
#include <cctype>
#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <cstring>
#include <deque>
#include <memory>
#include <mutex>
#include <set>
#include <thread>

namespace shard::platform {

namespace {

constexpr const char* kService = "org.kde.kglobalaccel";
constexpr const char* kPath = "/kglobalaccel";
constexpr const char* kInterface = "org.kde.KGlobalAccel";
constexpr const char* kComponent = "com.shard.app";
constexpr const char* kComponentFriendly = "Shard";
// Object path = component unique name with non [A-Za-z0-9_] replaced by '_'.
constexpr const char* kComponentPath = "/component/com_shard_app";
// KGlobalAccel::SetShortcutFlag: SetPresent (action active) | NoAutoloading
// (Shard's settings win over keys KDE saved for the action earlier).
constexpr uint32_t kSetFlags = 2 | 4;
constexpr uint64_t kCallTimeoutUsec = 3 * 1000 * 1000;

// Qt::KeyboardModifier and Qt::Key values (stable Qt ABI).
constexpr int kShift = 0x02000000;
constexpr int kCtrl = 0x04000000;
constexpr int kAlt = 0x08000000;
constexpr int kMeta = 0x10000000;
constexpr int kKeypad = 0x20000000;

std::string lower(std::string value)
{
  std::transform(value.begin(), value.end(), value.begin(),
                 [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
  return value;
}

std::string trim(const std::string& value)
{
  const size_t start = value.find_first_not_of(" \t");
  if (start == std::string::npos)
    return {};
  return value.substr(start, value.find_last_not_of(" \t") - start + 1);
}

// Electron key name -> Qt key; 0 when unsupported.
int qtKey(const std::string& token)
{
  const std::string name = lower(token);
  if (name.size() == 1) {
    const unsigned char c = static_cast<unsigned char>(name[0]);
    if (c >= 'a' && c <= 'z')
      return std::toupper(c);
    // Digits and punctuation: Qt uses the character code.
    return c > 0x20 && c < 0x7f ? c : 0;
  }
  if (name[0] == 'f' && name.size() <= 3 &&
      std::all_of(name.begin() + 1, name.end(), [](unsigned char c) { return std::isdigit(c) != 0; })) {
    const int n = std::stoi(name.substr(1));
    return n >= 1 && n <= 24 ? 0x01000030 + n - 1 : 0;
  }
  if (name.size() == 4 && name.rfind("num", 0) == 0 && std::isdigit(static_cast<unsigned char>(name[3])))
    return kKeypad | name[3];
  static const struct {
    const char* name;
    int key;
  } kNamed[] = {
      {"plus", '+'},
      {"space", 0x20},
      {"tab", 0x01000001},
      {"backspace", 0x01000003},
      {"return", 0x01000004},
      {"enter", 0x01000004},
      {"insert", 0x01000006},
      {"delete", 0x01000007},
      {"printscreen", 0x01000009},
      {"home", 0x01000010},
      {"end", 0x01000011},
      {"left", 0x01000012},
      {"up", 0x01000013},
      {"right", 0x01000014},
      {"down", 0x01000015},
      {"pageup", 0x01000016},
      {"pagedown", 0x01000017},
      {"escape", 0x01000000},
      {"esc", 0x01000000},
      {"capslock", 0x01000024},
      {"numlock", 0x01000025},
      {"scrolllock", 0x01000026},
      {"volumedown", 0x01000070},
      {"volumemute", 0x01000071},
      {"volumeup", 0x01000072},
      {"mediaplaypause", 0x01000086},
      {"mediastop", 0x01000081},
      {"mediaprevioustrack", 0x01000082},
      {"medianexttrack", 0x01000083},
      {"numdec", kKeypad | '.'},
      {"numadd", kKeypad | '+'},
      {"numsub", kKeypad | '-'},
      {"nummult", kKeypad | '*'},
      {"numdiv", kKeypad | '/'},
  };
  for (const auto& entry : kNamed)
    if (name == entry.name)
      return entry.key;
  return 0;
}

// Electron accelerator ("CommandOrControl+Shift+F8") -> Qt key combination;
// 0 with `error` when it cannot be expressed.
int parseAccelerator(const std::string& accelerator, std::string& error)
{
  std::vector<std::string> tokens;
  size_t start = 0;
  while (start <= accelerator.size()) {
    const size_t plus = accelerator.find('+', start);
    const size_t end = plus == std::string::npos ? accelerator.size() : plus;
    tokens.push_back(trim(accelerator.substr(start, end - start)));
    if (plus == std::string::npos)
      break;
    start = plus + 1;
  }
  int modifiers = 0;
  for (size_t i = 0; i + 1 < tokens.size(); i++) {
    const std::string m = lower(tokens[i]);
    if (m == "ctrl" || m == "control" || m == "commandorcontrol" || m == "cmdorctrl")
      modifiers |= kCtrl;
    else if (m == "alt" || m == "option")
      modifiers |= kAlt;
    else if (m == "shift")
      modifiers |= kShift;
    else if (m == "super" || m == "meta" || m == "cmd" || m == "command")
      modifiers |= kMeta;
    else {
      error = "Unsupported modifier \"" + tokens[i] + "\"";
      return 0;
    }
  }
  const int key = tokens.empty() ? 0 : qtKey(tokens.back());
  if (!key) {
    error = "Unsupported key \"" + (tokens.empty() ? accelerator : tokens.back()) + "\"";
    return 0;
  }
  return modifiers | key;
}

struct Service {
  std::mutex mutex;
  std::condition_variable changed;
  std::deque<std::function<void(sd_bus*)>> tasks;
  std::thread thread;
  std::atomic<bool> run{false};
  bool started = false; // thread finished its setup (bus may still be null)
  bool busOk = false;
  std::function<void(const std::string&)> onPressed;

  // Owned by the service thread.
  std::string owner; // unique name of org.kde.kglobalaccel; "" when absent
  std::vector<ShortcutBinding> last;
  std::set<std::string> bound;
  bool reapply = false;
};

Service& service()
{
  static Service instance;
  return instance;
}

std::string busError(int r, const sd_bus_error& error)
{
  return error.message ? std::string(error.message) : std::string(std::strerror(-r));
}

std::string currentOwner(sd_bus* bus)
{
  sd_bus_error error = SD_BUS_ERROR_NULL;
  sd_bus_message* reply = nullptr;
  std::string owner;
  const char* name = nullptr;
  if (sd_bus_call_method(bus, "org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus",
                         "GetNameOwner", &error, &reply, "s", kService) >= 0 &&
      sd_bus_message_read(reply, "s", &name) >= 0 && name)
    owner = name;
  sd_bus_message_unref(reply);
  sd_bus_error_free(&error);
  return owner;
}

bool unregisterAction(sd_bus* bus, const std::string& id)
{
  sd_bus_error error = SD_BUS_ERROR_NULL;
  const int r = sd_bus_call_method(bus, kService, kPath, kInterface, "unregister", &error, nullptr, "ss", kComponent,
                                   id.c_str());
  if (r < 0)
    logFormat("[hotkeys] unregister %s failed: %s", id.c_str(), busError(r, error).c_str());
  sd_bus_error_free(&error);
  return r >= 0;
}

// doRegister + setShortcutKeys; returns the first key KDE kept (0 = none).
bool registerAction(sd_bus* bus, const ShortcutBinding& binding, int key, int& kept, std::string& failure)
{
  const char* actionFriendly = binding.description.empty() ? binding.id.c_str() : binding.description.c_str();
  sd_bus_error error = SD_BUS_ERROR_NULL;
  int r = sd_bus_call_method(bus, kService, kPath, kInterface, "doRegister", &error, nullptr, "as", 4, kComponent,
                             binding.id.c_str(), kComponentFriendly, actionFriendly);
  if (r < 0) {
    failure = "KDE refused the shortcut: " + busError(r, error);
    sd_bus_error_free(&error);
    return false;
  }

  sd_bus_message* call = nullptr;
  sd_bus_message* reply = nullptr;
  const int32_t keys[4] = {key, 0, 0, 0};
  r = sd_bus_message_new_method_call(bus, &call, kService, kPath, kInterface, "setShortcutKeys");
  if (r >= 0)
    r = sd_bus_message_append(call, "as", 4, kComponent, binding.id.c_str(), kComponentFriendly, actionFriendly);
  if (r >= 0)
    r = sd_bus_message_open_container(call, 'a', "(ai)");
  if (r >= 0)
    r = sd_bus_message_open_container(call, 'r', "ai");
  if (r >= 0)
    r = sd_bus_message_append_array(call, 'i', keys, sizeof(keys));
  if (r >= 0)
    r = sd_bus_message_close_container(call);
  if (r >= 0)
    r = sd_bus_message_close_container(call);
  if (r >= 0)
    r = sd_bus_message_append(call, "u", kSetFlags);
  if (r >= 0)
    r = sd_bus_call(bus, call, kCallTimeoutUsec, &error, &reply);
  if (r < 0) {
    failure = "KDE refused the shortcut: " + busError(r, error);
  } else {
    kept = 0;
    if (sd_bus_message_enter_container(reply, 'a', "(ai)") > 0) {
      while (sd_bus_message_enter_container(reply, 'r', "ai") > 0) {
        const void* data = nullptr;
        size_t size = 0;
        if (sd_bus_message_read_array(reply, 'i', &data, &size) >= 0 && size >= sizeof(int32_t) && !kept)
          std::memcpy(&kept, data, sizeof(int32_t));
        sd_bus_message_exit_container(reply);
      }
      sd_bus_message_exit_container(reply);
    }
  }
  sd_bus_message_unref(reply);
  sd_bus_message_unref(call);
  sd_bus_error_free(&error);
  return r >= 0;
}

// Runs on the service thread.
ShortcutBindResult applyBindings(sd_bus* bus, const std::vector<ShortcutBinding>& bindings)
{
  Service& s = service();
  ShortcutBindResult result;
  s.last = bindings;
  if (s.owner.empty())
    s.owner = currentOwner(bus);
  if (s.owner.empty())
    return result; // no kglobalaccel (not KDE): unsupported
  result.supported = true;

  std::set<std::string> wanted;
  for (const auto& binding : bindings) {
    ShortcutBindResult::Item item;
    item.id = binding.id;
    wanted.insert(binding.id);
    if (binding.accelerator.empty()) {
      if (s.bound.erase(binding.id))
        unregisterAction(bus, binding.id);
      item.ok = true;
      result.results.push_back(std::move(item));
      continue;
    }
    const int key = parseAccelerator(binding.accelerator, item.error);
    int kept = 0;
    if (key && registerAction(bus, binding, key, kept, item.error)) {
      if (kept == key)
        item.ok = true;
      else
        item.error = kept ? "KDE kept a different key for this action"
                          : "Already used by another shortcut (System Settings > Keyboard > Shortcuts)";
    }
    if (item.ok) {
      s.bound.insert(binding.id);
    } else if (s.bound.erase(binding.id) || key) {
      // Never leave a stale or unexpected key active for a failed action.
      unregisterAction(bus, binding.id);
    }
    logFormat("[hotkeys] %s=\"%s\" %s%s", binding.id.c_str(), binding.accelerator.c_str(),
              item.ok ? "registered" : "failed: ", item.error.c_str());
    result.results.push_back(std::move(item));
  }
  for (auto it = s.bound.begin(); it != s.bound.end();) {
    if (wanted.count(*it)) {
      ++it;
      continue;
    }
    unregisterAction(bus, *it);
    it = s.bound.erase(it);
  }
  return result;
}

int onShortcutPressed(sd_bus_message* message, void*, sd_bus_error*)
{
  Service& s = service();
  const char* sender = sd_bus_message_get_sender(message);
  const char* component = nullptr;
  const char* action = nullptr;
  int64_t timestamp = 0;
  if (!sender || s.owner != sender || sd_bus_message_read(message, "ssx", &component, &action, &timestamp) < 0 ||
      !component || !action || std::strcmp(component, kComponent) != 0 || !s.bound.count(action))
    return 0;
  if (s.onPressed)
    s.onPressed(action);
  return 0;
}

int onOwnerChanged(sd_bus_message* message, void*, sd_bus_error*)
{
  Service& s = service();
  const char* name = nullptr;
  const char* previous = nullptr;
  const char* current = nullptr;
  if (sd_bus_message_read(message, "sss", &name, &previous, &current) < 0 || !name ||
      std::strcmp(name, kService) != 0)
    return 0;
  s.owner = current ? current : "";
  if (!s.owner.empty() && !s.last.empty()) {
    logFormat("[hotkeys] kglobalaccel restarted; registering shortcuts again");
    s.reapply = true; // outside the dispatch callback
  }
  return 0;
}

void serviceThread()
{
  Service& s = service();
  sd_bus* bus = nullptr;
  sd_bus_slot* pressedSlot = nullptr;
  sd_bus_slot* ownerSlot = nullptr;
  int r = sd_bus_open_user(&bus);
  if (r >= 0)
    sd_bus_set_method_call_timeout(bus, kCallTimeoutUsec);
  if (r >= 0)
    r = sd_bus_match_signal(bus, &pressedSlot, nullptr, kComponentPath, "org.kde.kglobalaccel.Component",
                            "globalShortcutPressed", onShortcutPressed, nullptr);
  if (r >= 0)
    r = sd_bus_add_match(bus, &ownerSlot,
                         "type='signal',sender='org.freedesktop.DBus',path='/org/freedesktop/DBus',"
                         "interface='org.freedesktop.DBus',member='NameOwnerChanged',arg0='org.kde.kglobalaccel'",
                         onOwnerChanged, nullptr);
  if (r >= 0)
    s.owner = currentOwner(bus);
  if (r < 0)
    logFormat("[hotkeys] session bus unavailable (errno %d); global shortcuts unsupported", -r);
  else if (s.owner.empty())
    logFormat("[hotkeys] kglobalaccel not running (not KDE Plasma); global shortcuts unsupported");
  {
    std::lock_guard<std::mutex> lock(s.mutex);
    s.started = true;
    s.busOk = r >= 0;
  }
  s.changed.notify_all();

  while (r >= 0 && s.run.load()) {
    std::deque<std::function<void(sd_bus*)>> tasks;
    {
      std::lock_guard<std::mutex> lock(s.mutex);
      tasks.swap(s.tasks);
    }
    for (auto& task : tasks)
      task(bus);
    if (s.reapply) {
      s.reapply = false;
      applyBindings(bus, std::vector<ShortcutBinding>(s.last));
    }
    const int processed = sd_bus_process(bus, nullptr);
    if (processed < 0) {
      logFormat("[hotkeys] session bus failed (errno %d)", -processed);
      break;
    }
    if (processed == 0)
      sd_bus_wait(bus, 100 * 1000);
  }

  {
    std::lock_guard<std::mutex> lock(s.mutex);
    s.busOk = false;
    s.tasks.clear();
  }
  sd_bus_slot_unref(ownerSlot);
  sd_bus_slot_unref(pressedSlot);
  sd_bus_flush_close_unref(bus);
}

} // namespace

void startGlobalShortcuts(std::function<void(const std::string& id)> onPressed)
{
  Service& s = service();
  if (s.run.exchange(true))
    return;
  s.onPressed = std::move(onPressed);
  {
    std::lock_guard<std::mutex> lock(s.mutex);
    s.started = false;
  }
  s.thread = std::thread(serviceThread);
}

void stopGlobalShortcuts()
{
  Service& s = service();
  s.run.store(false);
  if (s.thread.joinable())
    s.thread.join();
}

ShortcutBindResult bindGlobalShortcuts(const std::vector<ShortcutBinding>& bindings)
{
  Service& s = service();
  struct Pending {
    ShortcutBindResult result;
    bool done = false;
  };
  auto pending = std::make_shared<Pending>();
  std::unique_lock<std::mutex> lock(s.mutex);
  s.changed.wait_for(lock, std::chrono::seconds(3), [&] { return s.started || !s.run.load(); });
  if (!s.run.load() || !s.busOk)
    return {};
  s.tasks.push_back([pending, bindings](sd_bus* bus) {
    ShortcutBindResult result = applyBindings(bus, bindings);
    Service& svc = service();
    std::lock_guard<std::mutex> guard(svc.mutex);
    pending->result = std::move(result);
    pending->done = true;
    svc.changed.notify_all();
  });
  // Each action costs two calls into KWin (3 s timeout each).
  if (!s.changed.wait_for(lock, std::chrono::seconds(10), [&] { return pending->done; })) {
    logFormat("[hotkeys] kglobalaccel did not answer in time");
    return {};
  }
  return pending->result;
}

} // namespace shard::platform
