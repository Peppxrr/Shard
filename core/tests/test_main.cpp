// Shard detection subsystem unit tests. No OBS, no Electron — pure logic.
// Build: cmake --build build_x64 --config Debug --target shard_tests
// Run:   build_x64/Debug/shard_tests.exe
#include "detector.h"
#include "game_registry.h"
#include "game_session.h"
#include "launchers.h"

#include <nlohmann/json.hpp>

#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <functional>
#include <map>
#include <string>
#include <vector>

namespace fs = std::filesystem;

static int g_checks = 0;
static int g_failures = 0;

#define CHECK(cond)                                                                                       \
  do {                                                                                                    \
    g_checks++;                                                                                           \
    if (!(cond)) {                                                                                        \
      g_failures++;                                                                                       \
      std::printf("FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond);                                         \
    }                                                                                                     \
  } while (0)

#define CHECK_EQ(a, b)                                                                                    \
  do {                                                                                                    \
    g_checks++;                                                                                           \
    if (!((a) == (b))) {                                                                                  \
      g_failures++;                                                                                       \
      std::printf("FAIL %s:%d: %s == %s\n", __FILE__, __LINE__, #a, #b);                                  \
    }                                                                                                     \
  } while (0)

using namespace clipforge;

// ------------------------------------------------------------ test fixtures

struct TestDir {
  fs::path root;
  TestDir(const std::string& name)
  {
    using namespace std::chrono;
    const auto stamp = duration_cast<milliseconds>(system_clock::now().time_since_epoch()).count();
    root = fs::temp_directory_path() / ("shard-tests-" + name + "-" + std::to_string(stamp) + "-" +
                                        std::to_string(rand()));
    fs::create_directories(root);
  }
  ~TestDir() { std::error_code ec; fs::remove_all(root, ec); }
};

// Backslashes must be doubled inside JSON strings.
static std::string jsonEscape(const std::string& s)
{
  std::string out = s;
  for (size_t i = 0; i < out.size(); i++) {
    if (out[i] == '\\') {
      out.insert(i, "\\");
      i++;
    }
  }
  return out;
}

ProcessInfo proc(const std::string& exe, uint32_t pid, uint32_t parent = 0, const std::string& path = "",
                 int64_t startMs = 1000)
{
  ProcessInfo p;
  p.exe = exe;
  p.pid = pid;
  p.parentPid = parent;
  p.path = path;
  p.startMs = startMs;
  return p;
}

DetectionResult detectWith(const GameRegistry& reg, const ProcessInfo& p,
                           std::function<std::vector<uint32_t>(uint32_t)> chain = {},
                           std::function<ProcessInfo(uint32_t)> lookup = {}, WindowFacts wf = {},
                           int64_t nowMs = 60000)
{
  DetectContext ctx;
  ctx.registry = &reg;
  ctx.chain = chain ? chain : std::function<std::vector<uint32_t>(uint32_t)>([](uint32_t id) {
    return std::vector<uint32_t>{id};
  });
  ctx.lookup = lookup ? lookup : std::function<ProcessInfo(uint32_t)>([](uint32_t) { return ProcessInfo{}; });
  ctx.window = wf;
  ctx.nowMs = nowMs;
  return GameDetector::detect(p, ctx);
}

DetectionResult detected(const std::string& id, const std::string& name, int score = 80, bool emu = false)
{
  DetectionResult r;
  r.decision = DetectionResult::Decision::Detected;
  r.gameId = id;
  r.gameName = name;
  r.score = score;
  r.emulator = emu;
  return r;
}

// ------------------------------------------------------------- registry ----

static void testNoBuiltinLayer()
{
  GameRegistry reg;
  reg.setPath((fs::temp_directory_path() / "shard-tests-nobuiltin.json").string());
  reg.load();
  // Nothing is known out of the box — detection is entirely discovered/user.
  CHECK(reg.findByExe("eldenring.exe") == nullptr);
  CHECK_EQ(reg.all().size(), (size_t)0);
}

static void testV1Migration()
{
  TestDir dir("v1");
  const fs::path p = dir.root / "games.json";
  {
    std::ofstream out(p);
    out << R"([{"exe":"eldenring.exe","name":"Elden Ring"},{"exe":"mygame.exe","name":"My Custom Game"}])";
  }
  GameRegistry reg;
  reg.setPath(p.string());
  reg.load();
  CHECK_EQ(reg.migratedV1Count(), (size_t)2); // everything migrates to the user layer
  const GameDefinition* custom = reg.findByExe("mygame.exe");
  CHECK(custom != nullptr);
  if (custom)
    CHECK_EQ(custom->source, GameSource::User);
  const GameDefinition* elden = reg.findByExe("eldenring.exe");
  CHECK(elden != nullptr);
  if (elden)
    CHECK_EQ(elden->source, GameSource::User);
}

static void testPersistenceRoundTrip()
{
  TestDir dir("persist");
  const fs::path p = dir.root / "games.json";
  {
    GameRegistry reg;
    reg.setPath(p.string());
    reg.load();
    GameDefinition g;
    g.name = "Persisted Game";
    g.executables = {"pg.exe"};
    g.installPaths = {"c:\\games\\pg\\"};
    const std::string id = reg.upsertUserGame(g);
    CHECK(!id.empty());
    reg.addIgnoredExe("discord.exe");
    reg.setLauncherEnabled("steam", false);
    CustomFolder f;
    f.name = "My Emus";
    f.path = "C:\\Emus";
    f.emulator = true;
    const std::string fid = reg.addCustomFolder(f);
    CHECK(!fid.empty());
  }
  {
    GameRegistry reg;
    reg.setPath(p.string());
    reg.load();
    const GameDefinition* g = reg.findByExe("pg.exe");
    CHECK(g != nullptr);
    if (g) {
      CHECK_EQ(g->name, std::string("Persisted Game"));
      CHECK_EQ(g->source, GameSource::User);
      CHECK(g->installPaths.size() == 1);
    }
    CHECK(reg.isIgnoredExe("discord.exe"));
    CHECK(!reg.launcherEnabled("steam"));
    const auto folders = reg.customFolders();
    CHECK_EQ(folders.size(), (size_t)1);
    if (!folders.empty()) {
      CHECK_EQ(folders[0].name, std::string("My Emus"));
      CHECK(folders[0].emulator);
    }
  }
}

static void testUserPrecedence()
{
  TestDir dir("precedence");
  GameRegistry reg;
  reg.setPath((dir.root / "games.json").string());
  reg.load();
  // A discovered entry claims eldenring.exe...
  GameDefinition d;
  d.id = "d:steam:1245620";
  d.name = "Elden Ring";
  d.executables = {"eldenring.exe"};
  d.launchers = {{"steam", "1245620"}};
  reg.mergeDiscovered(d);
  CHECK(reg.findByExe("eldenring.exe") != nullptr);
  // ...and a user entry overrides it.
  GameDefinition u;
  u.name = "My Renamed Elden Ring";
  u.executables = {"eldenring.exe"};
  reg.upsertUserGame(u);
  const GameDefinition* hit = reg.findByExe("eldenring.exe");
  CHECK(hit != nullptr);
  if (hit) {
    CHECK_EQ(hit->name, std::string("My Renamed Elden Ring"));
    CHECK_EQ(hit->source, GameSource::User);
  }
}

static void testDiscoveredMergeByName()
{
  TestDir dir("merge");
  GameRegistry reg;
  reg.setPath((dir.root / "games.json").string());
  reg.load();

  GameDefinition userGame;
  userGame.name = "Elden Ring";
  userGame.executables = {"eldenring.exe"};
  reg.upsertUserGame(userGame);

  // Discovered metadata for the same name merges into the user row instead of
  // duplicating.
  GameDefinition steamElden;
  steamElden.id = "d:steam:1245620";
  steamElden.name = "Elden Ring";
  steamElden.executables = {"eldenring_launcher.exe"};
  steamElden.installPaths = {"c:\\steam\\elden ring\\"};
  steamElden.launchers = {{"steam", "1245620"}};
  steamElden.source = GameSource::Discovered;
  reg.mergeDiscovered(steamElden);

  const GameDefinition* hit = reg.findByExe("eldenring.exe");
  CHECK(hit != nullptr);
  if (hit) {
    CHECK(hit->id.rfind("u:", 0) == 0); // merged into the user row
    CHECK(hit->launchers.size() >= 1);
    CHECK(hit->launchers[0].type == "steam");
    CHECK(hit->executables.size() >= 2);
  }
  const GameDefinition* launcherExe = reg.findByExe("eldenring_launcher.exe");
  CHECK(launcherExe != nullptr);

  // A standalone discovered game (no user match) becomes its own entry.
  GameDefinition standalone;
  standalone.id = "d:steam:999";
  standalone.name = "Some Obscure Indie";
  standalone.executables = {"obscure.exe"};
  standalone.launchers = {{"steam", "999"}};
  reg.mergeDiscovered(standalone);
  CHECK(reg.findByExe("obscure.exe") != nullptr);
  CHECK(reg.findById("d:steam:999") != nullptr);
  CHECK_EQ(reg.all().size(), (size_t)2); // one user row + one discovered row

  // Merged metadata persists across a restart.
  {
    GameRegistry reg2;
    reg2.setPath((dir.root / "games.json").string());
    reg2.load();
    const GameDefinition* hit2 = reg2.findByExe("eldenring_launcher.exe");
    CHECK(hit2 != nullptr);
    if (hit2)
      CHECK_EQ(hit2->name, std::string("Elden Ring"));
  }
}

static void testRemoveUserAndDiscovered()
{
  TestDir dir("remove");
  GameRegistry reg;
  reg.setPath((dir.root / "games.json").string());
  reg.load();
  GameDefinition g;
  g.name = "Temp Game";
  g.executables = {"temp.exe"};
  const std::string id = reg.upsertUserGame(g);
  CHECK(!id.empty());
  CHECK(reg.findByExe("temp.exe") != nullptr);
  CHECK(reg.removeUserGame(id));
  CHECK(reg.findByExe("temp.exe") == nullptr);

  GameDefinition d;
  d.id = "d:steam:5";
  d.name = "Disc";
  d.executables = {"disc.exe"};
  reg.mergeDiscovered(d);
  CHECK(reg.removeDiscoveredGame("d:steam:5"));
  CHECK(reg.findByExe("disc.exe") == nullptr);
}

// --------------------------------------------------------------- detector --

static void testDetectorUserGame()
{
  GameRegistry reg;
  reg.setPath((fs::temp_directory_path() / "shard-tests-det.json").string());
  reg.load();
  GameDefinition g;
  g.name = "User Game";
  g.executables = {"ugame.exe"};
  reg.upsertUserGame(g);
  WindowFacts wf;
  wf.hasVisibleWindow = true;
  const auto r = detectWith(reg, proc("ugame.exe", 100), {}, {}, wf);
  CHECK_EQ((int)r.decision, (int)DetectionResult::Decision::Detected);
  CHECK_EQ(r.gameName, std::string("User Game"));
  CHECK(r.reasons.size() >= 2); // executable match + visible window

  // Without any registry entry the same exe is ignored.
  const auto unknown = detectWith(reg, proc("not-a-game.exe", 101), {}, {}, wf);
  CHECK_EQ((int)unknown.decision, (int)DetectionResult::Decision::Ignored);
}

static void testDetectorNonGames()
{
  GameRegistry reg;
  reg.setPath((fs::temp_directory_path() / "shard-tests-det2.json").string());
  reg.load();
  WindowFacts wf;
  wf.hasVisibleWindow = true;
  wf.foreground = true;
  CHECK_EQ((int)detectWith(reg, proc("discord.exe", 200), {}, {}, wf).decision,
           (int)DetectionResult::Decision::Ignored);
  CHECK_EQ((int)detectWith(reg, proc("steam.exe", 201), {}, {}, wf).decision,
           (int)DetectionResult::Decision::Ignored);
  CHECK_EQ((int)detectWith(reg, proc("chrome.exe", 202), {}, {}, wf).decision,
           (int)DetectionResult::Decision::Ignored);
  // Xbox/MS bloat and overlays are hard-ignored even with a window.
  CHECK_EQ((int)detectWith(reg, proc("microsoft.storepurchaseapp.exe", 203), {}, {}, wf).decision,
           (int)DetectionResult::Decision::Ignored);
  CHECK_EQ((int)detectWith(reg, proc("gamingapp.exe", 204), {}, {}, wf).decision,
           (int)DetectionResult::Decision::Ignored);
  CHECK_EQ((int)detectWith(reg, proc("gameoverlayui64.exe", 205), {}, {}, wf).decision,
           (int)DetectionResult::Decision::Ignored);
  CHECK_EQ((int)detectWith(reg, proc("xboxapp.exe", 206), {}, {}, wf).decision,
           (int)DetectionResult::Decision::Ignored);
  // Unknown exe with no evidence -> ignored.
  CHECK_EQ((int)detectWith(reg, proc("randomness.exe", 207), {}, {}, wf).decision,
           (int)DetectionResult::Decision::Ignored);
}

static void testDetectorLauncherChain()
{
  GameRegistry reg;
  reg.setPath((fs::temp_directory_path() / "shard-tests-det3.json").string());
  reg.load();
  GameDefinition g;
  g.id = "d:steam:1001";
  g.name = "Launcher Game";
  g.executables = {"lgame.exe"};
  g.installPaths = {"c:\\steam\\lgame\\"};
  g.launchers = {{"steam", "1001"}};
  reg.mergeDiscovered(g);

  auto chain = [](uint32_t id) {
    if (id == 300)
      return std::vector<uint32_t>{300, 301, 302};
    return std::vector<uint32_t>{id};
  };
  auto lookup = [](uint32_t id) {
    ProcessInfo p;
    p.pid = id;
    if (id == 301)
      p.exe = "steam.exe";
    return p;
  };
  WindowFacts wf;
  wf.hasVisibleWindow = true;
  const ProcessInfo game = proc("lgame.exe", 300, 301, "c:\\steam\\lgame\\bin\\lgame.exe");
  const auto r = detectWith(reg, game, chain, lookup, wf);
  CHECK_EQ((int)r.decision, (int)DetectionResult::Decision::Detected);
  CHECK(r.score >= 80);
  CHECK_EQ(r.launcher, std::string("steam"));
  bool hasLauncherReason = false;
  for (const auto& rr : r.reasons)
    if (rr.signal == "launcher association")
      hasLauncherReason = true;
  CHECK(hasLauncherReason);

  // Discovered exe alone (no launcher, no install path) is a candidate.
  auto chainNone = [](uint32_t id) { return std::vector<uint32_t>{id}; };
  const ProcessInfo plain = proc("lgame.exe", 301, 0, "", 1000);
  const auto cand = detectWith(reg, plain, chainNone, lookup, wf);
  CHECK_EQ((int)cand.decision, (int)DetectionResult::Decision::Candidate);
}

static void testDetectorUserIgnoreWins()
{
  GameRegistry reg;
  reg.setPath((fs::temp_directory_path() / "shard-tests-det4.json").string());
  reg.load();
  GameDefinition g;
  g.name = "Ignored Game";
  g.executables = {"igame.exe"};
  reg.upsertUserGame(g);
  reg.addIgnoredExe("igame.exe");
  WindowFacts wf;
  wf.hasVisibleWindow = true;
  wf.fullscreen = true;
  const auto r = detectWith(reg, proc("igame.exe", 400), {}, {}, wf);
  CHECK_EQ((int)r.decision, (int)DetectionResult::Decision::Ignored);
}

static void testDetectorMultiExeIdentity()
{
  GameRegistry reg;
  reg.setPath((fs::temp_directory_path() / "shard-tests-det5.json").string());
  reg.load();
  GameDefinition g;
  g.name = "Multi Exe Game";
  g.executables = {"main.exe", "win64-shipping.exe"};
  reg.upsertUserGame(g);
  const auto a = detectWith(reg, proc("main.exe", 500), {}, {}, WindowFacts{});
  const auto b = detectWith(reg, proc("win64-shipping.exe", 501), {}, {}, WindowFacts{});
  CHECK_EQ((int)a.decision, (int)DetectionResult::Decision::Detected);
  CHECK_EQ((int)b.decision, (int)DetectionResult::Decision::Detected);
  CHECK_EQ(a.gameId, b.gameId);
}

static void testDetectorEmulatorFlag()
{
  GameRegistry reg;
  reg.setPath((fs::temp_directory_path() / "shard-tests-det7.json").string());
  reg.load();
  GameDefinition g;
  g.id = "d:custom:emu:dolphin";
  g.name = "Dolphin";
  g.executables = {"dolphin.exe"};
  g.emulator = true;
  reg.mergeDiscovered(g);
  WindowFacts wf;
  wf.hasVisibleWindow = true;
  const auto r = detectWith(reg, proc("dolphin.exe", 600), {}, {}, wf);
  CHECK_EQ((int)r.decision, (int)DetectionResult::Decision::Detected);
  CHECK(r.emulator);
}

// ---------------------------------------------------------------- sessions --

static void testSessionLifecycle()
{
  GameSessionManager mgr;
  std::vector<std::pair<std::string, nlohmann::json>> events;
  mgr.setSink([&](const char* type, const nlohmann::json& params) {
    events.push_back({type, params});
  });

  mgr.onDetected(detected("u:test", "Test Game", 85), proc("test.exe", 700, 0, "", 1000));
  CHECK_EQ(mgr.count(), (size_t)1);
  CHECK(mgr.primary().primary);
  CHECK_EQ(events.size(), (size_t)1);
  CHECK_EQ(events[0].second["state"], std::string("started"));

  // Alt-tab / minimize: window metadata changes, the session survives.
  mgr.updateWindow(700, "Test Game", "GAME", true, true);
  mgr.updateWindow(700, "", "GAME", false, false);
  CHECK_EQ(mgr.count(), (size_t)1);
  const GameSession s = mgr.primary();
  CHECK(!s.hasWindow); // window state is metadata, not the source of truth

  // Re-detection refreshes, never duplicates or re-emits.
  mgr.onDetected(detected("u:test", "Test Game", 90), proc("test.exe", 700, 0, "", 1000));
  CHECK_EQ(mgr.count(), (size_t)1);
  CHECK_EQ(events.size(), (size_t)1);

  // Process exit ends the session.
  mgr.onProcessExited(700);
  CHECK_EQ(mgr.count(), (size_t)0);
  CHECK_EQ(events.size(), (size_t)2);
  CHECK_EQ(events[1].second["state"], std::string("ended"));
}

static void testSessionMultiPidDedupe()
{
  // A game that spawns several processes produces ONE session (no duplicate
  // detection popups) and survives when the tracked process exits.
  GameSessionManager mgr;
  std::vector<std::string> states;
  mgr.setSink([&](const char* type, const nlohmann::json& params) {
    if (std::strcmp(type, "game.session") == 0)
      states.push_back(params["state"]);
  });

  mgr.onDetected(detected("u:multi", "Multi Game", 85), proc("main.exe", 800, 0, "", 1000));
  mgr.onDetected(detected("u:multi", "Multi Game", 85), proc("helper.exe", 801, 0, "", 2000));
  mgr.onDetected(detected("u:multi", "Multi Game", 85), proc("launcher.exe", 802, 0, "", 3000));
  CHECK_EQ(mgr.count(), (size_t)1); // one session for the whole family
  CHECK_EQ(states.size(), (size_t)1);
  CHECK_EQ(states[0], std::string("started"));

  const GameSession s = mgr.primary();
  CHECK_EQ(s.pids.size(), (size_t)3);
  CHECK_EQ(s.pid, (uint32_t)802); // newest process is active

  // The active process dies but the game lives on: session survives, active
  // pid moves to the newest survivor.
  mgr.onProcessExited(802);
  CHECK_EQ(mgr.count(), (size_t)1);
  CHECK_EQ(mgr.primary().pid, (uint32_t)801);
  CHECK_EQ(states.size(), (size_t)1); // no spurious events

  // sessionForPid resolves any family member.
  CHECK(mgr.sessionForPid(800) != nullptr);
  CHECK(mgr.sessionForPid(801) != nullptr);

  // Last pid exits: session ends.
  mgr.onProcessExited(801);
  mgr.onProcessExited(800);
  CHECK_EQ(mgr.count(), (size_t)0);
  CHECK_EQ(states.size(), (size_t)2);
  CHECK_EQ(states[1], std::string("ended"));
}

static void testSessionPrimarySwitchAndFocus()
{
  GameSessionManager mgr;
  std::vector<std::string> states;
  mgr.setSink([&](const char* type, const nlohmann::json& params) {
    if (std::strcmp(type, "game.session") == 0)
      states.push_back(params["state"]);
  });

  mgr.onDetected(detected("u:game-a", "Game A", 80), proc("a.exe", 900, 0, "", 1000));
  mgr.onDetected(detected("u:game-b", "Game B", 85), proc("b.exe", 901, 0, "", 2000));
  CHECK_EQ(mgr.primary().gameId, std::string("u:game-b")); // most recent start

  // The user focuses game A: the owner loop debounces and then switches.
  CHECK(mgr.sessionForPid(900) != nullptr);
  mgr.setPrimaryByGameId("u:game-a");
  CHECK_EQ(mgr.primary().gameId, std::string("u:game-a"));
  bool sawPrimary = false;
  for (const auto& st : states)
    if (st == "primary")
      sawPrimary = true;
  CHECK(sawPrimary);

  // B exits -> A stays primary.
  mgr.onProcessExited(901);
  CHECK_EQ(mgr.count(), (size_t)1);
  CHECK_EQ(mgr.primary().gameId, std::string("u:game-a"));
}

// ---------------------------------------------------------------- launchers

static void writeFile(const fs::path& p, const std::string& content)
{
  fs::create_directories(p.parent_path());
  std::ofstream out(p);
  out << content;
}

static void testSteamDiscovery()
{
  TestDir dir("steam");
  const fs::path steamRoot = dir.root / "Steam";
  writeFile(steamRoot / "steamapps" / "libraryfolders.vdf",
            "\"libraryfolders\"\n{\n\t\"0\"\n\t{\n\t\t\"path\"\t\t\"" + dir.root.string() +
                "\\\\Steam\"\n\t}\n}\n");
  writeFile(steamRoot / "steamapps" / "appmanifest_730.acf",
            "\"AppState\"\n{\n\t\"appid\"\t\t\"730\"\n\t\"name\"\t\t\"Counter-Strike 2\"\n\t\"installdir\"\t\t"
            "\"cs2\"\n}\n");
  writeFile(steamRoot / "steamapps" / "common" / "cs2" / "cs2.exe", "x");
  writeFile(steamRoot / "steamapps" / "common" / "cs2" / "setup.exe", "x");
  // Tool apps (redistributables) are skipped.
  writeFile(steamRoot / "steamapps" / "appmanifest_228980.acf",
            "\"AppState\"\n{\n\t\"name\"\t\t\"Steamworks Common Redistributables\"\n\t\"installdir\"\t\t"
            "\"Steamworks Redist\"\n}\n");
  writeFile(steamRoot / "steamapps" / "common" / "Steamworks Redist" / "vcredist_x64.exe", "x");

  ScanContext ctx;
  ctx.steamLibraryFile = (steamRoot / "steamapps" / "libraryfolders.vdf").string();
  const auto games = LauncherDiscovery::scanSteam(ctx);
  CHECK_EQ(games.size(), (size_t)1);
  if (!games.empty()) {
    const auto& g = games[0];
    CHECK_EQ(g.name, std::string("Counter-Strike 2"));
    CHECK_EQ(g.launchers[0].id, std::string("730"));
    CHECK(g.executables.size() == 1 && g.executables[0] == "cs2.exe");
  }
}

static void testEpicDiscovery()
{
  TestDir dir("epic");
  const fs::path manifests = dir.root / "Manifests";
  writeFile(manifests / "Game.item",
            R"({"AppName":"Fortnite","DisplayName":"Fortnite","InstallLocation":")" +
                jsonEscape(dir.root.string()) + R"(\\Fortnite","LaunchExecutable":"FortniteLauncher.exe"})");
  writeFile(manifests / "ThirdParty.item",
            R"({"AppName":"xyz","DisplayName":"Redirector","InstallLocation":")" +
                jsonEscape(dir.root.string()) + R"(\\x","LaunchExecutable":"x.exe","AppCategories":["third-party"]})");
  writeFile(dir.root / "Fortnite" / "FortniteClient-Win64-Shipping.exe", "x");

  ScanContext ctx;
  ctx.epicManifestsDir = manifests.string();
  const auto games = LauncherDiscovery::scanEpic(ctx);
  CHECK_EQ(games.size(), (size_t)1);
  if (!games.empty())
    CHECK_EQ(games[0].name, std::string("Fortnite"));
}

