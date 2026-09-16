#pragma once

#include "game_util.h"

#include <string>

namespace shard {

// Editor identity is separate from engine identity: Play mode and preview
// surfaces can load the same graphics/input/runtime libraries as shipped games.
// Never reject a game merely because its title or parent mentions an editor.
inline bool isEditorProcess(const std::string& exe, const std::string& commandLine,
                            const std::string& windowClass = {})
{
  const std::string name = toLower(exe);
  const std::string command = toLower(commandLine);
  const std::string cls = toLower(windowClass);
  if (name == "unity.exe" || cls == "unitycontainerwndclass")
    return true;
  if (name == "unrealeditor.exe" || name == "unrealeditor-cmd.exe" ||
      name == "ue4editor.exe" || name == "ue4editor-cmd.exe")
    return true;
  // Godot ships an editor/player in one executable. Only its explicit editor
  // invocation is negative evidence; exported players remain eligible.
  if (name.rfind("godot", 0) == 0) {
    const std::string args = " " + command + " ";
    return args.find(" --editor ") != std::string::npos ||
           args.find(" -e ") != std::string::npos ||
           args.find(" --project-manager ") != std::string::npos;
  }
  return false;
}

} // namespace shard
