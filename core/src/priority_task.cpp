#include "priority_task.h"

#include "priority_policy.h"
#include "priority_runtime.h"
#include "system_info.h"

#include <nlohmann/json.hpp>

#include <cctype>
#include <cstdio>
#include <cstdlib>
#include <cwchar>
#include <filesystem>
#include <fstream>
#include <random>
#include <string>
#include <thread>
#include <vector>

#ifdef _WIN32
#include "process-supervisor.h"

#include <windows.h>
#include <aclapi.h>
#include <sddl.h>
#include <shellapi.h>
#include <shlobj.h>
#include <taskschd.h>
#endif

namespace shard {

namespace fs = std::filesystem;

#ifdef _WIN32

namespace {

// Exit codes of the install/uninstall helpers (the elevated process cannot
// write to the caller's stdout, so results travel as exit codes).
enum PriorityExit : int {
  kOk = 0,
  kBadArgs = 10,
  kNotElevated = 11,
  kCopyFailed = 12,
  kRegisterFailed = 13,
  kRemoveFailed = 14,
  kComFailed = 15,
  kPipeFailed = 16,
  kStandardUser = 17,  // the signed-in account cannot elevate itself
  kWrongUser = 18,     // UAC elevated a different account
  kRuntimeInUse = 19,  // the previous elevated runtime is still running
  kVerifyFailed = 20,  // registered, but the task/runtime did not check out
  kCancelled = ERROR_CANCELLED, // UAC declined
};

constexpr wchar_t kTaskFolderName[] = L"Shard";
// The protected runtime copy itself lives in priority_runtime.* (portable, tested).
constexpr const char* kPipePrefix = "shard-core-";

std::wstring widen(const std::string& text)
{
  if (text.empty())
    return {};
  const int size = MultiByteToWideChar(CP_UTF8, 0, text.data(), static_cast<int>(text.size()), nullptr, 0);
  std::wstring out(static_cast<size_t>(size), L'\0');
  MultiByteToWideChar(CP_UTF8, 0, text.data(), static_cast<int>(text.size()), out.data(), size);
  return out;
}

std::string narrow(const std::wstring& text)
{
  if (text.empty())
    return {};
  const int size =
      WideCharToMultiByte(CP_UTF8, 0, text.data(), static_cast<int>(text.size()), nullptr, 0, nullptr, nullptr);
  std::string out(static_cast<size_t>(size), '\0');
  WideCharToMultiByte(CP_UTF8, 0, text.data(), static_cast<int>(text.size()), out.data(), size, nullptr, nullptr);
  return out;
}

std::wstring lower(std::wstring text)
{
  CharLowerBuffW(text.data(), static_cast<DWORD>(text.size()));
  return text;
}

void report(const nlohmann::json& result)
{
  std::printf("PRIORITY %s\n", result.dump().c_str());
  std::fflush(stdout);
}

void diagnostic(const char* format, const std::string& detail = {})
{
  std::fprintf(stderr, "[priority] %s%s%s\n", format, detail.empty() ? "" : " ", detail.c_str());
  std::fflush(stderr);
}

struct Args {
  std::string mode; // status | install | install-elevated | uninstall | uninstall-elevated | run | bridge
  std::string pipe;
  std::wstring configDir;
  std::wstring coreBin;
  std::wstring games;
  std::wstring expectedSid; // install/uninstall-elevated: the requesting user
  uint64_t parentWindow = 0;
};

std::wstring trimSlashes(std::wstring path)
{
  while (path.size() > 3 && (path.back() == L'\\' || path.back() == L'/'))
    path.pop_back();
  return path;
}

// Wide argv: the narrow CRT argv cannot represent every profile path.
std::optional<Args> parseArgs()
{
  int count = 0;
  LPWSTR* argv = CommandLineToArgvW(GetCommandLineW(), &count);
  if (!argv)
    return std::nullopt;
  Args args;
  bool selected = false;
  for (int i = 1; i < count; ++i) {
    const std::wstring arg = argv[i];
    const auto next = [&]() -> std::wstring { return i + 1 < count ? argv[++i] : std::wstring(); };
    if (arg == L"--priority-task") {
      args.mode = narrow(next());
      selected = true;
      if (args.mode == "run")
        args.pipe = narrow(next());
    } else if (arg == L"--priority-bridge") {
      args.mode = "bridge";
      selected = true;
    } else if (arg == L"--config-dir") {
      args.configDir = trimSlashes(next());
    } else if (arg == L"--core-bin") {
      args.coreBin = trimSlashes(next());
    } else if (arg == L"--games") {
      args.games = next();
    } else if (arg == L"--parent-window") {
      args.parentWindow = std::wcstoull(next().c_str(), nullptr, 10);
    } else if (arg == L"--expected-sid") {
      args.expectedSid = next();
    }
  }
  LocalFree(argv);
  if (!selected)
    return std::nullopt;
  return args;
}

std::wstring modulePath()
{
  std::vector<wchar_t> buffer(32768);
  const DWORD length = GetModuleFileNameW(nullptr, buffer.data(), static_cast<DWORD>(buffer.size()));
  return std::wstring(buffer.data(), length);
}

std::wstring userSid()
{
  HANDLE token = nullptr;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token))
    return {};
  DWORD size = 0;
  GetTokenInformation(token, TokenUser, nullptr, 0, &size);
  std::vector<unsigned char> buffer(size);
  std::wstring sid;
  if (size && GetTokenInformation(token, TokenUser, buffer.data(), size, &size)) {
    LPWSTR text = nullptr;
    if (ConvertSidToStringSidW(reinterpret_cast<TOKEN_USER*>(buffer.data())->User.Sid, &text)) {
      sid = text;
      LocalFree(text);
    }
  }
  CloseHandle(token);
  return sid;
}

