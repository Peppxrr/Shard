// Recording priority setup decisions: who may install, and when a protected
// runtime copy no longer matches its manifest.
#undef NDEBUG
#include "priority_policy.h"

#include <cassert>
#include <cstdio>

using namespace shard;

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

  std::puts("priority policy tests passed");
  return 0;
}
