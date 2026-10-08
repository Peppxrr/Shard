#pragma once

// The Recording priority task's protected runtime copy: listing, manifest,
// freshness and the transactional copy/swap. Portable std::filesystem code
// (no COM/UAC), so it is tested directly against temporary directories.

#include "priority_policy.h"

#include <filesystem>
#include <string>
#include <system_error>
#include <vector>

namespace shard {

inline constexpr const char* kRuntimeManifestName = "shard-priority-manifest.json";

// Core runtime files under `root`, sorted by relative path. Excludes the
// editor's FFmpeg tools, PDBs and the manifest itself.
std::vector<RuntimeEntry> listRuntime(const std::filesystem::path& root, std::error_code& error);

// Empty when the protected `copy` still holds every file its manifest lists
// at the recorded size (else "runtime_copy_invalid"/"runtime_copy_missing")
// and the manifest matches `sourceCoreBin` file for file, in any order (else
// "runtime_changed"/"source_runtime_unreadable").
std::string runtimeFreshness(const std::filesystem::path& sourceCoreBin, const std::filesystem::path& copy);

enum class CopyResult {
  Ok,
  Failed, // the previous active copy (if any) is intact
  InUse,  // the active copy could not be moved aside (a core runs from it); it is intact
};

// Copies `source` into "<destination>.staging", then swaps it in by rename
// ("<destination>" -> ".old", ".staging" -> "<destination>", remove ".old").
// A swap interrupted between the renames is recovered first by restoring
// ".old", so the last known-good copy is never deleted before a replacement
// is active.
CopyResult copyRuntime(const std::filesystem::path& source, const std::filesystem::path& destination);

} // namespace shard