std::wstring taskName(const std::wstring& sid)
{
  return L"Recording priority " + sid;
}

// Program Files is writable only by administrators, so a medium-integrity
// process cannot replace what the elevated task runs.
fs::path protectedRoot(const std::wstring& sid)
{
  PWSTR programFiles = nullptr;
  fs::path root;
  if (SUCCEEDED(SHGetKnownFolderPath(FOLDERID_ProgramFiles, 0, nullptr, &programFiles)))
    root = fs::path(programFiles) / L"Shard" / L"RecordingPriority" / sid;
  CoTaskMemFree(programFiles);
  return root;
}

fs::path protectedCoreBin(const std::wstring& sid)
{
  return protectedRoot(sid) / L"core-bin";
}

std::wstring quoted(const std::wstring& value)
{
  return L"\"" + value + L"\"";
}

std::wstring xmlEscape(const std::wstring& value)
{
  std::wstring out;
  for (const wchar_t c : value) {
    switch (c) {
      case L'&': out += L"&amp;"; break;
      case L'<': out += L"&lt;"; break;
      case L'>': out += L"&gt;"; break;
      case L'"': out += L"&quot;"; break;
      case L'\'': out += L"&apos;"; break;
      default: out += c;
    }
  }
  return out;
}

// The elevated core's arguments, fixed at registration (the only per-launch
// value is the rendezvous pipe name, $(Arg0)).
std::wstring bakedArguments(const Args& args, const fs::path& coreBin)
{
  return L"--priority-task run $(Arg0) --config-dir " + quoted(args.configDir) + L" --core-bin " +
         quoted(coreBin.wstring()) + L" --games " + quoted(args.games);
}

// ---------------------------------------------------------------- COM ----

template <class T>
struct ComPtr {
  T* p = nullptr;
  ComPtr() = default;
  ComPtr(const ComPtr&) = delete;
  ComPtr& operator=(const ComPtr&) = delete;
  ~ComPtr()
  {
    if (p)
      p->Release();
  }
  T** put() { return &p; }
  T* operator->() const { return p; }
  explicit operator bool() const { return p != nullptr; }
};

struct Bstr {
  BSTR value;
  explicit Bstr(const std::wstring& text) : value(SysAllocStringLen(text.data(), static_cast<UINT>(text.size()))) {}
  Bstr() : value(nullptr) {}
  Bstr(const Bstr&) = delete;
  Bstr& operator=(const Bstr&) = delete;
  ~Bstr() { SysFreeString(value); }
  std::wstring str() const { return value ? std::wstring(value, SysStringLen(value)) : std::wstring(); }
};

struct ComSession {
  bool ok = false;
  ComSession()
  {
    ok = SUCCEEDED(CoInitializeEx(nullptr, COINIT_MULTITHREADED));
    if (ok)
      CoInitializeSecurity(nullptr, -1, nullptr, nullptr, RPC_C_AUTHN_LEVEL_PKT_PRIVACY, RPC_C_IMP_LEVEL_IMPERSONATE,
                           nullptr, 0, nullptr);
  }
  ~ComSession()
  {
    if (ok)
      CoUninitialize();
  }
};

VARIANT emptyVariant()
{
  VARIANT value;
  VariantInit(&value);
  return value;
}