static void testHeroicDiscovery()
{
  TestDir dir("heroic");
  const fs::path cfg = dir.root / ".config" / "heroic" / "games_config";
  writeFile(cfg / "Hades.json",
            R"({"app_name":"Hades","title":"Hades","install":{"path":")" + jsonEscape(dir.root.string()) +
                R"(\\Hades","platform":"windows"}})");
  writeFile(cfg / "NotInstalled.json",
            R"({"app_name":"Ghost","title":"Ghost","install":{"path":"Z:\\nowhere","platform":"windows"}})");
  writeFile(dir.root / "Hades" / "Hades.exe", "x");

  ScanContext ctx;
  ctx.heroicConfigDir = (dir.root / ".config" / "heroic").string();
  const auto games = LauncherDiscovery::scanHeroic(ctx);
  CHECK_EQ(games.size(), (size_t)1); // only installed entries
  if (!games.empty()) {
    CHECK_EQ(games[0].name, std::string("Hades"));
    CHECK_EQ(games[0].launchers[0].type, std::string("heroic"));
    CHECK(games[0].executables.size() >= 1);
  }
}

static void testCustomFolderDiscovery()
{
  TestDir dir("custom");
  writeFile(dir.root / "my-game" / "Game.exe", "x");
  writeFile(dir.root / "my-game" / "readme.txt", "x");
  writeFile(dir.root / "emus" / "Dolphin.exe", "x");
  writeFile(dir.root / "emus" / "Cemu.exe", "x");

  ScanContext ctx;
  ctx.customFolders = {
      {"c:indie", "Indie games", dir.root.string() + "\\my-game\\", false},
      {"c:emus", "Emulators", dir.root.string() + "\\emus\\", true},
  };
  const auto games = LauncherDiscovery::scanCustom(ctx);
  CHECK_EQ(games.size(), (size_t)3); // 1 indie + 2 emulators
  int emuCount = 0;
  for (const auto& g : games) {
    if (g.launchers[0].type != "custom")
      CHECK(false);
    if (g.emulator)
      emuCount++;
  }
  CHECK_EQ(emuCount, 2);
  // Emulator entries carry the flag for capture-side window selection.
  for (const auto& g : games)
    if (g.executables[0] == "dolphin.exe")
      CHECK(g.emulator);
}

