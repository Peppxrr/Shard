#include "process_monitor.h"

#include "game_util.h"

#include <algorithm>
#include <cstdio>
#include <cwchar>

#ifdef _WIN32
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <tlhelp32.h>
#include <wbemidl.h>
#include <winternl.h>
#endif

#include <string>

namespace clipforge {

namespace {

#ifdef _WIN32

// WMI Wbem datetime "YYYYMMDDHHMMSS.ffffff±UUU" -> unix ms (UTC-adjusted).
int64_t wmiDateToUnixMs(const std::wstring& w)
{
  auto field = [&](size_t pos, size_t len) -> int {
    int v = 0;
    for (size_t i = pos; i < pos + len && i < w.size(); i++) {
      if (w[i] < L'0' || w[i] > L'9')
        return 0;
      v = v * 10 + (w[i] - L'0');
    }
    return v;
  };
  const int year = field(0, 4);
  const int mon = field(4, 2);
  const int day = field(6, 2);
  const int hour = field(8, 2);
  const int min = field(10, 2);
  const int sec = field(12, 2);
  int offsetMin = 0;
  if (w.size() >= 22 && (w[21] == L'+' || w[21] == L'-')) {
    const int sign = w[21] == L'-' ? -1 : 1;
    offsetMin = sign * (field(22, 3) * 60 + field(25, 2));
  }
  if (year < 1970)
    return 0;
  struct tm t = {};
  t.tm_year = year - 1900;
  t.tm_mon = mon - 1;
  t.tm_mday = day;
  t.tm_hour = hour;
  t.tm_min = min;
  t.tm_sec = sec;
  time_t utc = _mkgmtime(&t);
  if (utc == (time_t)-1)
    return 0;
  return (int64_t)utc * 1000 - (int64_t)offsetMin * 60000;
}

std::string wideToUtf8(const wchar_t* w)
{
  if (!w)
    return {};
  int len = WideCharToMultiByte(CP_UTF8, 0, w, -1, nullptr, 0, nullptr, nullptr);
  if (len <= 1)
    return {};
  std::string out(len - 1, '\0');
  WideCharToMultiByte(CP_UTF8, 0, w, -1, out.data(), len, nullptr, nullptr);
  return out;
}

// Async WMI sink: Indicate() is invoked on a WMI-managed thread; events are
// pushed into the monitor's queue (mutex-guarded).
class WmiEventSink : public IWbemObjectSink {
public:
  explicit WmiEventSink(std::function<void(const ProcessEvent&)> push) : push_(std::move(push)) {}

  ULONG STDMETHODCALLTYPE AddRef() override { return InterlockedIncrement(&refs_); }
  ULONG STDMETHODCALLTYPE Release() override
  {
    const ULONG r = InterlockedDecrement(&refs_);
    if (r == 0)
      delete this;
    return r;
  }
  HRESULT STDMETHODCALLTYPE QueryInterface(REFIID riid, void** ppv) override
  {
    if (riid == IID_IUnknown || riid == IID_IWbemObjectSink) {
      *ppv = static_cast<IWbemObjectSink*>(this);
      AddRef();
      return S_OK;
    }
    return E_NOINTERFACE;
  }

  HRESULT STDMETHODCALLTYPE Indicate(LONG objectCount, IWbemClassObject** objArray) override
  {
    for (LONG i = 0; i < objectCount && objArray; i++) {
      ProcessEvent ev;
      bool hasPid = false;

      VARIANT v;
      VariantInit(&v);
      if (SUCCEEDED(objArray[i]->Get(L"ProcessName", 0, &v, 0, 0)) && v.vt == VT_BSTR && v.bstrVal)
        ev.info.exe = toLower(baseName(wideToUtf8(v.bstrVal)));
      VariantClear(&v);
      VariantInit(&v);
      if (SUCCEEDED(objArray[i]->Get(L"PID", 0, &v, 0, 0))) {
        if (v.vt == VT_I4 || v.vt == VT_UI4 || v.vt == VT_UI8 || v.vt == VT_I8)
          ev.info.pid = (uint32_t)v.ullVal;
        hasPid = true;
      }
      VariantClear(&v);
      VariantInit(&v);
      // ParentProcessID exists on StartTrace but NOT on StopTrace — that is
      // how we distinguish start from exit events.
      const HRESULT parentHr = objArray[i]->Get(L"ParentProcessID", 0, &v, 0, 0);
      if (SUCCEEDED(parentHr)) {
        if (v.vt == VT_I4 || v.vt == VT_UI4 || v.vt == VT_UI8 || v.vt == VT_I8)
          ev.info.parentPid = (uint32_t)v.ullVal;
        VariantClear(&v);
        VariantInit(&v);
        if (SUCCEEDED(objArray[i]->Get(L"CreationDate", 0, &v, 0, 0)) && v.vt == VT_BSTR && v.bstrVal)
          ev.info.startMs = wmiDateToUnixMs(std::wstring(v.bstrVal));
        VariantClear(&v);
        ev.type = ProcessEvent::Type::Started;
      } else {
        VariantClear(&v);
        ev.type = ProcessEvent::Type::Exited;
      }

      if (hasPid)
        push_(ev);
    }
    return WBEM_S_NO_ERROR;
  }