HRESULT connect(ComPtr<ITaskService>& service)
{
  HRESULT hr = CoCreateInstance(CLSID_TaskScheduler, nullptr, CLSCTX_INPROC_SERVER, IID_ITaskService,
                                reinterpret_cast<void**>(service.put()));
  if (FAILED(hr))
    return hr;
  return service->Connect(emptyVariant(), emptyVariant(), emptyVariant(), emptyVariant());
}

HRESULT shardFolder(ITaskService* service, ComPtr<ITaskFolder>& folder, bool create)
{
  HRESULT hr = service->GetFolder(Bstr(std::wstring(L"\\") + kTaskFolderName).value, folder.put());
  if (SUCCEEDED(hr) || !create)
    return hr;
  ComPtr<ITaskFolder> root;
  hr = service->GetFolder(Bstr(L"\\").value, root.put());
  if (FAILED(hr))
    return hr;
  return root->CreateFolder(Bstr(kTaskFolderName).value, emptyVariant(), folder.put());
}

struct TaskInfo {
  bool present = false;
  std::wstring path;
  std::wstring arguments;
};

TaskInfo queryTask(const std::wstring& sid)
{
  TaskInfo info;
  ComPtr<ITaskService> service;
  ComPtr<ITaskFolder> folder;
  ComPtr<IRegisteredTask> task;
  if (FAILED(connect(service)) || FAILED(shardFolder(service.p, folder, false)) ||
      FAILED(folder->GetTask(Bstr(taskName(sid)).value, task.put())))
    return info;
  info.present = true;
  ComPtr<ITaskDefinition> definition;
  ComPtr<IActionCollection> actions;
  ComPtr<IAction> action;
  ComPtr<IExecAction> exec;
  if (FAILED(task->get_Definition(definition.put())) || FAILED(definition->get_Actions(actions.put())) ||
      FAILED(actions->get_Item(1, action.put())) ||
      FAILED(action->QueryInterface(IID_IExecAction, reinterpret_cast<void**>(exec.put()))))
    return info;
  Bstr path, arguments;
  if (SUCCEEDED(exec->get_Path(&path.value)))
    info.path = path.str();
  if (SUCCEEDED(exec->get_Arguments(&arguments.value)))
    info.arguments = arguments.str();
  return info;
}

std::wstring taskXml(const Args& args, const std::wstring& sid, const fs::path& coreBin)
{
  const fs::path executable = coreBin / L"shardcore.exe";
  return LR"(<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Author>Shard</Author>
    <Description>Shard Recording priority: starts Shard's capture core with administrator rights so libobs can raise its GPU priority. Created when you turned Recording priority on; turning it off removes this task.</Description>
  </RegistrationInfo>
  <Principals>
    <Principal id="Author">
      <UserId>)" + xmlEscape(sid) + LR"(</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>HighestAvailable</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>Parallel</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>false</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>true</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>5</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>)" + xmlEscape(executable.wstring()) + LR"(</Command>
      <Arguments>)" + xmlEscape(bakedArguments(args, coreBin)) + LR"(</Arguments>
      <WorkingDirectory>)" + xmlEscape(coreBin.wstring()) + LR"(</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
)";
}

// ---------------------------------------------------------- elevation ----

int runElevated(const std::wstring& parameters, uint64_t parentWindow)
{
  const std::wstring executable = modulePath();
  SHELLEXECUTEINFOW info{};
  info.cbSize = sizeof(info);
  info.fMask = SEE_MASK_NOCLOSEPROCESS | SEE_MASK_NOASYNC;
  info.hwnd = reinterpret_cast<HWND>(static_cast<uintptr_t>(parentWindow));
  info.lpVerb = L"runas";
  info.lpFile = executable.c_str();
  info.lpParameters = parameters.c_str();
  info.nShow = SW_HIDE;
  if (!ShellExecuteExW(&info))
    return GetLastError() == ERROR_CANCELLED ? kCancelled : kComFailed;
  if (!info.hProcess)
    return kComFailed;
  WaitForSingleObject(info.hProcess, INFINITE);
  DWORD code = kComFailed;
  GetExitCodeProcess(info.hProcess, &code);
  CloseHandle(info.hProcess);
  return static_cast<int>(code);
}

std::wstring forwardedArgs(const Args& args, const std::wstring& sid)
{
  return L" --config-dir " + quoted(args.configDir) + L" --core-bin " + quoted(args.coreBin) + L" --games " +
         quoted(args.games) + L" --expected-sid " + quoted(sid);
}