// Small fake registry helper (map-backed; must match the std::function shape).
struct FakeRegistryHelper {
  std::map<std::string, std::string> values;
  std::map<std::string, std::vector<std::string>> keys;
  std::string read(const std::string& hive, const std::string& keyPath, const std::string& valueName)
  {
    auto it = values.find(hive + "\\" + keyPath + "\\" + valueName);
    return it == values.end() ? std::string() : it->second;
  }
  std::vector<std::string> list(const std::string& hive, const std::string& keyPath)
  {
    auto it = keys.find(hive + "\\" + keyPath);
    return it == keys.end() ? std::vector<std::string>() : it->second;
  }
  void set(const std::string& hive, const std::string& keyPath, const std::string& valueName,
           const std::string& value)
  {
    values[hive + "\\" + keyPath + "\\" + valueName] = value;
  }
  void addSubKey(const std::string& hive, const std::string& keyPath, const std::string& sub)
  {
    keys[hive + "\\" + keyPath].push_back(sub);
  }
};

static void testMsStoreDiscovery()
{
  TestDir dir("msstore");
  const fs::path pkgRoot = dir.root / "Microsoft.TestGame_8wekyb3d8bbwe";
  writeFile(pkgRoot / "AppxManifest.xml",
            R"(<?xml version="1.0"?><Package xmlns="http://schemas.microsoft.com/appx/manifest/foundation/windows10">
<Identity Name="Microsoft.TestGame_8wekyb3d8bbwe" Publisher="CN=Test" Version="1.0.0.0"/>
<Properties><DisplayName>ms-resource:AppName</DisplayName></Properties>
<Applications><Application Id="App" Executable="TestGame.exe" /></Applications>
<Extensions><Extension Category="windows.fullTrustProcess" /></Extensions>
</Package>)");
  // Bloat package (Store app) must be skipped.
  writeFile(dir.root / "Microsoft.StorePurchaseApp_8wekyb3d8bbwe" / "AppxManifest.xml",
            R"(<Package><Identity Name="Microsoft.StorePurchaseApp_8wekyb3d8bbwe" Publisher="CN=X" Version="1.0"/>
<Applications><Application Id="App" Executable="spa.exe" /></Applications>
<Extensions><Extension Category="windows.fullTrustProcess" /></Extensions></Package>)");

  FakeRegistryHelper fr;
  fr.addSubKey("HKCU", "SOFTWARE\\Classes\\Local Settings\\Software\\Microsoft\\Windows\\CurrentVersion\\"
                       "AppModel\\Repository\\Packages",
               "Microsoft.TestGame_8wekyb3d8bbwe");
  fr.addSubKey("HKCU", "SOFTWARE\\Classes\\Local Settings\\Software\\Microsoft\\Windows\\CurrentVersion\\"
                       "AppModel\\Repository\\Packages",
               "Microsoft.StorePurchaseApp_8wekyb3d8bbwe");
  fr.set("HKCU", "SOFTWARE\\Classes\\Local Settings\\Software\\Microsoft\\Windows\\CurrentVersion\\"
                 "AppModel\\Repository\\Packages\\Microsoft.TestGame_8wekyb3d8bbwe",
         "PackageRootFolder", pkgRoot.string());
  fr.set("HKCU", "SOFTWARE\\Classes\\Local Settings\\Software\\Microsoft\\Windows\\CurrentVersion\\"
                 "AppModel\\Repository\\Packages\\Microsoft.StorePurchaseApp_8wekyb3d8bbwe",
         "PackageRootFolder", (dir.root / "Microsoft.StorePurchaseApp_8wekyb3d8bbwe").string());

  ScanContext ctx;
  ctx.readRegistry = [&](const std::string& h, const std::string& k, const std::string& v) {
    return fr.read(h, k, v);
  };
  ctx.listRegistryKeys = [&](const std::string& h, const std::string& k) { return fr.list(h, k); };
  ctx.msStorePackagesKey = "SOFTWARE\\Classes\\Local Settings\\Software\\Microsoft\\Windows\\CurrentVersion\\"
                           "AppModel\\Repository\\Packages";
  const auto games = LauncherDiscovery::scanMsStore(ctx);
  CHECK_EQ(games.size(), (size_t)1); // bloat filtered out
  if (!games.empty())
    CHECK_EQ(games[0].id, std::string("d:msstore:Microsoft.TestGame_8wekyb3d8bbwe"));
}