  HRESULT STDMETHODCALLTYPE SetStatus(LONG /*flags*/, HRESULT /*result*/, BSTR /*strParam*/,
                                      IWbemClassObject* /*objParam*/) override
  {
    return WBEM_S_NO_ERROR;
  }

private:
  std::function<void(const ProcessEvent&)> push_;
  LONG refs_ = 1;
};

template <size_t N>
bool moduleMatches(const wchar_t* name, const wchar_t* const (&candidates)[N])
{
  for (const wchar_t* candidate : candidates)
    if (_wcsicmp(name, candidate) == 0)
      return true;
  return false;
}

bool moduleStartsWith(const wchar_t* name, const wchar_t* prefix)
{
  return _wcsnicmp(name, prefix, std::wcslen(prefix)) == 0;
}

bool moduleEndsWith(const wchar_t* name, const wchar_t* suffix)
{
  const size_t nameLength = std::wcslen(name);
  const size_t suffixLength = std::wcslen(suffix);
  return nameLength >= suffixLength &&
         _wcsicmp(name + nameLength - suffixLength, suffix) == 0;
}

const wchar_t* const kGraphicsModules[] = {
    L"d3d9.dll", L"d3d10.dll", L"d3d10_1.dll", L"d3d11.dll",
    L"d3d12.dll", L"dxgi.dll", L"opengl32.dll", L"vulkan-1.dll",
};

// Strong semantic identity only. SDL, FMOD, Mono, Steam API, and graphics APIs
// are general-purpose middleware used by ordinary desktop software; treating
// any one of them as a game caused the generic-GUI false positives this probe
// exists to prevent.
const wchar_t* const kGameRuntimeModules[] = {
    L"unityplayer.dll", L"gameassembly.dll",
};

const wchar_t* const kModernGameInputModules[] = {
    L"windows.gaming.input.dll", L"gameinput.dll",
};

const wchar_t* const kControllerInputModules[] = {
    L"dinput8.dll", L"xinput1_4.dll", L"xinput1_3.dll", L"xinput9_1_0.dll",
};

const wchar_t* const kWebRuntimeModules[] = {
    L"libcef.dll", L"chrome_elf.dll", L"msedge_elf.dll",
    L"webview2loader.dll", L"embeddedbrowserwebview.dll",
};

std::wstring wideFromUtf8(const std::string& value)
{
  if (value.empty())
    return {};
  const int count = MultiByteToWideChar(CP_UTF8, 0, value.c_str(), static_cast<int>(value.size()),
                                        nullptr, 0);
  if (count <= 0)
    return {};
  std::wstring out(static_cast<size_t>(count), L'\0');
  MultiByteToWideChar(CP_UTF8, 0, value.c_str(), static_cast<int>(value.size()), out.data(), count);
  return out;
}

bool regularFile(const std::string& path)
{
  const std::wstring wide = wideFromUtf8(path);
  if (wide.empty())
    return false;
  const DWORD attributes = GetFileAttributesW(wide.c_str());
  return attributes != INVALID_FILE_ATTRIBUTES && !(attributes & FILE_ATTRIBUTE_DIRECTORY);
}

bool hasElectronApplicationLayout(const ProcessInfo& process)
{
  const size_t separator = process.path.find_last_of("\\/");
  if (separator == std::string::npos)
    return false;
  const std::string root = process.path.substr(0, separator);
  return regularFile(root + "\\resources\\app.asar") &&
         (regularFile(root + "\\resources.pak") || regularFile(root + "\\chrome_100_percent.pak"));
}

const wchar_t* const kMediaRuntimeModules[] = {
    L"libvlc.dll", L"libvlccore.dll", L"libmpv-2.dll", L"gstreamer-1.0-0.dll",
};

#endif // _WIN32

} // namespace

ProcessMonitor::~ProcessMonitor()
{
  stop();
}

void ProcessMonitor::start(std::function<void(const ProcessEvent&)> sink)
{
  if (run_.exchange(true))
    return;
  sink_ = std::move(sink);
#ifdef _WIN32
  wmiThread_ = std::thread([this] { wmiLoop(); });
#endif
}

void ProcessMonitor::stop()
{
  if (!run_.exchange(false))
    return;
#ifdef _WIN32
  if (wmiThread_.joinable())
    wmiThread_.join();
#endif
}

void ProcessMonitor::pushEvent(const ProcessEvent& e)
{
  std::lock_guard<std::mutex> lock(mtx_);
  queue_.push_back(e);
}

#ifdef _WIN32

void ProcessMonitor::wmiLoop()
{
  HRESULT hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  if (FAILED(hr) && hr != RPC_E_CHANGED_MODE) {
    std::fprintf(stderr, "[process_monitor] WMI unavailable (CoInitializeEx 0x%08lx)\n", (unsigned long)hr);
    return;
  }
  // Only succeeds once per process; RPC_E_TOO_LATE is fine (somebody else
  // already initialized security with compatible settings).
  CoInitializeSecurity(nullptr, -1, nullptr, nullptr, RPC_C_AUTHN_LEVEL_DEFAULT, RPC_C_IMP_LEVEL_IMPERSONATE,
                       nullptr, EOAC_NONE, nullptr);

  IWbemLocator* locator = nullptr;
  IWbemServices* service = nullptr;
  WmiEventSink* sink = nullptr;

  hr = CoCreateInstance(CLSID_WbemLocator, nullptr, CLSCTX_INPROC_SERVER, IID_IWbemLocator, (void**)&locator);
  if (FAILED(hr)) {
    std::fprintf(stderr, "[process_monitor] WMI locator failed (0x%08lx)\n", (unsigned long)hr);
    CoUninitialize();
    return;
  }
  hr = locator->ConnectServer(BSTR(L"ROOT\\CIMV2"), nullptr, nullptr, 0, 0, 0, nullptr, &service);
  if (FAILED(hr)) {
    std::fprintf(stderr, "[process_monitor] WMI connect failed (0x%08lx)\n", (unsigned long)hr);
    locator->Release();
    CoUninitialize();
    return;
  }

  sink = new WmiEventSink([this](const ProcessEvent& e) { pushEvent(e); });
  hr = service->ExecNotificationQueryAsync(BSTR(L"WQL"), BSTR(L"SELECT * FROM Win32_ProcessStartTrace"), 0,
                                           nullptr, sink);
  if (FAILED(hr)) {
    std::fprintf(stderr, "[process_monitor] WMI start-trace subscribe failed (0x%08lx)\n", (unsigned long)hr);
    sink->Release();
    service->Release();
    locator->Release();
    CoUninitialize();
    return;
  }
  // Keep a separate ref for the stop trace; both are released on shutdown.
  service->AddRef();
  hr = service->ExecNotificationQueryAsync(BSTR(L"WQL"), BSTR(L"SELECT * FROM Win32_ProcessStopTrace"), 0,
                                           nullptr, sink);
  if (SUCCEEDED(hr)) {
    wmiOk_.store(true);
    std::fprintf(stderr, "[process_monitor] WMI process events subscribed\n");
  } else {
    std::fprintf(stderr, "[process_monitor] WMI stop-trace subscribe failed (0x%08lx)\n", (unsigned long)hr);
    // Start-trace still works; fall back to reconcile-only for exits.
  }

  // Keep the subscription alive until stop(); async delivery runs on its own
  // thread, we just hold the references.
  while (run_.load())
    std::this_thread::sleep_for(std::chrono::milliseconds(200));

  service->CancelAsyncCall(sink);
  service->Release();
  service->Release();
  sink->Release();
  locator->Release();
  CoUninitialize();
}

void ProcessMonitor::applySnapshot()
{
  HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
  if (snap == INVALID_HANDLE_VALUE)
    return;
  PROCESSENTRY32W pe = {};
  pe.dwSize = sizeof(pe);
  std::map<uint32_t, ProcessInfo> fresh;
  if (Process32FirstW(snap, &pe)) {
    do {
      ProcessInfo p;
      p.pid = pe.th32ProcessID;
      p.exe = toLower(baseName(wideToUtf8(pe.szExeFile)));
      p.parentPid = pe.th32ParentProcessID;
      fresh[p.pid] = std::move(p);
    } while (Process32NextW(snap, &pe));
  }
  CloseHandle(snap);

  std::vector<ProcessEvent> toEmit;
  {
    std::lock_guard<std::mutex> lock(mtx_);

    // Apply queued WMI events first: they update table_ and are emitted
    // immediately (their pids then count as "known" for the diff below).
    while (!queue_.empty()) {
      ProcessEvent e = std::move(queue_.front());
      queue_.pop_front();
      if (e.type == ProcessEvent::Type::Started) {
        table_[e.info.pid] = e.info;
        if (fresh.find(e.info.pid) == fresh.end())
          fresh[e.info.pid] = e.info; // process already gone; still reported
      } else {
        table_.erase(e.info.pid);
      }
      toEmit.push_back(std::move(e));
    }

    // Carry lazily-resolved data (path/startMs) and the most precise start
    // time across snapshots.
    for (auto& [pid, p] : fresh) {
      auto it = table_.find(pid);
      if (it == table_.end())
        continue;
      if (p.parentPid == 0)
        p.parentPid = it->second.parentPid;
      if (it->second.startMs != 0)
        p.startMs = it->second.startMs;
      p.path = it->second.path;
      p.commandLine = it->second.commandLine;
    }

    // Diff: only genuinely new/exited processes produce events.
    for (const auto& [pid, p] : fresh)
      if (!table_.count(pid)) {
        ProcessEvent ev;
        ev.type = ProcessEvent::Type::Started;
        ev.info = p;
        toEmit.push_back(std::move(ev));
      }
    for (const auto& [pid, p] : table_) {
      (void)p;
      if (!fresh.count(pid)) {
        ProcessEvent ev;
        ev.type = ProcessEvent::Type::Exited;
        ev.info.pid = pid;
        toEmit.push_back(std::move(ev));
      }
    }

    table_ = std::move(fresh);
  }

  // Emit outside the lock: sinks call back into the monitor (resolve/lookup).
  if (sink_)
    for (const auto& ev : toEmit)
      sink_(ev);
}

#endif // _WIN32

void ProcessMonitor::tick()
{
#ifdef _WIN32
  applySnapshot();
#endif
}

ProcessInfo ProcessMonitor::lookup(uint32_t pid) const
{
  std::lock_guard<std::mutex> lock(mtx_);
  auto it = table_.find(pid);
  return it == table_.end() ? ProcessInfo{} : it->second;
}

std::vector<uint32_t> ProcessMonitor::ancestors(uint32_t pid, int maxDepth) const
{
  std::lock_guard<std::mutex> lock(mtx_);
  std::vector<uint32_t> out;
  uint32_t cur = pid;
  for (int i = 0; i < maxDepth && cur != 0; i++) {
    out.push_back(cur);
    auto it = table_.find(cur);
    if (it == table_.end() || it->second.parentPid == cur)
      break;
    cur = it->second.parentPid;
  }
  return out;
}

bool ProcessMonitor::alive(uint32_t pid) const
{
  std::lock_guard<std::mutex> lock(mtx_);
  return table_.find(pid) != table_.end();
}

std::vector<uint32_t> ProcessMonitor::allPids() const
{
  std::lock_guard<std::mutex> lock(mtx_);
  std::vector<uint32_t> out;
  out.reserve(table_.size());
  for (const auto& [pid, _] : table_) out.push_back(pid);
  return out;
}

void ProcessMonitor::resolve(uint32_t pid)
{
#ifdef _WIN32
  HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
  if (!process)
    return;

  std::string resolvedPath;
  wchar_t path[MAX_PATH] = {0};
  DWORD pathSize = MAX_PATH;
  if (QueryFullProcessImageNameW(process, 0, path, &pathSize))
    resolvedPath = toLower(wideToUtf8(path));

  int64_t startMs = 0;
  FILETIME creation, exit, kernel, user;
  if (GetProcessTimes(process, &creation, &exit, &kernel, &user)) {
    ULARGE_INTEGER value;
    value.LowPart = creation.dwLowDateTime;
    value.HighPart = creation.dwHighDateTime;
    startMs = (int64_t)(value.QuadPart / 10000 - 11644473600000LL);
  }

  std::string commandLine;
  using NtQueryInformationProcessFn = LONG(NTAPI*)(HANDLE, ULONG, PVOID, ULONG, PULONG);
  const HMODULE ntdll = GetModuleHandleW(L"ntdll.dll");
  const auto queryProcess = ntdll ? reinterpret_cast<NtQueryInformationProcessFn>(
                                        GetProcAddress(ntdll, "NtQueryInformationProcess"))
                                  : nullptr;
  if (queryProcess) {
    ULONG bytes = 0;
    queryProcess(process, 60 /* ProcessCommandLineInformation */, nullptr, 0, &bytes);
    if (bytes >= sizeof(UNICODE_STRING) && bytes <= 1024 * 1024) {
      std::vector<unsigned char> buffer(bytes);
      if (queryProcess(process, 60, buffer.data(), bytes, &bytes) >= 0) {
        const auto* text = reinterpret_cast<const UNICODE_STRING*>(buffer.data());
        if (text->Buffer && text->Length > 0) {
          const int chars = text->Length / (int)sizeof(wchar_t);
          const int utf8Bytes = WideCharToMultiByte(CP_UTF8, 0, text->Buffer, chars, nullptr, 0, nullptr, nullptr);
          if (utf8Bytes > 0) {
            commandLine.resize((size_t)utf8Bytes);
            WideCharToMultiByte(CP_UTF8, 0, text->Buffer, chars, commandLine.data(), utf8Bytes, nullptr, nullptr);
            commandLine = toLower(commandLine);
          }
        }
      }
    }
  }
  CloseHandle(process);

  std::lock_guard<std::mutex> lock(mtx_);
  auto it = table_.find(pid);
  if (it != table_.end()) {
    if (!resolvedPath.empty())
      it->second.path = std::move(resolvedPath);
    if (!commandLine.empty())
      it->second.commandLine = std::move(commandLine);
    if (it->second.startMs == 0)
      it->second.startMs = startMs;
  }
#else
  (void)pid;
#endif
}

ProcessRuntimeFacts ProcessMonitor::probeRuntime(uint32_t pid) const
{
  ProcessRuntimeFacts facts;
#ifdef _WIN32
  if (pid == 0)
    return facts;
  const ProcessInfo process = lookup(pid);
  // Electron's browser process does not consistently keep chrome_elf.dll
  // loaded. Its signed distribution layout and app.asar command line are
  // stable runtime evidence shared by CurseForge, Discord, launchers, and
  // other hosted applications—unlike an executable-name denylist.
  facts.webRuntime = hasElectronApplicationLayout(process) ||
                     process.commandLine.find("app.asar") != std::string::npos;


  HANDLE snapshot = INVALID_HANDLE_VALUE;
  // The loader may mutate its module list while a game starts. Toolhelp asks
  // callers to retry ERROR_BAD_LENGTH rather than treating it as no evidence.
  for (int attempt = 0; attempt < 3; attempt++) {
    snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPMODULE | TH32CS_SNAPMODULE32, pid);
    if (snapshot != INVALID_HANDLE_VALUE || GetLastError() != ERROR_BAD_LENGTH)
      break;
  }
  if (snapshot == INVALID_HANDLE_VALUE)
    return facts;

