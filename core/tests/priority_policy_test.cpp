// Recording priority setup decisions (who may install) and the protected
// runtime copy: manifest validation, order-independent freshness and
// transactional swap recovery, exercised against temporary directories.
#undef NDEBUG
#include "priority_policy.h"
#include "priority_runtime.h"

#include <nlohmann/json.hpp>

#include <algorithm>
#include <cassert>
#include <cstdio>
#include <filesystem>
#include <fstream>
#include <random>
#include <string>

using namespace shard;
namespace fs = std::filesystem;

namespace {

void writeFile(const fs::path& path, const std::string& data)
{
  fs::create_directories(path.parent_path());
  std::ofstream(path, std::ios::binary | std::ios::trunc) << data;
}

// Rewrites the copy's manifest with its file list in reverse order, as an
// older Shard (unsorted enumeration) could have written it.
void reverseManifest(const fs::path& copy)
{
  const fs::path file = copy / kRuntimeManifestName;
  nlohmann::json manifest = nlohmann::json::parse(std::ifstream(file));
  auto& files = manifest["files"];
  std::reverse(files.begin(), files.end());
  std::ofstream(file, std::ios::binary | std::ios::trunc) << manifest.dump();
}

void runtimeCopyTests(const fs::path& root)
{
  const fs::path source = root / "core-bin";
  writeFile(source / "shardcore.exe", std::string(1000, 'c'));
  writeFile(source / "obs.dll", std::string(5000, 'o'));
  writeFile(source / "obs-plugins" / "64bit" / "win-capture.dll", std::string(70, 'w'));
  writeFile(source / "ffmpeg.exe", "editor tool");
  writeFile(source / "shardcore.pdb", "symbols");
  const fs::path dest = root / "protected" / "core-bin";
  fs::path old = dest, staging = dest;
  old += ".old";
  staging += ".staging";

  std::error_code error;
  const auto listed = listRuntime(source, error);
  assert(!error && listed.size() == 3); // editor tools and PDBs excluded
  assert(std::is_sorted(listed.begin(), listed.end(),
                        [](const RuntimeEntry& a, const RuntimeEntry& b) { return a.path < b.path; }));

  assert(runtimeFreshness(source, dest) == "runtime_copy_missing");
  assert(copyRuntime(source, dest) == CopyResult::Ok);
  assert(runtimeFreshness(source, dest).empty());
  assert(!fs::exists(dest / "ffmpeg.exe") && !fs::exists(old) && !fs::exists(staging));

  // The same entries in a different order stay current.
  reverseManifest(dest);
  assert(runtimeFreshness(source, dest).empty());

  // Deleted DLL and truncated file in the protected copy.
  fs::remove(dest / "obs.dll");
  assert(runtimeFreshness(source, dest) == "runtime_copy_invalid");
  assert(copyRuntime(source, dest) == CopyResult::Ok && runtimeFreshness(source, dest).empty());
  writeFile(dest / "obs-plugins" / "64bit" / "win-capture.dll", "short");
  assert(runtimeFreshness(source, dest) == "runtime_copy_invalid");
  assert(copyRuntime(source, dest) == CopyResult::Ok && runtimeFreshness(source, dest).empty());

  // Updated source runtime.
  writeFile(source / "obs.dll", std::string(5001, 'o'));
  assert(runtimeFreshness(source, dest) == "runtime_changed");
  assert(copyRuntime(source, dest) == CopyResult::Ok && runtimeFreshness(source, dest).empty());

  // Setup crashed between the two renames (active copy moved to .old, a
  // partial .staging left), and this attempt cannot read the source: the last
  // known-good copy is restored, never deleted.
  fs::rename(dest, old);
  writeFile(staging / "obs.dll", "partial");
  assert(copyRuntime(root / "missing-core-bin", dest) == CopyResult::Failed);
  assert(fs::exists(dest / "shardcore.exe") && !fs::exists(old) && !fs::exists(staging));
  assert(runtimeFreshness(source, dest).empty());

  // The same interruption followed by a working copy completes normally.
  fs::rename(dest, old);
  assert(copyRuntime(source, dest) == CopyResult::Ok);
  assert(runtimeFreshness(source, dest).empty() && !fs::exists(old));

  // A .old beside an active copy is a leftover of a completed swap.
  writeFile(old / "stale.dll", "stale");
  assert(copyRuntime(source, dest) == CopyResult::Ok);
  assert(runtimeFreshness(source, dest).empty() && !fs::exists(old));

#ifdef _WIN32
  // A core running from the active copy keeps its files open: the swap is
  // refused and the running copy stays intact.
  {
    std::ifstream running(dest / "shardcore.exe", std::ios::binary);
    assert(running);
    writeFile(source / "obs.dll", std::string(5002, 'o'));
    assert(copyRuntime(source, dest) == CopyResult::InUse);
    assert(fs::exists(dest / "shardcore.exe") && !fs::exists(old) && !fs::exists(staging));
    assert(runtimeFreshness(source, dest) == "runtime_changed"); // old, intact copy
  }
  assert(copyRuntime(source, dest) == CopyResult::Ok && runtimeFreshness(source, dest).empty());
#endif
}

} // namespace