static void testGogDiscovery()
{
  FakeRegistryHelper fr;
  fr.addSubKey("HKLM", "SOFTWARE\\WOW6432Node\\GOG.com\\Games", "1207658910");
  fr.set("HKLM", "SOFTWARE\\WOW6432Node\\GOG.com\\Games\\1207658910", "gameName", "The Witcher 3");
  fr.set("HKLM", "SOFTWARE\\WOW6432Node\\GOG.com\\Games\\1207658910", "gameExe",
         "games\\The Witcher 3\\bin\\x64\\witcher3.exe");
  fr.set("HKLM", "SOFTWARE\\WOW6432Node\\GOG.com\\Games\\1207658910", "path", "C:\\GOG Games\\The Witcher 3");

  ScanContext ctx;
  ctx.readRegistry = [&](const std::string& h, const std::string& k, const std::string& v) {
    return fr.read(h, k, v);
  };
  ctx.listRegistryKeys = [&](const std::string& h, const std::string& k) { return fr.list(h, k); };
  const auto games = LauncherDiscovery::scanGog(ctx);
  CHECK_EQ(games.size(), (size_t)1);
  if (!games.empty())
    CHECK_EQ(games[0].name, std::string("The Witcher 3"));
}

static void testRiotDiscovery()
{
  TestDir dir("riot");
  writeFile(dir.root / "RiotClientInstalls.json",
            R"({"associated_game_clients":{"valorant_live":{"product_install_full_path":")" +
                jsonEscape(dir.root.string()) + R"(\\VALORANT","product_name":"VALORANT"}}})");
  writeFile(dir.root / "VALORANT" / "VALORANT.exe", "x");

  ScanContext ctx;
  ctx.riotInstallsFile = (dir.root / "RiotClientInstalls.json").string();
  const auto games = LauncherDiscovery::scanRiot(ctx);
  CHECK_EQ(games.size(), (size_t)1);
  if (!games.empty())
    CHECK_EQ(games[0].name, std::string("VALORANT"));
}