  MODULEENTRY32W module = {};
  module.dwSize = sizeof(module);
  bool modernGameInput = false;
  bool controllerInput = false;
  if (Module32FirstW(snapshot, &module)) {
    facts.probeSucceeded = true;
    do {
      facts.graphicsApi = facts.graphicsApi || moduleMatches(module.szModule, kGraphicsModules);
      facts.gameRuntime = facts.gameRuntime || moduleMatches(module.szModule, kGameRuntimeModules);
      modernGameInput = modernGameInput || moduleMatches(module.szModule, kModernGameInputModules);
      controllerInput = controllerInput || moduleMatches(module.szModule, kControllerInputModules);
      facts.webRuntime = facts.webRuntime || moduleMatches(module.szModule, kWebRuntimeModules) ||
                         moduleEndsWith(module.szModule, L".node");
      facts.mediaRuntime = facts.mediaRuntime || moduleMatches(module.szModule, kMediaRuntimeModules) ||
                           moduleStartsWith(module.szModule, L"avformat-") ||
                           moduleStartsWith(module.szModule, L"libavformat");
    } while (Module32NextW(snapshot, &module));
  }
  facts.gameInput = modernGameInput && controllerInput;
  CloseHandle(snapshot);
#else
  (void)pid;
#endif
  return facts;
}

} // namespace clipforge