const char* exitMessage(int code)
{
  switch (code) {
    case kOk: return "";
    case kCancelled: return "Administrator permission was declined.";
    case kNotElevated: return "Windows did not grant administrator rights.";
    case kStandardUser:
    case kWrongUser:
      return "Recording priority needs your own Windows account to have administrator rights. Signing in to a "
             "different administrator account in the Windows prompt isn't supported.";
    case kCopyFailed: return "Could not copy the capture core to Program Files.";
    case kRuntimeInUse:
      return "Another Shard capture core is still using the elevated copy. Close Shard completely (including the tray "
             "icon) and try again; if it still fails, restart your PC.";
    case kRegisterFailed: return "Could not create the scheduled task.";
    case kVerifyFailed: return "Windows created the scheduled task, but it didn't check out, so it was removed.";
    case kRemoveFailed: return "Could not remove the scheduled task.";
    case kBadArgs: return "Invalid Recording priority request.";
    default: return "Windows Task Scheduler is unavailable.";
  }
}

int tokenElevationType()
{
  HANDLE token = nullptr;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token))
    return 0;
  TOKEN_ELEVATION_TYPE type = TokenElevationTypeDefault;
  DWORD size = 0;
  const bool ok = GetTokenInformation(token, TokenElevationType, &type, sizeof(type), &size) != FALSE;
  CloseHandle(token);
  return ok ? static_cast<int>(type) : 0;
}

// -------------------------------------------------------------- modes ----

bool argsComplete(const Args& args)
{
  return !args.configDir.empty() && !args.coreBin.empty() && !args.games.empty();
}

nlohmann::json statusJson(const Args& args)
{
  const std::wstring sid = userSid();
  const TaskInfo task = queryTask(sid);
  const fs::path coreBin = protectedCoreBin(sid);
  std::string reason;
  if (!task.present)
    reason = "not_installed";
  else if (lower(task.path) != lower((coreBin / L"shardcore.exe").wstring()))
    reason = "task_target_changed";
  else if (task.arguments != bakedArguments(args, coreBin))
    reason = "profile_changed";
  else
    reason = runtimeFreshness(args.coreBin, coreBin);
  return {{"installed", task.present},
          {"current", reason.empty()},
          {"reason", reason.empty() ? nlohmann::json(nullptr) : nlohmann::json(reason)},
          {"elevatedCopy", narrow(coreBin.wstring())}};
}

int modeStatus(const Args& args)
{
  if (!argsComplete(args))
    return kBadArgs;
  ComSession com;
  if (!com.ok)
    return kComFailed;
  report(statusJson(args));
  return kOk;
}

// Deletes this user's task (never another SID's).
bool removeOwnTask(const std::wstring& sid)
{
  ComPtr<ITaskService> service;
  ComPtr<ITaskFolder> folder;
  if (FAILED(connect(service)) || FAILED(shardFolder(service.p, folder, false)))
    return true; // no Shard folder: nothing registered
  const HRESULT hr = folder->DeleteTask(Bstr(taskName(sid)).value, 0);
  // Fails (and is kept) while other users still have tasks in it.
  ComPtr<ITaskFolder> root;
  if (SUCCEEDED(service->GetFolder(Bstr(L"\\").value, root.put())))
    root->DeleteFolder(Bstr(kTaskFolderName).value, 0);
  return SUCCEEDED(hr) || hr == HRESULT_FROM_WIN32(ERROR_FILE_NOT_FOUND);
}

// Deletes this user's task and protected runtime (never another SID's).
bool removeOwnInstall(const std::wstring& sid)
{
  const bool taskRemoved = removeOwnTask(sid);
  std::error_code error;
  fs::remove_all(protectedRoot(sid), error);
  return taskRemoved && !error;
}

// Elevated helpers act only for the account that asked: over-the-shoulder
// UAC (a standard user typing an administrator's password) elevates a
// different SID, whose task and runtime the requesting user could not use.
int checkElevatedIdentity(const Args& args, std::wstring& sid)
{
  if (!processElevated())
    return kNotElevated;
  sid = userSid();
  if (!elevatedHelperIdentityOk(narrow(args.expectedSid), narrow(sid))) {
    diagnostic("elevated helper runs as a different account; refusing", narrow(sid));
    return kWrongUser;
  }
  return kOk;
}

