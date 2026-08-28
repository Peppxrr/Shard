#include "detector.h"

#include "game_util.h"

#include <map>
#include <set>

namespace clipforge {

namespace {

const char* sourceName(GameSource source)
{
  return source == GameSource::User ? "user" : "discovered";
}

bool isConfirmedNonGame(const GameDefinition* game)
{
  return game && game->classification() == "confirmed-non-game";
}

bool hasLauncherRef(const GameDefinition& game, const std::string& type)
{
  for (const auto& launcher : game.launchers)
    if (launcher.type == type)
      return true;
  return false;
}

bool isOperatingSystemApplicationPath(const std::string& lowerPath)
{
  if (lowerPath.empty())
    return false;
  const bool windowsRoot = lowerPath.size() > 11 && lowerPath[1] == ':' &&
                           lowerPath.compare(2, 9, "\\windows\\") == 0;
  return windowsRoot || lowerPath.find("\\windowsapps\\") != std::string::npos ||
         lowerPath.find("\\systemapps\\") != std::string::npos;
}

bool containsMediaTarget(const std::string& text)
{
  if (text.empty())
    return false;
  const std::string lower = toLower(text);
  static const char* const kMediaExtensions[] = {
      ".mp4", ".mkv", ".webm", ".avi", ".mov", ".wmv", ".m4v", ".mpg", ".mpeg",
      ".m2ts", ".flv", ".ogv", ".mp3", ".flac", ".wav", ".m4a", ".aac", ".ogg",
      ".opus", ".wma", ".m3u", ".m3u8", ".pls", ".jpg", ".jpeg", ".png", ".webp",
      ".gif", ".bmp", ".avif",
  };
  for (const char* extension : kMediaExtensions)
    if (lower.find(extension) != std::string::npos)
      return true;
  static const char* const kMediaProtocols[] = {
      "http://", "https://", "rtsp://", "rtmp://", "udp://", "dvd://", "bd://", "ytdl://",
  };
  for (const char* protocol : kMediaProtocols)
    if (lower.find(protocol) != std::string::npos)
      return true;
  return false;
}

} // namespace

std::string GameDetector::launcherTypeOfExe(const std::string& exeLower)
{
  static const std::map<std::string, std::string> kLaunchers = {
      {"steam.exe", "steam"},
      {"epicgameslauncher.exe", "epic"},
      {"galaxyclient.exe", "gog"},
      {"upc.exe", "ubisoft"},
      {"uplay.exe", "ubisoft"},
      {"ubisoftconnect.exe", "ubisoft"},
      {"eadesktop.exe", "ea"},
      {"eaapp.exe", "ea"},
      {"origin.exe", "ea"},
      {"battle.net.exe", "battlenet"},
      {"agent.exe", "battlenet"},
      {"riotclientservices.exe", "riot"},
  };
  const auto it = kLaunchers.find(exeLower);
  return it == kLaunchers.end() ? std::string() : it->second;
}

bool GameDetector::isLauncherExe(const std::string& exeLower)
{
  return !launcherTypeOfExe(exeLower).empty();
}

bool GameDetector::canOwnQualifiedDescendant(const std::string& gameId)
{
  return gameId.rfind("d:runtime:", 0) != 0;
}

bool GameDetector::isKnownNonGameExe(const std::string& exeLower)
{
  // Process roles fixed by Windows or Shard's capture stack. Do not grow this
  // into an application deny list: live window/runtime evidence is the
  // classifier for ordinary applications.
  static const std::set<std::string> kInfrastructure = {
      "system", "registry", "memory compression", "secure system",
      "smss.exe", "csrss.exe", "wininit.exe", "winlogon.exe", "services.exe", "lsass.exe",
      "svchost.exe", "fontdrvhost.exe", "dwm.exe", "audiodg.exe", "conhost.exe", "dllhost.exe",
      "wmiprvse.exe", "runtimebroker.exe", "backgroundtaskhost.exe", "sihost.exe", "taskhostw.exe",
      "explorer.exe", "searchhost.exe", "startmenuexperiencehost.exe", "shellexperiencehost.exe",
      "gamebarpresencewriter.exe", "gamingservices.exe", "gamingservicesnet.exe",
      "gameoverlayui.exe", "gameoverlayui32.exe", "gameoverlayui64.exe",
      "steamservice.exe", "steamwebhelper.exe", "epicwebhelper.exe", "riotclient.exe",
      "riotclientupdater.exe", "galaxyclientbootstrap.exe", "shardcore.exe", "obs64.exe", "obs32.exe",
  };
  return kInfrastructure.count(exeLower) != 0 || isLauncherExe(exeLower);
}


DetectionResult GameDetector::detect(const ProcessInfo& p, const DetectContext& ctx)
{
  DetectionResult result;
  if (p.exe.empty() || !ctx.registry)
    return result;

  if (ctx.registry->isIgnoredExe(p.exe)) {
    result.reasons.push_back({"user ignore rule", -200, p.exe + " is explicitly ignored"});
    result.score = -200;
    return result;
  }
  if (isKnownNonGameExe(p.exe)) {
    result.reasons.push_back({"infrastructure process", -200, p.exe + " is Windows, launcher, or capture infrastructure"});
    result.score = -200;
    return result;
  }

  const GameDefinition* exact = ctx.registry->findByExe(p.exe);
  const GameDefinition* byPath = p.path.empty() ? nullptr : ctx.registry->findByInstallPath(p.path);
  const GameDefinition* product = exact ? exact : (byPath ? byPath : ctx.productHint);
  const bool runtimeProduct = product && product->id.rfind("d:runtime:", 0) == 0;
  const bool confirmedProduct =
      product && !runtimeProduct && product->classification() == "confirmed-game";
  const bool explicitUser = exact && exact->source == GameSource::User;

  if (isConfirmedNonGame(product)) {
    result.reasons.push_back({"authoritative product type", -200,
                              product->name + " is launcher-classified as " + product->productType});
    result.score = -200;
    return result;
  }

  if (product) {
    result.gameId = product->id;
    result.gameName = product->name;
    result.emulator = product->emulator;
    if (exact) {
      const int delta = explicitUser ? 75 : 35;
      result.reasons.push_back({"confirmed executable", delta,
                                p.exe + " maps to " + product->name + " (" + sourceName(product->source) + ")"});
      result.score += delta;
    } else {
      result.reasons.push_back({"product install containment", 25,
                                p.path + " is under the installed product " + product->name});
      result.score += 25;
    }
  }

  if (ctx.window.hasVisibleWindow) {
    result.reasons.push_back({"visible window", 5, "process owns a visible top-level window"});
    result.score += 5;
  }
  if (ctx.window.captureable) {
    result.reasons.push_back({"captureable window", 20, "window is on-screen, non-tool, and large enough to capture"});
    result.score += 20;
  }
  if (ctx.window.foreground) {
    result.reasons.push_back({"foreground intent", 15, "the user is actively foregrounding this process"});
    result.score += 15;
  }
  if (ctx.window.fullscreen) {
    result.reasons.push_back({"fullscreen render surface", 35, "window covers a monitor"});
    result.score += 35;
  }
  if (ctx.runtime.graphicsApi) {
    result.reasons.push_back({"graphics runtime", 30, "process loaded Direct3D, OpenGL, or Vulkan"});
    result.score += 30;
  }
  if (ctx.runtime.gameRuntime) {
    result.reasons.push_back({"game runtime", 40, "process loaded a game engine or game-oriented runtime"});
    result.score += 40;
  }
  if (ctx.runtime.gameInput) {
    result.reasons.push_back({"gaming input stack", 25,
                              "process uses both modern gaming input and controller APIs"});
    result.score += 25;
  }
  if (ctx.runtime.webRuntime) {
    result.reasons.push_back({"web application runtime", -50, "process hosts Chromium/CEF"});
    result.score -= 50;
  }

  // Launcher ancestry only corroborates an already identified product. It can
  // never turn an arbitrary launcher child into a game.
  if (product && ctx.chain && ctx.lookup) {
    const auto chain = ctx.chain(p.pid);
    for (size_t i = 1; i < chain.size(); i++) {
      const ProcessInfo ancestor = ctx.lookup(chain[i]);
      const std::string type = launcherTypeOfExe(ancestor.exe);
      if (!type.empty() && hasLauncherRef(*product, type)) {
        result.launcher = type;
        result.reasons.push_back({"launcher correlation", 5, type + " ancestry agrees with product metadata"});
        result.score += 5;
        break;
      }
    }
  }


  // Explicit user mappings are authoritative, but still need a real window;
  // otherwise a listed launcher/anti-cheat helper would create a dead session.
  if (explicitUser && ctx.window.captureable) {
    result.decision = DetectionResult::Decision::Detected;
    return result;
  }

  const bool mediaTarget = containsMediaTarget(p.commandLine) || containsMediaTarget(ctx.window.title);
  const bool mediaApplication = mediaTarget || (ctx.runtime.mediaRuntime && (!product || runtimeProduct));
  if (mediaApplication && !ctx.runtime.gameRuntime) {
    result.reasons.push_back({"media playback intent", -200,
                              "process targets media content or hosts a dedicated playback runtime"});
    result.score -= 200;
    return result;
  }

  if (ctx.runtime.webRuntime && (!product || runtimeProduct) && !ctx.runtime.gameRuntime) {
    result.reasons.push_back({"hosted web application", -200,
                              "untrusted process hosts Chromium, WebView, or Node native modules"});
    result.score -= 200;
    return result;
  }

  const bool operatingSystemApplication =
      !ctx.runtime.gameRuntime && isOperatingSystemApplicationPath(p.path);
  if (operatingSystemApplication) {
    result.reasons.push_back({"operating-system application", -200,
                              "Windows/SystemApps/WindowsApps process has no game-runtime evidence"});
    result.score -= 200;
    return result;
  }

  const bool largeRenderWindow = ctx.window.area >= (int64_t)640 * 360;
  // Render behavior corroborates identity; it is never identity. Fullscreen
  // alone is intentionally excluded because browsers, file dialogs, Python
  // GUIs, media tools, and desktop shells can all own fullscreen GPU surfaces.
  const bool renderEvidence = ctx.runtime.gameRuntime ||
                              (ctx.runtime.graphicsApi && largeRenderWindow);
  // Protected/anti-cheat games can deny module enumeration. The fallback is
  // available only after launcher metadata positively identifies the product
  // as a game; a generic application can never dwell its way into detection.
  const bool stableProductWindow = confirmedProduct && largeRenderWindow &&
                                   ctx.foregroundIntentMs >= 1500 &&
                                   !ctx.runtime.webRuntime;
  if (stableProductWindow) {
    result.reasons.push_back({"stable confirmed-game window", 25,
                              "launcher-classified game owns the foreground capture window for >= 1.5 s"});
    result.score += 25;
  }

  // Emulators such as Dolphin expose no engine DLL or product metadata. They
  // do expose two independent gaming-input stacks while rendering. Require
  // that combination plus a sustained large GPU surface; Qt/Python/file-dialog
  // windows have the render surface but not the paired gaming APIs.
  const bool stableGameInputSurface =
      ctx.runtime.gameInput && ctx.runtime.graphicsApi && largeRenderWindow &&
      (runtimeProduct || ctx.foregroundIntentMs >= 2500);
  if (stableGameInputSurface) {
    result.reasons.push_back({"stable game-input render surface", 30,
                              "paired gaming-input APIs render in the foreground for >= 2.5 s"});
    result.score += 30;
  }

  const bool knownProductShape = confirmedProduct && (renderEvidence || stableProductWindow);
  const bool untrustedProduct = !product || runtimeProduct;
  const bool unknownShape = untrustedProduct && !ctx.runtime.webRuntime &&
                            ((ctx.recentProcess && ctx.runtime.gameRuntime) ||
                             stableGameInputSurface);
  const bool liveGameShape = ctx.window.captureable && ctx.window.foreground &&
                             (knownProductShape || unknownShape);

  if (liveGameShape) {
    // product==nullptr is intentional: GameSystem creates a stable runtime
    // product immediately, then re-runs detection to bind the process to it.
    result.decision = DetectionResult::Decision::Detected;
    if (!product) {
      result.gameName = trim(ctx.window.title);
      if (result.gameName.empty()) {
        result.gameName = baseName(p.exe);
        const size_t dot = result.gameName.rfind('.');
        if (dot != std::string::npos)
          result.gameName.resize(dot);
      }
      if (result.gameName.size() > 128)
        result.gameName.resize(128);
    }
    return result;
  }

  // A foreground captureable process may still be loading its graphics DLLs.
  // Keep it hot for the next monitor ticks instead of waiting 30 seconds or
  // promoting it merely because a launcher exists in its ancestor chain.
  if (ctx.window.captureable && ctx.window.foreground)
    result.decision = DetectionResult::Decision::Candidate;
  return result;
}

} // namespace clipforge