static void testExeScanNoiseFiltering()
{
  TestDir dir("scan");
  writeFile(dir.root / "game.exe", "x");
  writeFile(dir.root / "unins000.exe", "x");
  writeFile(dir.root / "setup.exe", "x");
  writeFile(dir.root / "redist" / "vcredist_x64.exe", "x");
  writeFile(dir.root / "bin" / "win64" / "engine.exe", "x");
  writeFile(dir.root / "bin" / "win64" / "deep" / "too-deep.exe", "x");
  const auto exes = LauncherDiscovery::scanDirForExes(dir.root.string(), 3, 25);
  CHECK(exes.size() >= 2 && exes.size() <= 3);
  CHECK(std::find(exes.begin(), exes.end(), "game.exe") != exes.end());
  CHECK(std::find(exes.begin(), exes.end(), "engine.exe") != exes.end());
  CHECK(std::find(exes.begin(), exes.end(), "unins000.exe") == exes.end());
  CHECK(std::find(exes.begin(), exes.end(), "setup.exe") == exes.end());
  CHECK(std::find(exes.begin(), exes.end(), "too-deep.exe") == exes.end());
}

// -------------------------------------------------------------------- main --

int main()
{
  try {
    // Registry
    testNoBuiltinLayer();
    std::printf("ok: registry/no-builtin\n");
    testV1Migration();
    std::printf("ok: registry/v1-migration\n");
    testPersistenceRoundTrip();
    std::printf("ok: registry/persistence\n");
    testUserPrecedence();
    std::printf("ok: registry/precedence\n");
    testDiscoveredMergeByName();
    std::printf("ok: registry/merge\n");
    testRemoveUserAndDiscovered();
    std::printf("ok: registry/remove\n");
    // Detector
    testDetectorUserGame();
    std::printf("ok: detector/user\n");
    testDetectorNonGames();
    std::printf("ok: detector/non-games\n");
    testDetectorLauncherChain();
    std::printf("ok: detector/launcher-chain\n");
    testDetectorUserIgnoreWins();
    std::printf("ok: detector/ignore\n");
    testDetectorMultiExeIdentity();
    std::printf("ok: detector/multi-exe\n");
    testDetectorEmulatorFlag();
    std::printf("ok: detector/emulator\n");
    // Sessions
    testSessionLifecycle();
    std::printf("ok: session/lifecycle\n");
    testSessionMultiPidDedupe();
    std::printf("ok: session/multi-pid\n");
    testSessionPrimarySwitchAndFocus();
    std::printf("ok: session/primary-focus\n");
    // Launchers
    testSteamDiscovery();
    std::printf("ok: launcher/steam\n");
    testEpicDiscovery();
    std::printf("ok: launcher/epic\n");
    testHeroicDiscovery();
    std::printf("ok: launcher/heroic\n");
    testCustomFolderDiscovery();
    std::printf("ok: launcher/custom\n");
    testMsStoreDiscovery();
    std::printf("ok: launcher/msstore\n");
    testGogDiscovery();
    std::printf("ok: launcher/gog\n");
    testRiotDiscovery();
    std::printf("ok: launcher/riot\n");
    testExeScanNoiseFiltering();
    std::printf("ok: launcher/exe-scan\n");
  } catch (const std::exception& e) {
    std::printf("EXCEPTION: %s\n", e.what());
    return 3;
  } catch (...) {
    std::printf("UNKNOWN EXCEPTION\n");
    return 3;
  }

  std::printf("\n%d checks, %d failures\n", g_checks, g_failures);
  return g_failures == 0 ? 0 : 1;
}
