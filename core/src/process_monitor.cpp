#include "process_monitor.h"

#include "game_util.h"

#include <algorithm>
#include <cstdio>

#ifdef _WIN32
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <tlhelp32.h>
#include <wbemidl.h>
#endif

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

void ProcessMonitor::resolve(uint32_t pid)
{
#ifdef _WIN32
  HANDLE h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
  if (!h)
    return;
  wchar_t path[MAX_PATH] = {0};
  DWORD size = MAX_PATH;
  int64_t startMs = 0;
  if (QueryFullProcessImageNameW(h, 0, path, &size)) {
    FILETIME ct, et, kt, ut;
    if (GetProcessTimes(h, &ct, &et, &kt, &ut)) {
      ULARGE_INTEGER li;
      li.LowPart = ct.dwLowDateTime;
      li.HighPart = ct.dwHighDateTime;
      // FILETIME (100 ns since 1601) -> unix ms.
      startMs = (int64_t)(li.QuadPart / 10000 - 11644473600000LL);
    }
    std::lock_guard<std::mutex> lock(mtx_);
    auto it = table_.find(pid);
    if (it != table_.end()) {
      it->second.path = toLower(wideToUtf8(path));
      if (it->second.startMs == 0)
        it->second.startMs = startMs;
    }
  }
  CloseHandle(h);
#else
  (void)pid;
#endif
}

} // namespace clipforge