int main()
{
  // TOKEN_ELEVATION_TYPE: 1 default, 2 full, 3 limited.
  assert(priorityElevationFor(false, 3) == PriorityElevation::SelfElevate); // admin, UAC split token
  assert(priorityElevationFor(true, 2) == PriorityElevation::AlreadyElevated);
  assert(priorityElevationFor(true, 1) == PriorityElevation::AlreadyElevated); // UAC off, administrator
  // A standard user would get an over-the-shoulder prompt for another account.
  assert(priorityElevationFor(false, 1) == PriorityElevation::StandardUser);
  assert(priorityElevationFor(false, 0) == PriorityElevation::StandardUser); // token unreadable

  assert(elevatedHelperIdentityOk("S-1-5-21-1-2-3-1001", "S-1-5-21-1-2-3-1001"));
  assert(!elevatedHelperIdentityOk("S-1-5-21-1-2-3-1001", "S-1-5-21-1-2-3-500")); // other admin elevated
  assert(!elevatedHelperIdentityOk("", "S-1-5-21-1-2-3-1001"));                   // no expected identity

  const std::vector<RuntimeEntry> manifest = {{"shardcore.exe", 1000}, {"obs.dll", 5000}, {"obs-plugins/64bit/x.dll", 70}};
  assert(runtimeCopyProblem(manifest, {{"obs.dll", 5000}, {"shardcore.exe", 1000}, {"obs-plugins/64bit/x.dll", 70}}).empty());
  // Deleted DLL.
  assert(runtimeCopyProblem(manifest, {{"shardcore.exe", 1000}, {"obs-plugins/64bit/x.dll", 70}}) == "runtime_copy_invalid");
  // Truncated (interrupted or corrupted) copy.
  assert(runtimeCopyProblem(manifest, {{"shardcore.exe", 1000}, {"obs.dll", 4096}, {"obs-plugins/64bit/x.dll", 70}}) ==
         "runtime_copy_invalid");
  // A file the manifest never listed.
  assert(runtimeCopyProblem(manifest, {{"shardcore.exe", 1000}, {"obs.dll", 5000}, {"obs-plugins/64bit/x.dll", 70},
                                       {"version.dll", 10}}) == "runtime_copy_invalid");
  assert(runtimeCopyProblem({}, {}) == "runtime_copy_invalid");

  // Freshness compares file sets, not enumeration order.
  const std::vector<RuntimeEntry> sourceFiles = {{"a.dll", 1, 10}, {"b/c.dll", 2, 20}, {"shardcore.exe", 3, 30}};
  assert(sameRuntimeFiles(sourceFiles, {{"shardcore.exe", 3, 30}, {"a.dll", 1, 10}, {"b/c.dll", 2, 20}}));
  assert(!sameRuntimeFiles(sourceFiles, {{"shardcore.exe", 3, 30}, {"a.dll", 1, 11}, {"b/c.dll", 2, 20}}));
  assert(!sameRuntimeFiles(sourceFiles, {{"shardcore.exe", 3, 30}, {"a.dll", 9, 10}, {"b/c.dll", 2, 20}}));
  assert(!sameRuntimeFiles(sourceFiles, {{"shardcore.exe", 3, 30}, {"a.dll", 1, 10}}));

  // Swap leftovers: restore the last known-good copy only when the active one is gone.
  assert(runtimeSwapRecovery(true, false) == RuntimeSwapRecovery::None);
  assert(runtimeSwapRecovery(false, false) == RuntimeSwapRecovery::None);
  assert(runtimeSwapRecovery(false, true) == RuntimeSwapRecovery::RestoreOld);
  assert(runtimeSwapRecovery(true, true) == RuntimeSwapRecovery::DiscardOld);

  std::random_device random;
  const fs::path root = fs::temp_directory_path() / ("shard-priority-test-" + std::to_string(random()));
  fs::remove_all(root);
  runtimeCopyTests(root);
  std::error_code ignored;
  fs::remove_all(root, ignored);

  std::puts("priority policy tests passed");
  return 0;
}
