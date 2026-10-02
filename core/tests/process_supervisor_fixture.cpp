#include "../src/process-supervisor.h"
int main(int argc, char** argv) {
  if (argc > 1 && std::strcmp(argv[1], "--fail-setup") == 0) SetStdHandle(STD_OUTPUT_HANDLE, nullptr);
  if (argc > 1 && std::strcmp(argv[1], "--leaf") == 0) { Sleep(INFINITE); return 0; }
  if (!shard::isSupervisedChild(argc, argv)) return shard::superviseProcessTree();
  wchar_t path[32768]; GetModuleFileNameW(nullptr, path, 32768);
  std::wstring command = L"\"" + std::wstring(path) + L"\" --leaf";
  STARTUPINFOW startup{}; startup.cb=sizeof(startup); PROCESS_INFORMATION leaf{};
  if (!CreateProcessW(path, command.data(), nullptr, nullptr, FALSE, 0, nullptr, nullptr, &startup, &leaf)) return 126;
  std::printf("LEAF %lu\n",leaf.dwProcessId); std::fflush(stdout);
  CloseHandle(leaf.hProcess); CloseHandle(leaf.hThread);
  if (argc > 1 && std::strcmp(argv[1], "--hang") == 0) Sleep(INFINITE);
  return 17;
}
