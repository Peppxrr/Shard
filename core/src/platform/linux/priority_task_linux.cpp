// Recording priority (elevated scheduled task) is Windows-only: Linux has no
// GPU scheduling priority tied to process elevation, so no mode replaces the
// core and the user always owns the clip folders.
#include "priority_task.h"

namespace shard {

std::optional<int> runPriorityMode(int, char**)
{
  return std::nullopt;
}

void hardenElevatedDllSearch() {}

bool interactiveUserCanWrite(const char*)
{
  return true;
}

} // namespace shard
