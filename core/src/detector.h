// Evidence-driven live game detection.
//
// Automatic admission is positive-only. A process must be an explicit user
// mapping, belong to a launcher product classified as a game, expose a
// recognized game engine, or combine gaming-input APIs with a sustained render
// surface. Generic desktop behavior (a large/fullscreen foreground window,
// recent launch, or D3D/OpenGL/Vulkan use) can never create game identity alone.
//
// Launcher metadata identifies installed products; it never proves that every
// executable under an install directory is the game. Product processes still
// need a captureable foreground render surface. Protected games that deny
// module enumeration may qualify after a stable foreground dwell, but only
// when launcher metadata already identifies the containing product as a game.
//
// Runtime-discovered identities are deliberately non-authoritative across
// launches. They must present recognized game-runtime evidence again, so an old
// false positive cannot become a permanent executable allow rule.
#pragma once

#include "game_registry.h"
#include "process_monitor.h"

#include <cstdint>
#include <functional>
#include <string>
#include <vector>

namespace clipforge {

struct DetectionReason {
  std::string signal;
  int delta;
  std::string note;
};

struct DetectionResult {
  enum class Decision { Ignored, Candidate, Detected };
  Decision decision = Decision::Ignored;
  int score = 0;
  std::string gameId;
  std::string gameName;
  std::string launcher;
  bool emulator = false;
  std::vector<DetectionReason> reasons;
};

struct WindowFacts {
  bool hasVisibleWindow = false;
  std::string title;            // selected top-level window title
  bool captureable = false; // visible, on-screen, non-tool top-level window
  bool fullscreen = false;
  bool foreground = false;
  int64_t area = 0;         // client pixels of the selected window
};

struct RuntimeFacts {
  bool probeSucceeded = false;
  bool graphicsApi = false; // D3D/OpenGL/Vulkan loaded in this process
  bool gameRuntime = false; // recognized game engine loaded in this process
  bool gameInput = false;   // paired modern gaming-input and controller APIs
  bool webRuntime = false;  // Chromium/CEF host; structural non-game evidence
  bool mediaRuntime = false; // dedicated media playback framework
};

struct DetectContext {
  const GameRegistry* registry = nullptr;
  const GameDefinition* productHint = nullptr; // ephemeral launcher metadata
  std::function<std::vector<uint32_t>(uint32_t)> chain;
  std::function<ProcessInfo(uint32_t)> lookup;
  WindowFacts window;
  RuntimeFacts runtime;
  bool recentProcess = false;   // opened during the current launch episode
  int64_t nowMs = 0;
  int64_t foregroundIntentMs = 0;
};

class GameDetector {
public:
  static DetectionResult detect(const ProcessInfo& p, const DetectContext& ctx);

  // Stable OS/capture infrastructure only. Ordinary applications are rejected
  // by the positive admission gate rather than an executable deny list.
  static bool isKnownNonGameExe(const std::string& exeLower);
  static std::string launcherTypeOfExe(const std::string& exeLower);
  static bool isLauncherExe(const std::string& exeLower);
  // Runtime-discovered products identify one qualified executable and cannot
  // claim qualified descendants. Installed/user products may group their
  // multi-process game children.
  static bool canOwnQualifiedDescendant(const std::string& gameId);
};

} // namespace clipforge