int modeInstallElevated(const Args& args)
{
  if (!argsComplete(args))
    return kBadArgs;
  std::wstring sid;
  if (const int code = checkElevatedIdentity(args, sid); code != kOk)
    return code;
  ComSession com;
  if (!com.ok)
    return kComFailed;
  const fs::path coreBin = protectedCoreBin(sid);
  switch (copyRuntime(args.coreBin, coreBin)) {
    case CopyResult::Ok: break;
    // The previous copy is intact (and possibly running): leave it and its task.
    case CopyResult::InUse: return kRuntimeInUse;
    case CopyResult::Failed:
      // An interrupted earlier swap that could not be restored leaves no
      // active runtime: never keep a task pointing at a missing core. The
      // files stay so the next setup can still recover them.
      if (std::error_code error; !fs::exists(coreBin / L"shardcore.exe", error))
        removeOwnTask(sid);
      return kCopyFailed;
  }
  ComPtr<ITaskService> service;
  ComPtr<ITaskFolder> folder;
  HRESULT hr = connect(service);
  if (SUCCEEDED(hr))
    hr = shardFolder(service.p, folder, true);
  if (SUCCEEDED(hr)) {
    // Only SYSTEM and administrators may change the task; the user may read
    // and run it (that is what avoids the UAC prompt on each launch).
    VARIANT sddl;
    VariantInit(&sddl);
    sddl.vt = VT_BSTR;
    sddl.bstrVal = SysAllocString((L"D:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;GRGX;;;" + sid + L")").c_str());
    ComPtr<IRegisteredTask> registered;
    hr = folder->RegisterTask(Bstr(taskName(sid)).value, Bstr(taskXml(args, sid, coreBin)).value,
                              TASK_CREATE_OR_UPDATE, emptyVariant(), emptyVariant(), TASK_LOGON_INTERACTIVE_TOKEN,
                              sddl, registered.put());
    VariantClear(&sddl);
  }
  int code = SUCCEEDED(hr) ? kOk : kRegisterFailed;
  if (code == kOk) {
    const nlohmann::json status = statusJson(args);
    if (!status.value("current", false)) {
      diagnostic("installed task is not current:", status["reason"].is_string() ? status["reason"].get<std::string>() : "");
      code = kVerifyFailed;
    }
  }
  // Transactional: the app keeps the setting off, so nothing of this
  // install may stay behind (the previous copy was already replaced).
  if (code != kOk)
    removeOwnInstall(sid);
  return code;
}

int modeUninstallElevated(const Args& args)
{
  std::wstring sid;
  if (const int code = checkElevatedIdentity(args, sid); code != kOk)
    return code;
  ComSession com;
  if (!com.ok)
    return kComFailed;
  return removeOwnInstall(sid) ? kOk : kRemoveFailed;
}

int modeInstallOrUninstall(const Args& args, bool install)
{
  if (install && !argsComplete(args))
    return kBadArgs;
  const std::wstring sid = userSid();
  if (!install) {
    ComSession com;
    std::error_code error;
    // Nothing to remove: never show a UAC prompt for it.
    if (com.ok && !queryTask(sid).present && !fs::exists(protectedRoot(sid), error)) {
      report({{"ok", true}, {"changed", false}});
      return kOk;
    }
  }
  Args forwarded = args;
  forwarded.expectedSid = sid;
  int code = kOk;
  switch (priorityElevationFor(processElevated(), tokenElevationType())) {
    case PriorityElevation::AlreadyElevated:
      code = install ? modeInstallElevated(forwarded) : modeUninstallElevated(forwarded);
      break;
    case PriorityElevation::SelfElevate:
      code = sid.empty() ? kComFailed
                         : runElevated(std::wstring(install ? L"--priority-task install-elevated"
                                                            : L"--priority-task uninstall-elevated") +
                                           forwardedArgs(args, sid),
                                       args.parentWindow);
      break;
    case PriorityElevation::StandardUser:
      code = kStandardUser; // no UAC prompt: it could only elevate another account
      break;
  }
  nlohmann::json result = {{"ok", code == kOk}, {"changed", code == kOk}, {"code", code}};
  if (code != kOk)
    result["error"] = exitMessage(code);
  if (install && code == kOk) {
    ComSession com;
    if (com.ok)
      result["status"] = statusJson(args);
  }
  report(result);
  return code;
}

// -------------------------------------------------------------- pipes ----

struct Pipe {
  HANDLE handle = INVALID_HANDLE_VALUE;
  Pipe() = default;
  Pipe(const Pipe&) = delete;
  Pipe& operator=(const Pipe&) = delete;
  ~Pipe()
  {
    if (handle != INVALID_HANDLE_VALUE)
      CloseHandle(handle);
  }
};

