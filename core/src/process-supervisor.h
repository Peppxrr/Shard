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
inline int superviseProcessTree() {
  auto fail = [](const char* step) {
    std::fprintf(stderr, "shardcore supervisor: %s failed (%lu); tree exit unproven\n", step, GetLastError());
    std::fflush(stderr); return supervisorFailure;
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
  std::wstring command = GetCommandLineW(); command += L" --shard-supervised";
  OwnedHandle output, error;
  auto duplicate = [](DWORD id, OwnedHandle& to) {
    HANDLE from = GetStdHandle(id);
    return from && from != INVALID_HANDLE_VALUE && DuplicateHandle(GetCurrentProcess(), from, GetCurrentProcess(), &to.value, 0, TRUE, DUPLICATE_SAME_ACCESS);
  };
  if (!duplicate(STD_OUTPUT_HANDLE, output) || !duplicate(STD_ERROR_HANDLE, error)) return fail("output handles");
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
  std::printf("SUPERVISOR READY\n"); std::fflush(stdout);
  HANDLE parentInput = GetStdHandle(STD_INPUT_HANDLE);
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
  std::fprintf(stderr, "shardcore supervisor: process tree exited%s\n", forced ? " (forced)" : ""); std::fflush(stderr);
  return static_cast<int>(exitCode);
}
}
#endif
