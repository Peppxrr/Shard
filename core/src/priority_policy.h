#pragma once

// Pure Recording priority decisions shared by priority_task.cpp and its
// tests. No Windows, COM or filesystem dependency.

#include <algorithm>
#include <cstdint>
#include <map>
#include <string>
#include <tuple>
#include <vector>

namespace shard {

// How the unelevated install helper may obtain an elevated token for the
// signed-in user. Mirrors TOKEN_ELEVATION_TYPE (1 default, 2 full, 3 limited).
enum class PriorityElevation {
  AlreadyElevated, // this process already runs elevated as the user
  SelfElevate,     // UAC split token: consent elevates the same account
  StandardUser,    // UAC would ask for another account's credentials
};

inline PriorityElevation priorityElevationFor(bool elevated, int elevationType)
{
  if (elevated)
    return PriorityElevation::AlreadyElevated;
  // Only a limited (split) token has a linked full token of the same user.
  // A non-elevated default token is a standard user (or UAC is off for a
  // standard user): "runas" would run under a different administrator SID,
  // whose task and protected runtime this user could never start.
  return elevationType == 3 ? PriorityElevation::SelfElevate : PriorityElevation::StandardUser;
}

// The elevated helper only acts for the account that requested it. A
// mismatch means UAC elevated a different (over-the-shoulder) account.
inline bool elevatedHelperIdentityOk(const std::string& expectedSid, const std::string& actualSid)
{
  return !expectedSid.empty() && expectedSid == actualSid;
}

struct RuntimeEntry {
  std::string path; // relative, generic separators
  uintmax_t size = 0;
  int64_t modified = 0; // last write time (file_time_type ticks)
};

// Directory enumeration order is unspecified; manifests and comparisons use
// path order.
inline void sortRuntimeEntries(std::vector<RuntimeEntry>& entries)
{
  std::sort(entries.begin(), entries.end(),
            [](const RuntimeEntry& a, const RuntimeEntry& b) { return a.path < b.path; });
}

// Same files with the same size and timestamp, regardless of order.
inline bool sameRuntimeFiles(std::vector<RuntimeEntry> a, std::vector<RuntimeEntry> b)
{
  if (a.size() != b.size())
    return false;
  sortRuntimeEntries(a);
  sortRuntimeEntries(b);
  return std::equal(a.begin(), a.end(), b.begin(), [](const RuntimeEntry& x, const RuntimeEntry& y) {
    return std::tie(x.path, x.size, x.modified) == std::tie(y.path, y.size, y.modified);
  });
}

// What to do with leftovers of a runtime swap before staging a new copy.
// The swap is: active -> ".old", ".staging" -> active, remove ".old".
enum class RuntimeSwapRecovery {
  None,       // no ".old"
  RestoreOld, // interrupted between the two renames: ".old" is the last known-good copy
  DiscardOld, // the swap completed; ".old" is a leftover of its cleanup
};

inline RuntimeSwapRecovery runtimeSwapRecovery(bool activeExists, bool oldExists)
{
  if (!oldExists)
    return RuntimeSwapRecovery::None;
  return activeExists ? RuntimeSwapRecovery::DiscardOld : RuntimeSwapRecovery::RestoreOld;
}

// Empty when every manifest file exists in the protected copy with the
// recorded size and the copy holds no file the manifest does not list;
// otherwise "runtime_copy_invalid" (deleted DLL, truncated/interrupted copy).
inline std::string runtimeCopyProblem(const std::vector<RuntimeEntry>& manifest, const std::vector<RuntimeEntry>& copy)
{
  if (manifest.empty())
    return "runtime_copy_invalid";
  std::map<std::string, uintmax_t> present;
  for (const auto& file : copy)
    present[file.path] = file.size;
  for (const auto& file : manifest) {
    const auto it = present.find(file.path);
    if (it == present.end() || it->second != file.size)
      return "runtime_copy_invalid";
    present.erase(it);
  }
  return present.empty() ? std::string() : "runtime_copy_invalid";
}

} // namespace shard