std::wstring pipePath(const std::string& base, const wchar_t* suffix)
{
  return L"\\\\.\\pipe\\" + widen(base) + suffix;
}

bool validPipeBase(const std::string& base)
{
  const size_t prefix = std::char_traits<char>::length(kPipePrefix);
  if (base.size() != prefix + 32 || base.compare(0, prefix, kPipePrefix) != 0)
    return false;
  for (size_t i = prefix; i < base.size(); ++i)
    if (!std::isxdigit(static_cast<unsigned char>(base[i])))
      return false;
  return true;
}

std::string randomPipeBase()
{
  std::random_device random; // rand_s on MSVC
  char hex[33];
  for (int i = 0; i < 32; i += 8)
    std::snprintf(hex + i, 9, "%08x", random());
  return std::string(kPipePrefix) + std::string(hex, 32);
}

bool overlappedIo(HANDLE handle, bool write, void* buffer, DWORD size, DWORD& transferred, DWORD timeoutMs = INFINITE)
{
  OVERLAPPED overlapped{};
  overlapped.hEvent = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  BOOL ok = write ? WriteFile(handle, buffer, size, nullptr, &overlapped)
                  : ReadFile(handle, buffer, size, nullptr, &overlapped);
  if (!ok && GetLastError() == ERROR_IO_PENDING) {
    if (WaitForSingleObject(overlapped.hEvent, timeoutMs) != WAIT_OBJECT_0) {
      CancelIoEx(handle, &overlapped);
      GetOverlappedResult(handle, &overlapped, &transferred, TRUE);
      CloseHandle(overlapped.hEvent);
      return false;
    }
    ok = TRUE;
  }
  const bool done = ok && GetOverlappedResult(handle, &overlapped, &transferred, TRUE);
  CloseHandle(overlapped.hEvent);
  return done;
}

bool acceptClient(HANDLE pipe, DWORD timeoutMs)
{
  OVERLAPPED overlapped{};
  overlapped.hEvent = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  bool connected = ConnectNamedPipe(pipe, &overlapped) != FALSE;
  if (!connected) {
    const DWORD error = GetLastError();
    if (error == ERROR_PIPE_CONNECTED) {
      connected = true;
    } else if (error == ERROR_IO_PENDING) {
      DWORD ignored = 0;
      if (WaitForSingleObject(overlapped.hEvent, timeoutMs) == WAIT_OBJECT_0)
        connected = GetOverlappedResult(pipe, &overlapped, &ignored, FALSE) != FALSE;
      else {
        CancelIoEx(pipe, &overlapped);
        GetOverlappedResult(pipe, &overlapped, &ignored, TRUE);
      }
    }
  }
  CloseHandle(overlapped.hEvent);
  return connected;
}

std::wstring processImage(DWORD pid)
{
  HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
  if (!process)
    return {};
  std::vector<wchar_t> buffer(32768);
  DWORD size = static_cast<DWORD>(buffer.size());
  std::wstring image;
  if (QueryFullProcessImageNameW(process, 0, buffer.data(), &size))
    image.assign(buffer.data(), size);
  CloseHandle(process);
  return image;
}

void relay(HANDLE from, HANDLE to)
{
  std::vector<char> buffer(16384);
  for (;;) {
    DWORD read = 0;
    if (!overlappedIo(from, false, buffer.data(), static_cast<DWORD>(buffer.size()), read) || !read)
      return;
    DWORD written = 0;
    WriteFile(to, buffer.data(), read, &written, nullptr);
  }
}

int fallback(const char* reason)
{
  std::printf("PRIORITY FALLBACK %s\n", reason);
  std::fflush(stdout);
  diagnostic("starting the elevated core is not possible:", reason);
  return kPriorityFallbackExit;
}

