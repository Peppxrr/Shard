#pragma once
#ifdef _WIN32
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>
namespace shard {
inline constexpr int supervisorFailure = 125;
struct OwnedHandle { HANDLE value = nullptr; ~OwnedHandle() { if (value && value != INVALID_HANDLE_VALUE) CloseHandle(value); } };
inline bool isSupervisedChild(int argc, char** argv) {
  for (int i = 1; i < argc; ++i) if (std::strcmp(argv[i], "--shard-supervised") == 0) return true;
  return false;
}
// Where the supervisor's control channel and the core's output go. The normal
// launch uses this process's standard handles; the Recording priority launch
// (started by Task Scheduler, without inherited stdio) uses named pipes to
// the non-elevated bridge.
struct SupervisorIo {
  HANDLE input = nullptr;  // parent control: data or a broken pipe force-terminates the tree
  HANDLE output = nullptr; // inherited by the core as stdout (PORT line)
  HANDLE error = nullptr;  // inherited by the core as stderr
  std::wstring command;    // core command line; must contain --shard-supervised
  bool reportExit = false; // write "EXIT <code>\n" to `input` before returning
};
inline void supervisorWrite(HANDLE handle, const char* text) {
  if (!handle || handle == INVALID_HANDLE_VALUE) return;
  DWORD written = 0;
  WriteFile(handle, text, static_cast<DWORD>(std::strlen(text)), &written, nullptr);
}
inline int superviseProcessTreeWith(const SupervisorIo& io) {
  auto fail = [&io](const char* step) {
    const DWORD error = GetLastError();
    char text[160];
    std::snprintf(text, sizeof(text), "shardcore supervisor: %s failed (%lu); tree exit unproven\n", step, error);
    supervisorWrite(io.error, text);
    return supervisorFailure;
  };
  OwnedHandle job{CreateJobObjectW(nullptr, nullptr)};
  if (!job.value) return fail("CreateJobObject");
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  if (!SetInformationJobObject(job.value, JobObjectExtendedLimitInformation, &limits, sizeof(limits))) return fail("job limits");
  OwnedHandle port{CreateIoCompletionPort(INVALID_HANDLE_VALUE, nullptr, 0, 1)};
  if (!port.value) return fail("completion port");
  JOBOBJECT_ASSOCIATE_COMPLETION_PORT association{job.value, port.value};
  if (!SetInformationJobObject(job.value, JobObjectAssociateCompletionPortInformation, &association, sizeof(association))) return fail("associate port");
  std::vector<wchar_t> executable(32768);
  DWORD length = GetModuleFileNameW(nullptr, executable.data(), static_cast<DWORD>(executable.size()));
  if (!length || length >= executable.size()) return fail("executable path");
  // Keep the original Windows quoting and Unicode arguments.
  std::wstring command = io.command;
  OwnedHandle output, error;
  auto duplicate = [](HANDLE from, OwnedHandle& to) {
    return from && from != INVALID_HANDLE_VALUE && DuplicateHandle(GetCurrentProcess(), from, GetCurrentProcess(), &to.value, 0, TRUE, DUPLICATE_SAME_ACCESS);
  };
  if (!duplicate(io.output, output) || !duplicate(io.error, error)) return fail("output handles");
  SECURITY_ATTRIBUTES security{sizeof(security), nullptr, TRUE};
  OwnedHandle input{CreateFileW(L"NUL", GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, &security, OPEN_EXISTING, 0, nullptr)};
  if (input.value == INVALID_HANDLE_VALUE) return fail("child stdin");
  HANDLE inherited[] = {input.value, output.value, error.value};
  SIZE_T bytes = 0; InitializeProcThreadAttributeList(nullptr, 1, 0, &bytes);
  std::vector<unsigned char> storage(bytes);
  auto attributes = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(storage.data());
  if (!InitializeProcThreadAttributeList(attributes, 1, 0, &bytes)) return fail("handle attributes");
  struct Cleanup { LPPROC_THREAD_ATTRIBUTE_LIST value; ~Cleanup() { DeleteProcThreadAttributeList(value); } } cleanup{attributes};
  if (!UpdateProcThreadAttribute(attributes, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, inherited, sizeof(inherited), nullptr, nullptr)) return fail("restrict inheritance");
  STARTUPINFOEXW startup{}; startup.StartupInfo.cb = sizeof(startup);
  startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
  startup.StartupInfo.hStdInput = input.value; startup.StartupInfo.hStdOutput = output.value; startup.StartupInfo.hStdError = error.value;
  startup.lpAttributeList = attributes;
  PROCESS_INFORMATION process{};
  if (!CreateProcessW(executable.data(), command.data(), nullptr, nullptr, TRUE, CREATE_SUSPENDED | CREATE_NO_WINDOW | EXTENDED_STARTUPINFO_PRESENT, nullptr, nullptr, &startup.StartupInfo, &process)) return fail("CreateProcess");
  OwnedHandle root{process.hProcess}, thread{process.hThread};
  if (!AssignProcessToJobObject(job.value, root.value)) {
    DWORD saved = GetLastError(); TerminateProcess(root.value, supervisorFailure); WaitForSingleObject(root.value, 5000); SetLastError(saved); return fail("AssignProcessToJobObject");
  }
  if (ResumeThread(thread.value) == static_cast<DWORD>(-1)) { TerminateJobObject(job.value, supervisorFailure); return fail("ResumeThread"); }
  supervisorWrite(io.output, "SUPERVISOR READY\n");
  HANDLE parentInput = io.input;
  bool watchParent = parentInput && parentInput != INVALID_HANDLE_VALUE && GetFileType(parentInput) == FILE_TYPE_PIPE;
  bool forced = false;
  for (;;) {
    DWORD wait = WaitForSingleObject(root.value, 50);
    if (wait == WAIT_OBJECT_0) break;
    if (wait == WAIT_FAILED) return fail("root wait");
    if (watchParent) { DWORD available = 0; if (!PeekNamedPipe(parentInput, nullptr, 0, nullptr, &available, nullptr) || available) { forced = true; break; } }
  }
  // Helpers remaining after normal root exit are owned descendants too.
  if (!TerminateJobObject(job.value, forced ? 1 : 0)) return fail("TerminateJobObject");
  ULONGLONG deadline = GetTickCount64() + 5000;
  for (;;) {
    JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting{};
    if (!QueryInformationJobObject(job.value, JobObjectBasicAccountingInformation, &accounting, sizeof(accounting), nullptr)) return fail("active process query");
    if (!accounting.ActiveProcesses) break;
    if (GetTickCount64() >= deadline) { SetLastError(WAIT_TIMEOUT); return fail("bounded tree exit"); }
    DWORD message; ULONG_PTR key; LPOVERLAPPED overlapped;
    GetQueuedCompletionStatus(port.value, &message, &key, &overlapped, 50);
  }
  DWORD exitCode = 0;
  DWORD remaining = GetTickCount64() < deadline ? static_cast<DWORD>(deadline - GetTickCount64()) : 0;
  if (WaitForSingleObject(root.value, remaining) != WAIT_OBJECT_0 || !GetExitCodeProcess(root.value, &exitCode)) return fail("exit code");
  supervisorWrite(io.error, forced ? "shardcore supervisor: process tree exited (forced)\n" : "shardcore supervisor: process tree exited\n");
  return static_cast<int>(exitCode);
}
inline int superviseProcessTree(const SupervisorIo& io) {
  const int code = superviseProcessTreeWith(io);
  if (io.reportExit) {
    char text[32];
    std::snprintf(text, sizeof(text), "EXIT %d\n", code);
    supervisorWrite(io.input, text);
  }
  return code;
}
inline int superviseProcessTree() {
  SupervisorIo io;
  io.input = GetStdHandle(STD_INPUT_HANDLE);
  io.output = GetStdHandle(STD_OUTPUT_HANDLE);
  io.error = GetStdHandle(STD_ERROR_HANDLE);
  io.command = std::wstring(GetCommandLineW()) + L" --shard-supervised";
  return superviseProcessTree(io);
}
}
#endif
