#include "priority_runtime.h"

#include <nlohmann/json.hpp>

#include <cstdio>
#include <cwctype>
#include <fstream>

namespace shard {

namespace fs = std::filesystem;

namespace {

void diagnostic(const char* message, const std::string& detail = {})
{
  std::fprintf(stderr, "[priority] %s%s%s\n", message, detail.empty() ? "" : " ", detail.c_str());
  std::fflush(stderr);
}

std::string utf8(const std::u8string& text)
{
  return std::string(text.begin(), text.end());
}

fs::path fromUtf8(const std::string& text)
{
  return fs::path(std::u8string(text.begin(), text.end()));
}

std::wstring lowerName(const fs::path& path)
{
  std::wstring name = path.filename().wstring();
  for (auto& c : name)
    c = static_cast<wchar_t>(std::towlower(c));
  return name;
}

bool excludedFromCopy(const fs::path& relative)
{
  const std::wstring name = lowerName(relative);
  // The editor's FFmpeg tools are not part of the core runtime.
  return name == L"ffmpeg.exe" || name == L"ffprobe.exe" || lowerName(relative.extension()) == L".pdb" ||
         name == fs::path(kRuntimeManifestName).wstring();
}

nlohmann::json manifestJson(const std::vector<RuntimeEntry>& files, const fs::path& source)
{
  nlohmann::json list = nlohmann::json::array();
  for (const auto& file : files)
    list.push_back({{"path", file.path}, {"size", file.size}, {"modified", file.modified}});
  return {{"source", utf8(source.u8string())}, {"files", list}};
}

fs::path sibling(const fs::path& destination, const char* suffix)
{
  fs::path path = destination;
  path += suffix;
  return path;
}

} // namespace

std::vector<RuntimeEntry> listRuntime(const fs::path& root, std::error_code& error)
{
  std::vector<RuntimeEntry> files;
  for (fs::recursive_directory_iterator it(root, error), end; !error && it != end; it.increment(error)) {
    if (!it->is_regular_file(error))
      continue;
    const fs::path relative = fs::relative(it->path(), root, error);
    if (error || excludedFromCopy(relative))
      continue;
    RuntimeEntry file;
    file.path = utf8(relative.generic_u8string());
    file.size = it->file_size(error);
    file.modified = static_cast<int64_t>(it->last_write_time(error).time_since_epoch().count());
    files.push_back(std::move(file));
  }
  sortRuntimeEntries(files);
  return files;
}

// Sizes, not hashes: the copy is administrators-only, so this catches
// deletion, truncation and interrupted copies without hashing the runtime on
// every launch.
std::string runtimeFreshness(const fs::path& sourceCoreBin, const fs::path& copy)
{
  std::ifstream manifestFile(copy / kRuntimeManifestName);
  if (!manifestFile)
    return "runtime_copy_missing";
  const nlohmann::json manifest = nlohmann::json::parse(manifestFile, nullptr, false);
  if (manifest.is_discarded() || !manifest.contains("files") || !manifest["files"].is_array())
    return "runtime_copy_invalid";
  std::vector<RuntimeEntry> listed;
  for (const auto& file : manifest["files"]) {
    if (!file.is_object() || !file.contains("path") || !file["path"].is_string() || !file.contains("size") ||
        !file["size"].is_number_unsigned() || !file.contains("modified") || !file["modified"].is_number_integer())
      return "runtime_copy_invalid";
    listed.push_back({file["path"].get<std::string>(), file["size"].get<uintmax_t>(), file["modified"].get<int64_t>()});
  }
  std::error_code error;
  const auto copied = listRuntime(copy, error);
  if (error)
    return "runtime_copy_invalid";
  if (std::string problem = runtimeCopyProblem(listed, copied); !problem.empty())
    return problem;
  const auto source = listRuntime(sourceCoreBin, error);
  if (error)
    return "source_runtime_unreadable";
  if (!sameRuntimeFiles(listed, source))
    return "runtime_changed"; // e.g. Shard updated since registration
  return {};
}

CopyResult copyRuntime(const fs::path& source, const fs::path& destination)
{
  std::error_code error;
  const fs::path staging = sibling(destination, ".staging");
  const fs::path previous = sibling(destination, ".old");

  // Leftovers of an interrupted swap. Recovery comes first and does not depend
  // on the source, so a failing copy below still leaves a usable runtime.
  const bool activeExists = fs::exists(destination, error);
  switch (runtimeSwapRecovery(activeExists, fs::exists(previous, error))) {
    case RuntimeSwapRecovery::None: break;
    case RuntimeSwapRecovery::RestoreOld:
      fs::rename(previous, destination, error);
      if (error) {
        diagnostic("cannot restore the previous runtime copy after an interrupted setup:", error.message());
        return CopyResult::Failed;
      }
      diagnostic("restored the previous runtime copy after an interrupted setup");
      break;
    case RuntimeSwapRecovery::DiscardOld:
      fs::remove_all(previous, error);
      if (fs::exists(previous, error)) {
        diagnostic("cannot remove a leftover runtime copy", utf8(previous.u8string()));
        return CopyResult::Failed;
      }
      break;
  }
  fs::remove_all(staging, error); // incomplete by definition: never activated
  error.clear();

  const auto files = listRuntime(source, error);
  if (error || files.empty()) {
    diagnostic("cannot read core runtime", utf8(source.u8string()));
    return CopyResult::Failed;
  }
  for (const auto& file : files) {
    const fs::path relative = fromUtf8(file.path);
    const fs::path target = staging / relative;
    fs::create_directories(target.parent_path(), error);
    if (error || !fs::copy_file(source / relative, target, fs::copy_options::overwrite_existing, error) ||
        fs::file_size(target, error) != file.size) {
      diagnostic("copy failed", utf8(relative.u8string()) + ": " + error.message());
      fs::remove_all(staging, error);
      return CopyResult::Failed;
    }
  }
  {
    // Written last: a staging directory without a manifest is incomplete.
    std::ofstream manifest(staging / kRuntimeManifestName, std::ios::binary | std::ios::trunc);
    manifest << manifestJson(files, source).dump();
    if (!manifest.flush()) {
      manifest.close();
      fs::remove_all(staging, error);
      return CopyResult::Failed;
    }
  }
  if (fs::exists(destination, error)) {
    // Windows refuses to rename a directory while files in it are open, so a
    // running elevated core keeps its copy and is reported, not half-deleted.
    fs::rename(destination, previous, error);
    if (error) {
      diagnostic("cannot replace the previous runtime copy (is an elevated core still running?)", error.message());
      fs::remove_all(staging, error);
      return CopyResult::InUse;
    }
  }
  fs::rename(staging, destination, error);
  if (error) {
    diagnostic("cannot activate the new runtime copy", error.message());
    std::error_code ignored;
    fs::rename(previous, destination, ignored);
    fs::remove_all(staging, ignored);
    return CopyResult::Failed;
  }
  fs::remove_all(previous, error); // best effort; a leftover is discarded on the next install
  return CopyResult::Ok;
}

} // namespace shard