// Non-elevated stand-in for the core process. Electron spawns it exactly
// like the core: stdout carries SUPERVISOR READY/PORT, stderr the log, stdin
// the terminate request, and the exit code is the elevated tree's.
int modeBridge(const Args& args)
{
  if (!argsComplete(args))
    return fallback("invalid_arguments");
  ComSession com;
  if (!com.ok)
    return fallback("com_unavailable");
  const nlohmann::json status = statusJson(args);
  if (!status.value("current", false))
    return fallback(status["reason"].is_string() ? status["reason"].get<std::string>().c_str() : "not_installed");

  const std::string base = randomPipeBase();
  Pipe control, out, err;
  const DWORD flags = FILE_FLAG_FIRST_PIPE_INSTANCE | FILE_FLAG_OVERLAPPED;
  const DWORD type = PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS;
  control.handle = CreateNamedPipeW(pipePath(base, L"-ctl").c_str(), PIPE_ACCESS_DUPLEX | flags, type, 1, 4096, 4096, 0, nullptr);
  out.handle = CreateNamedPipeW(pipePath(base, L"-out").c_str(), PIPE_ACCESS_INBOUND | flags, type, 1, 0, 65536, 0, nullptr);
  err.handle = CreateNamedPipeW(pipePath(base, L"-err").c_str(), PIPE_ACCESS_INBOUND | flags, type, 1, 0, 65536, 0, nullptr);
  if (control.handle == INVALID_HANDLE_VALUE || out.handle == INVALID_HANDLE_VALUE || err.handle == INVALID_HANDLE_VALUE)
    return fallback("pipe_create_failed");

  {
    ComPtr<ITaskService> service;
    ComPtr<ITaskFolder> folder;
    ComPtr<IRegisteredTask> task;
    ComPtr<IRunningTask> running;
    VARIANT parameter;
    VariantInit(&parameter);
    parameter.vt = VT_BSTR;
    parameter.bstrVal = SysAllocString(widen(base).c_str());
    const bool started = SUCCEEDED(connect(service)) && SUCCEEDED(shardFolder(service.p, folder, false)) &&
                         SUCCEEDED(folder->GetTask(Bstr(taskName(userSid())).value, task.put())) &&
                         SUCCEEDED(task->Run(parameter, running.put()));
    VariantClear(&parameter);
    if (!started)
      return fallback("task_start_failed");
  }
  // The elevated supervisor connects all three pipes right after launch.
  if (!acceptClient(control.handle, 20000) || !acceptClient(out.handle, 5000) || !acceptClient(err.handle, 5000))
    return fallback("elevated_core_did_not_connect");
  ULONG clientPid = 0;
  const fs::path expected = protectedCoreBin(userSid()) / L"shardcore.exe";
  if (!GetNamedPipeClientProcessId(control.handle, &clientPid) ||
      lower(processImage(clientPid)) != lower(expected.wstring()))
    return fallback("unexpected_pipe_client");

  std::thread stdoutRelay(relay, out.handle, GetStdHandle(STD_OUTPUT_HANDLE));
  std::thread stderrRelay(relay, err.handle, GetStdHandle(STD_ERROR_HANDLE));
  // Any stdin data (Electron's "terminate") or a closed stdin pipe (Electron
  // gone) forwards a terminate request; the elevated supervisor then ends its
  // tree. Mirrors the normal supervisor, which only watches a pipe.
  HANDLE controlHandle = control.handle;
  HANDLE input = GetStdHandle(STD_INPUT_HANDLE);
  if (input && input != INVALID_HANDLE_VALUE && GetFileType(input) == FILE_TYPE_PIPE) {
    std::thread([controlHandle, input] {
      char byte = 0;
      DWORD read = 0;
      ReadFile(input, &byte, 1, &read, nullptr);
      char request[] = "terminate\n";
      DWORD written = 0;
      overlappedIo(controlHandle, true, request, sizeof(request) - 1, written, 5000);
    }).detach();
  }

  // The supervisor reports "EXIT <code>" after its whole job has exited.
  std::string received;
  int exitCode = supervisorFailure;
  for (;;) {
    char buffer[64];
    DWORD read = 0;
    if (!overlappedIo(control.handle, false, buffer, sizeof(buffer), read) || !read)
      break;
    received.append(buffer, read);
    const size_t at = received.find("EXIT ");
    const size_t newline = at == std::string::npos ? std::string::npos : received.find('\n', at);
    if (newline != std::string::npos) {
      exitCode = std::atoi(received.c_str() + at + 5);
      break;
    }
  }
  stdoutRelay.join();
  stderrRelay.join();
  return exitCode;
}

HANDLE openPipe(const std::wstring& path, DWORD access)
{
  if (!WaitNamedPipeW(path.c_str(), 10000))
    return INVALID_HANDLE_VALUE;
  // Identification only: a squatting pipe server cannot impersonate this
  // elevated client.
  return CreateFileW(path.c_str(), access, 0, nullptr, OPEN_EXISTING, SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION,
                     nullptr);
}

