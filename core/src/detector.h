// Confidence-based game detection (Todo #5).
//
// A process candidate is scored from independent signals — executable match,
// launcher ancestry, install-path containment, window facts, sustained
// runtime — plus hard negative signals (known non-game exes, user ignores).
// The result is deterministic and explainable: every point carries a reason.
//
// Weights (documented, debuggable):
//   +75 user exe match       (explicitly added by the user — strongest claim)
//   +70 builtin exe match    (shipped starter table)
//   +45 discovered exe match (launcher-scanned)
//   +25 launcher association (ancestor process is the game's launcher type)
//   +20 install-path match   (process runs from the game's install dir)
//   + 5 visible window
//   + 5 fullscreen
//   + 3 foreground
//   +10 sustained runtime (>= sustainedMs)
//   -15 no visible window after 20 s (background utility shape)
//   -200 known non-game exe / user-ignored exe (hard ignore, checked first)
//
// Decision:
//   >= 80                         -> Detected
//   >= 55 with builtin/user match -> Detected   (the list is the evidence)
//   >= 55                         -> Candidate  (needs more evidence; the
//                                               unknown-game workflow may
//                                               promote it into the registry)
//   < 55                          -> Ignored
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
  std::string launcher; // launcher type that contributed, e.g. "steam"
  bool emulator = false; // the matched game runs via an emulator
  std::vector<DetectionReason> reasons;
};

struct WindowFacts {
  bool hasVisibleWindow = false;
  bool fullscreen = false;
  bool foreground = false;
};

struct DetectContext {
  const GameRegistry* registry = nullptr;
  // Ancestor chain + lookup are injected so tests can fake process topology.
  std::function<std::vector<uint32_t>(uint32_t)> chain;
  std::function<ProcessInfo(uint32_t)> lookup;
  WindowFacts window;
  int64_t nowMs = 0;
  int64_t sustainedMs = 15000; // process age considered "sustained"
};

class GameDetector {
public:
  static DetectionResult detect(const ProcessInfo& p, const DetectContext& ctx);

  // Hard-negative executable list (system, browsers, communication apps,
  // launchers themselves, utilities, capture tools).
  static bool isKnownNonGameExe(const std::string& exeLower);
  // Map a known launcher exe to its platform type, e.g. "steam" / "".
  static std::string launcherTypeOfExe(const std::string& exeLower);
  static bool isLauncherExe(const std::string& exeLower);
};

} // namespace clipforge
