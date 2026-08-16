#include "detector.h"

#include "game_util.h"

#include <map>
#include <set>

namespace clipforge {

namespace {

const char* sourceName(GameSource s)
{
  switch (s) {
    case GameSource::Discovered:
      return "discovered";
    case GameSource::User:
      return "user";
  }
  return "discovered";
}

} // namespace

// Launcher exes -> platform type. These are also hard-negative signals: the
// launcher itself running is never a game (Todo #6).
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
  auto it = kLaunchers.find(exeLower);
  return it == kLaunchers.end() ? std::string() : it->second;
}

bool GameDetector::isLauncherExe(const std::string& exeLower)
{
  return !launcherTypeOfExe(exeLower).empty();
}

bool GameDetector::isKnownNonGameExe(const std::string& exeLower)
{
  // System / shell / capture infrastructure.
  static const std::set<std::string> kSystem = {
      "csrss.exe", "wininit.exe", "winlogon.exe", "services.exe", "lsass.exe",      "smss.exe",
      "svchost.exe", "conhost.exe", "dwm.exe", "explorer.exe", "taskhostw.exe",     "taskhostex.exe",
      "backgroundtaskhost.exe", "runtimebroker.exe", "shellexperiencehost.exe",     "searchhost.exe",
      "searchindexer.exe", "sihost.exe", "startmenuexperiencehost.exe",             "textinputhost.exe",
      "widgets.exe", "widgetservice.exe", "securityhealthservice.exe", "audiodg.exe", "spoolsv.exe",
      "fontdrvhost.exe", "ctflom.exe", "dllhost.exe", "wmiprvse.exe", "sgrmbroker.exe", "logonui.exe",
      "lockapp.exe", "gamebar.exe", "gamebarpresencewriter.exe", "gamingservices.exe", "gamingservicesnet.exe",
      "unsecapp.exe", "comhost.exe", "cloudfilesyncengine.exe", "win11appstyler.exe",
      "ctfmon.exe", "msiexec.exe", "searchprotocolhost.exe", "memory compression", "registry", "system",
      "secure system", "wininit.exe", "hudapp.exe",
      // Xbox / Microsoft Store bloat and overlay infrastructure (never games).
      "microsoft.storepurchaseapp.exe", "storepurchaseapp.exe", "gamingapp.exe", "xboxapp.exe",
      "xboxgamingoverlay.exe", "xboxgamecallableui.exe", "spartanshell.exe", "gamingservices.exe",
      "gameoverlayui64.exe", "gameoverlay32.exe", "nvcontainer.exe", "nvbackend.exe", "nvsphelper.exe",
      "nvidiawebhelper.exe", "nvidia share.exe", "nvidia share ui.exe",
  };
  // Browsers and webview helpers.
  static const std::set<std::string> kBrowsers = {
      "chrome.exe", "msedge.exe", "firefox.exe", "opera.exe", "brave.exe", "vivaldi.exe", "iexplore.exe",
      "chromium.exe", "seamonkey.exe", "waterfox.exe",
  };
  // Communication / presence.
  static const std::set<std::string> kComm = {
      "discord.exe", "telegram.exe", "whatsapp.exe", "slack.exe", "teams.exe", "ms-teams.exe", "zoom.exe",
      "skype.exe", "signal.exe", "webexmta.exe", "webex.exe", "msteams.exe", "outlook.exe", "thunderbird.exe",
  };
  // Utilities / tooling / media / capture apps.
  static const std::set<std::string> kUtils = {
      "powershell.exe", "pwsh.exe", "cmd.exe", "wsl.exe", "notepad.exe", "taskmgr.exe", "control.exe",
      "regedit.exe", "winrar.exe", "7zfm.exe", "7z.exe", "devenv.exe", "code.exe", "clion64.exe",
      "idea64.exe", "pycharm64.exe", "rider64.exe", "x64dbg.exe", "x32dbg.exe", "obs64.exe", "obs32.exe",
      "spotify.exe", "vlc.exe", "mpv.exe", "wmplayer.exe", "steamwebhelper.exe", "epicwebhelper.exe",
      "galaxyclientbootstrap.exe", "onedrive.exe", "windowsTerminal.exe", "wt.exe", "mspaint.exe",
      "calculator.exe", "snippingtool.exe", "photosapp.exe", "dwm.exe", "startmenu.exe", "magnify.exe",
  };
  // Battle.net's agent.exe is caught via the launcher map; keep a few more
  // launcher-adjacent helpers here (they never run as games).
  static const std::set<std::string> kLauncherHelpers = {
      "steamservice.exe", "steamwebhelper.exe", "epicwebhelper.exe", "launcher.exe", "riotclient.exe",
      "riotclientupdater.exe", "galaxyclientbootstrap.exe", "updater.exe", "unins000.exe",
  };

  return kSystem.count(exeLower) || kBrowsers.count(exeLower) || kComm.count(exeLower) ||
         kUtils.count(exeLower) || kLauncherHelpers.count(exeLower) || isLauncherExe(exeLower);
}