// Started by Task Scheduler with the user's elevated token and no stdio.
int modeRun(const Args& args)
{
  hardenElevatedDllSearch();
  if (!validPipeBase(args.pipe) || !argsComplete(args))
    return kBadArgs;
  Pipe control, out, err;
  control.handle = openPipe(pipePath(args.pipe, L"-ctl"), GENERIC_READ | GENERIC_WRITE);
  out.handle = openPipe(pipePath(args.pipe, L"-out"), GENERIC_WRITE);
  err.handle = openPipe(pipePath(args.pipe, L"-err"), GENERIC_WRITE);
  if (control.handle == INVALID_HANDLE_VALUE || out.handle == INVALID_HANDLE_VALUE || err.handle == INVALID_HANDLE_VALUE)
    return kPipeFailed;
  SupervisorIo io;
  io.input = control.handle;
  io.output = out.handle;
  io.error = err.handle;
  io.command = quoted(modulePath()) + L" --config-dir " + quoted(args.configDir) + L" --core-bin " +
               quoted(args.coreBin) + L" --games " + quoted(args.games) +
               L" --port 0 --launch-mode task --shard-supervised";
  io.reportExit = true;
  return superviseProcessTree(io);
}

} // namespace

std::optional<int> runPriorityMode(int, char**)
{
  const auto args = parseArgs();
  if (!args)
    return std::nullopt;
  if (args->mode == "status")
    return modeStatus(*args);
  if (args->mode == "install")
    return modeInstallOrUninstall(*args, true);
  if (args->mode == "uninstall")
    return modeInstallOrUninstall(*args, false);
  if (args->mode == "install-elevated")
    return modeInstallElevated(*args);
  if (args->mode == "uninstall-elevated")
    return modeUninstallElevated(*args);
  if (args->mode == "bridge")
    return modeBridge(*args);
  if (args->mode == "run")
    return modeRun(*args);
  return static_cast<int>(kBadArgs);
}

void hardenElevatedDllSearch()
{
  SetDefaultDllDirectories(LOAD_LIBRARY_SEARCH_DEFAULT_DIRS);
  SetDllDirectoryW(L"");
}

bool interactiveUserCanWrite(const char* dir)
{
  if (!processElevated())
    return true; // the OS already enforces the user's own rights
  HANDLE token = nullptr;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token))
    return false;
  TOKEN_ELEVATION_TYPE elevationType = TokenElevationTypeDefault;
  DWORD size = 0;
  GetTokenInformation(token, TokenElevationType, &elevationType, sizeof(elevationType), &size);
  if (elevationType != TokenElevationTypeFull) {
    // No UAC split (UAC off, built-in Administrator): the elevated token is
    // the user's own, so there is nothing more restrictive to check against.
    CloseHandle(token);
    return true;
  }
  TOKEN_LINKED_TOKEN linked{};
  const bool haveLinked = GetTokenInformation(token, TokenLinkedToken, &linked, sizeof(linked), &size) != FALSE;
  CloseHandle(token);
  if (!haveLinked || !linked.LinkedToken)
    return false;
  std::error_code error;
  fs::path path = fs::path(widen(dir));
  DWORD desired = FILE_ADD_FILE;
  while (!path.empty() && !fs::exists(path, error)) {
    desired = FILE_ADD_SUBDIRECTORY;
    const fs::path parent = path.parent_path();
    if (parent == path)
      break;
    path = parent;
  }
  bool allowed = false;
  PSECURITY_DESCRIPTOR descriptor = nullptr;
  if (!path.empty() &&
      GetNamedSecurityInfoW(path.c_str(), SE_FILE_OBJECT,
                            OWNER_SECURITY_INFORMATION | GROUP_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION |
                                LABEL_SECURITY_INFORMATION,
                            nullptr, nullptr, nullptr, nullptr, &descriptor) == ERROR_SUCCESS) {
    GENERIC_MAPPING mapping = {FILE_GENERIC_READ, FILE_GENERIC_WRITE, FILE_GENERIC_EXECUTE, FILE_ALL_ACCESS};
    PRIVILEGE_SET privileges{};
    DWORD privilegesSize = sizeof(privileges);
    DWORD granted = 0;
    BOOL status = FALSE;
    allowed = AccessCheck(descriptor, linked.LinkedToken, desired, &mapping, &privileges, &privilegesSize, &granted,
                          &status) &&
              status;
    LocalFree(descriptor);
  }
  CloseHandle(linked.LinkedToken);
  return allowed;
}

#else

std::optional<int> runPriorityMode(int, char**) { return std::nullopt; }
void hardenElevatedDllSearch() {}
bool interactiveUserCanWrite(const char*) { return true; }

#endif

} // namespace shard
