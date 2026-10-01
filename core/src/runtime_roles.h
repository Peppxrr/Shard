#pragma once

#include "game_util.h"

#include <string>

namespace shard {

// Java and LWJGL/OpenGL are shared by launchers, servers, and desktop tools.
// Recognize the invoked Minecraft client entry point, never a class name merely
// mentioned inside a classpath, JVM property, window title, or launcher argument.
inline bool isMinecraftClientProcess(const std::string& exe, const std::string& commandLine)
{
  const std::string name = toLower(exe);
  if (name != "java.exe" && name != "javaw.exe")
    return false;

  std::vector<std::string> args;
  std::string token;
  bool quoted = false;
  const std::string command = toLower(commandLine);
  for (size_t i = 0; i < command.size(); i++) {
    const char c = command[i];
    if (c == '\\') {
      size_t end = i;
      while (end < command.size() && command[end] == '\\')
        end++;
      const size_t count = end - i;
      if (end < command.size() && command[end] == '"') {
        token.append(count / 2, '\\');
        if (count % 2)
          token.push_back('"');
        else
          quoted = !quoted;
        i = end;
      } else {
        token.append(count, '\\');
        i = end - 1;
      }
    } else if (c == '"') {
      quoted = !quoted;
    } else if (std::isspace((unsigned char)c) && !quoted) {
      if (!token.empty()) {
        args.push_back(std::move(token));
        token.clear();
      }
    } else {
      token.push_back(c);
    }
  }
  if (quoted)
    return false;
  if (!token.empty())
    args.push_back(std::move(token));
  if (args.empty() || baseName(args[0]) != name)
    return false;

  size_t main = 1;
  for (; main < args.size(); main++) {
    const auto& arg = args[main];
    // Do not infer the entry point hidden in a jar, module, or response file.
    if (arg[0] == '@' || arg == "-jar" || arg == "-m" || arg == "--module" ||
        arg.rfind("--module=", 0) == 0)
      return false;
    if (arg[0] != '-')
      break;
    static const char* const kValueOptions[] = {
        "-cp", "-classpath", "--class-path", "-p", "--module-path",
        "--upgrade-module-path", "--add-modules", "--add-exports", "--add-opens",
        "--add-reads", "--patch-module", "--limit-modules", "--enable-native-access", "--source",
    };
    for (const char* option : kValueOptions) {
      if (arg == option) {
        main++; // JVM option's value is not the application main class.
        break;
      }
    }
  }
  if (main >= args.size())
    return false;
  const auto& entry = args[main];
  if (entry == "net.minecraft.client.main.main" ||
      entry == "net.fabricmc.loader.impl.launch.knot.knotclient" ||
      entry == "net.fabricmc.loader.launch.knot.knotclient" ||
      entry == "org.quiltmc.loader.impl.launch.knot.knotclient")
    return true;

  const bool modLauncher = entry == "cpw.mods.bootstraplauncher.bootstraplauncher" ||
                           entry == "cpw.mods.modlauncher.launcher";
  const bool launchWrapper = entry == "net.minecraft.launchwrapper.launch";
  if (!modLauncher && !launchWrapper)
    return false;
  bool client = false;
  for (size_t i = main + 1; i < args.size(); i++) {
    std::string value;
    const std::string key = modLauncher ? "--launchtarget" : "--tweakclass";
    if (args[i] == key && i + 1 < args.size())
      value = args[++i];
    else if (args[i].rfind(key + "=", 0) == 0)
      value = args[i].substr(key.size() + 1);
    else
      continue;
    if (modLauncher) {
      // Server/data/dev targets are deliberately excluded.
      if (value != "forgeclient" && value != "neoforgeclient")
        return false;
      client = true;
    } else if (value == "net.minecraftforge.fml.common.launcher.fmltweaker" ||
               value == "cpw.mods.fml.common.launcher.fmltweaker") {
      client = true;
    } else if (value.find("server") != std::string::npos) {
      return false;
    }
  }
  return client;
}

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