DetectionResult GameDetector::detect(const ProcessInfo& p, const DetectContext& ctx)
{
  DetectionResult r;
  if (p.exe.empty() || !ctx.registry)
    return r;

  // Hard negatives first: explicit user ignore and known non-game exes.
  if (ctx.registry->isIgnoredExe(p.exe)) {
    r.reasons.push_back({"user ignore rule", -200, p.exe + " is on the ignore list"});
    r.score = -200;
    r.decision = DetectionResult::Decision::Ignored;
    return r;
  }
  if (isKnownNonGameExe(p.exe)) {
    r.reasons.push_back({"known non-game", -200, p.exe + " is a system/browser/launcher/utility"});
    r.score = -200;
    r.decision = DetectionResult::Decision::Ignored;
    return r;
  }

  // --- positive signals ---------------------------------------------------
  const GameDefinition* g = ctx.registry->findByExe(p.exe);
  bool exeMatched = g != nullptr;
  bool strongListMatch = false; // user list / user-designated folder claim
  if (g) {
    const int base = g->source == GameSource::User ? 75 : 45;
    strongListMatch = g->source == GameSource::User;
    r.reasons.push_back({"executable match", base, p.exe + " -> " + g->name + " (" + sourceName(g->source) + ")"});
    r.gameId = g->id;
    r.gameName = g->name;
    r.emulator = g->emulator;
    r.score += base;
    // Entries from a user-designated game folder (indie/itch installs,
    // emulator libraries) carry a strong claim — the user pointed Shard here.
    for (const auto& l : g->launchers) {
      if (l.type == "custom") {
        r.reasons.push_back({"user-designated folder", 20, g->name + " was added via a game folder"});
        r.score += 20;
        strongListMatch = true;
        break;
      }
    }
    if (g->emulator && !strongListMatch) {
      r.reasons.push_back({"emulator entry", 20, g->name + " runs games through an emulator"});
      r.score += 20;
      strongListMatch = true;
    }
  } else if (!p.path.empty()) {
    // No exe match: the process may still be a game running from a known
    // install dir (exe too deep to scan, renamed). Weaker signal — treated
    // as a discovered-level match.
    const GameDefinition* byPath = ctx.registry->findByInstallPath(p.path);
    if (byPath) {
      g = byPath;
      exeMatched = true;
      r.reasons.push_back({"install path match", 45, p.path + " is under " + byPath->name + " install dir"});
      r.gameId = byPath->id;
      r.gameName = byPath->name;
      r.score += 45;
    }
  }

  // Launcher ancestry: a parent/grandparent is a known launcher AND the game
  // is associated with that launcher.
  std::string ancestorLauncher;
  if (ctx.chain && ctx.lookup && g) {
    const auto chain = ctx.chain(p.pid);
    for (size_t i = 1; i < chain.size(); i++) {
      const ProcessInfo anc = ctx.lookup(chain[i]);
      const std::string t = launcherTypeOfExe(anc.exe);
      if (!t.empty()) {
        ancestorLauncher = t;
        break;
      }
    }
    if (!ancestorLauncher.empty()) {
      bool ref = false;
      for (const auto& l : g->launchers)
        if (l.type == ancestorLauncher)
          ref = true;
      if (ref) {
        r.reasons.push_back({"launcher association", 25,
                             ancestorLauncher + " parent chain matches game launcher metadata"});
        r.score += 25;
        r.launcher = ancestorLauncher;
      }
    }
  }

  // Install-path containment (confirms an exe match, or stands alone).
  if (g && !p.path.empty()) {
    for (const auto& ip : g->installPaths) {
      if (pathUnder(p.path, ip)) {
        r.reasons.push_back({"install path match", 20, p.path + " is under " + ip});
        r.score += 20;
        break;
      }
    }
  }

  // Window facts.
  if (ctx.window.hasVisibleWindow) {
    r.reasons.push_back({"visible window", 5, "process owns a visible top-level window"});
    r.score += 5;
  }
  if (ctx.window.fullscreen) {
    r.reasons.push_back({"fullscreen", 5, "foreground window covers a monitor exactly"});
    r.score += 5;
  }
  if (ctx.window.foreground) {
    r.reasons.push_back({"foreground", 3, "window is foreground"});
    r.score += 3;
  }

  // Sustained runtime: only counts when we actually know the start time.
  if (p.startMs > 0 && ctx.nowMs > 0 && ctx.nowMs - p.startMs >= ctx.sustainedMs) {
    r.reasons.push_back({"sustained", 10, "process alive >= " + std::to_string(ctx.sustainedMs / 1000) + " s"});
    r.score += 10;
  }

  // Negative window signal: long-lived process with no visible window looks
  // like a background utility (not applied to known list matches — a user or
  // builtin claim wins over window shape).
  if (!strongListMatch && p.startMs > 0 && ctx.nowMs > 0 && ctx.nowMs - p.startMs >= 20000 &&
      !ctx.window.hasVisibleWindow) {
    r.reasons.push_back({"no visible window", -15, "alive > 20 s without a window"});
    r.score -= 15;
  }

  // --- decision ------------------------------------------------------------
  if (r.score >= 80 || (strongListMatch && r.score >= 55)) {
    r.decision = DetectionResult::Decision::Detected;
  } else if (r.score >= 55) {
    r.decision = DetectionResult::Decision::Candidate;
  }
  return r;
}

} // namespace clipforge
