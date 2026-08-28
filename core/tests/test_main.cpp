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
                 int64_t startMs = 1000, const std::string& commandLine = "")
{
  ProcessInfo p;
  p.exe = exe;
  p.pid = pid;
  p.parentPid = parent;
  p.path = path;
  p.commandLine = commandLine;
  p.startMs = startMs;
  return p;
}

DetectionResult detectWith(const GameRegistry& reg, const ProcessInfo& p,
                           std::function<std::vector<uint32_t>(uint32_t)> chain = {},
                           std::function<ProcessInfo(uint32_t)> lookup = {}, WindowFacts wf = {},
                           int64_t nowMs = 60000, RuntimeFacts runtime = {},
                           int64_t foregroundIntentMs = 0, const GameDefinition* productHint = nullptr)
{
  DetectContext ctx;
  ctx.registry = &reg;
  ctx.productHint = productHint;
  ctx.chain = chain ? chain : std::function<std::vector<uint32_t>(uint32_t)>([](uint32_t id) {
    return std::vector<uint32_t>{id};
  });
  ctx.lookup = lookup ? lookup : std::function<ProcessInfo(uint32_t)>([](uint32_t) { return ProcessInfo{}; });
  ctx.window = wf;
  ctx.runtime = runtime;
  ctx.nowMs = nowMs;
  ctx.recentProcess = p.startMs > 0 && nowMs >= p.startMs && nowMs - p.startMs <= 15000;
  ctx.foregroundIntentMs = foregroundIntentMs;
  return GameDetector::detect(p, ctx);
}

WindowFacts gameWindow(bool foreground = true, const std::string& title = "")
{
  WindowFacts facts;
  facts.hasVisibleWindow = true;
  facts.title = title;
  facts.captureable = true;
  facts.foreground = foreground;
  facts.area = (int64_t)1280 * 720;
  return facts;
}

RuntimeFacts graphicsRuntime(bool gameRuntime = false)
{
  RuntimeFacts facts;
  facts.probeSucceeded = true;
  facts.graphicsApi = true;
  facts.gameRuntime = gameRuntime;
  return facts;
}

RuntimeFacts gameInputRuntime()
{
  RuntimeFacts facts = graphicsRuntime();
  facts.gameInput = true;
  return facts;
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
  }
}

static void testV9RegistryMigration()
{
  TestDir dir("v9-migration");
  const fs::path path = dir.root / "games.json";
  {
    std::ofstream out(path);
    out << R"({"version":9,"user":[{"id":"u:kept","name":"Kept","executables":["kept.exe"]}],)"
           R"("discovered":[{"id":"d:runtime:web-host","name":"Old Hosted App False Positive",)"
           R"("executables":["chat-host.exe"],"installPaths":["c:\\tools\\"],)"
           R"("launchers":[{"type":"runtime","id":"web-host"}]},)"
           R"({"id":"d:steam:365670","name":"Unqualified Launcher Product","executables":[],)"
           R"("installPaths":["c:\\steam\\blender\\"],"launchers":[{"type":"steam","id":"365670"}]}],)"
           R"("customFolders":[{"id":"c:old","name":"Old","path":"c:\\games"}],)"
           R"("launchers":{"steam":false},"hiddenDiscoveredIds":["d:steam:438100"],)"
           R"("ignoredExes":["snippingtool.exe"]})";
  }
  GameRegistry registry;
  registry.setPath(path.string());
  registry.load();
  CHECK(registry.findByExe("kept.exe") != nullptr);
  CHECK(registry.findByExe("player.exe") == nullptr);
  CHECK(registry.discoveredGames().empty());
  CHECK(registry.isIgnoredExe("snippingtool.exe"));
  {
    std::ifstream persistedFile(path);
    nlohmann::json persisted;
    persistedFile >> persisted;
    CHECK_EQ(persisted.value("version", 0), 10);
    CHECK(!persisted.contains("customFolders"));
    CHECK(!persisted.contains("launchers"));
  }

  GameDefinition vrchat;
  vrchat.id = "d:steam:438100";
  vrchat.name = "VRChat";
  vrchat.installPaths = {"c:\\games\\vrchat\\"};
  vrchat.launchers = {{"steam", "438100"}};
  vrchat.productType = "game";
  registry.mergeDiscovered(vrchat);
  CHECK(registry.findById("d:steam:438100") != nullptr);
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
  GameDefinition game;
  game.name = "User Game";
  game.executables = {"ugame.exe"};
  reg.upsertUserGame(game);

  const auto explicitResult = detectWith(reg, proc("ugame.exe", 100), {}, {}, gameWindow(false));
  CHECK_EQ((int)explicitResult.decision, (int)DetectionResult::Decision::Detected);
  CHECK_EQ(explicitResult.gameName, std::string("User Game"));

  const auto loading = detectWith(reg, proc("new-game.exe", 101), {}, {}, gameWindow());
  CHECK_EQ((int)loading.decision, (int)DetectionResult::Decision::Candidate);

  const auto liveUnknown =
      detectWith(reg, proc("new-game.exe", 101, 0, "", 59000), {}, {}, gameWindow(), 60000,
                 graphicsRuntime(true));
  CHECK_EQ((int)liveUnknown.decision, (int)DetectionResult::Decision::Detected);
  CHECK(liveUnknown.gameId.empty());
  CHECK_EQ(liveUnknown.gameName, std::string("new-game"));

  const auto minecraft =
      detectWith(reg, proc("javaw.exe", 102, 50, "c:\\java\\bin\\javaw.exe", 59000), {}, {},
                 gameWindow(true, "Minecraft 1.21.4"), 60000, graphicsRuntime(true));
  CHECK_EQ((int)minecraft.decision, (int)DetectionResult::Decision::Detected);
  CHECK_EQ(minecraft.gameName, std::string("Minecraft 1.21.4"));
  CHECK(!GameDetector::canOwnQualifiedDescendant("d:runtime:curseforge"));
  CHECK(GameDetector::canOwnQualifiedDescendant("d:steam:438100"));
  CHECK(GameDetector::canOwnQualifiedDescendant("u:minecraft"));
}

static void testDetectorNonGames()
{
  GameRegistry reg;
  reg.setPath((fs::temp_directory_path() / "shard-tests-det2.json").string());
  reg.load();

  CHECK_EQ((int)detectWith(reg, proc("steam.exe", 201), {}, {}, gameWindow(), 60000,
                           graphicsRuntime(true)).decision,
           (int)DetectionResult::Decision::Ignored);
  CHECK_EQ((int)detectWith(reg, proc("svchost.exe", 202), {}, {}, gameWindow(), 60000,
                           graphicsRuntime(true)).decision,
           (int)DetectionResult::Decision::Ignored);

  // A generic D3D renderer is not semantic game evidence. Long foreground
  // dwell must never turn an unknown application into a game.
  const ProcessInfo renderer =
      proc("arbitrary-renderer.exe", 203, 0, "d:\\tools\\arbitrary-renderer.exe",
           59000);
  CHECK_EQ((int)detectWith(reg, renderer, {}, {}, gameWindow(), 60000,
                           graphicsRuntime()).decision,
           (int)DetectionResult::Decision::Candidate);
  CHECK_EQ((int)detectWith(reg, renderer, {}, {}, gameWindow(), 60000,
                           graphicsRuntime(), 10000).decision,
           (int)DetectionResult::Decision::Candidate);
  WindowFacts fullscreenGui = gameWindow(true, "Python GUI");
  fullscreenGui.fullscreen = true;
  CHECK((int)detectWith(reg,
                        proc("pythonw.exe", 210, 0, "c:\\python\\pythonw.exe", 59000),
                        {}, {}, fullscreenGui, 60000, graphicsRuntime(), 10000).decision !=
        (int)DetectionResult::Decision::Detected);
  // Dolphin exposes D3D/OpenGL plus Windows.Gaming.Input and XInput/DirectInput,
  // but no engine DLL or launcher metadata. Independent gaming-input evidence
  // restores it after a dwell without restoring generic GPU-window detection.
  const ProcessInfo dolphin =
      proc("dolphin.exe", 213, 0, "e:\\games\\dolphin\\dolphin.exe", 1000);
  CHECK_EQ((int)detectWith(reg, dolphin, {}, {}, gameWindow(true, "Dolphin 2512"), 60000,
                           gameInputRuntime()).decision,
           (int)DetectionResult::Decision::Candidate);
  const auto dolphinDetected =
      detectWith(reg, dolphin, {}, {}, gameWindow(true, "Dolphin 2512"), 60000,
                 gameInputRuntime(), 2600);
  CHECK_EQ((int)dolphinDetected.decision, (int)DetectionResult::Decision::Detected);
  CHECK_EQ(dolphinDetected.gameName, std::string("Dolphin 2512"));
  GameDefinition packagedTool;
  packagedTool.id = "d:msstore:screensketch";
  packagedTool.name = "Snipping Tool";
  packagedTool.installPaths = {"c:\\program files\\windowsapps\\microsoft.screensketch_11.0\\"};
  packagedTool.launchers = {{"msstore", "screensketch"}};
  packagedTool.productType = "game"; // provider metadata must not bypass the OS-app guard
  reg.mergeDiscovered(packagedTool);
  WindowFacts screenshotWindow = gameWindow();
  screenshotWindow.fullscreen = true;
  const auto snippingTool = detectWith(
      reg,
      proc("snippingtool.exe", 206, 0,
           "c:\\program files\\windowsapps\\microsoft.screensketch_11.0\\snippingtool.exe", 59000),
      {}, {}, screenshotWindow, 60000, graphicsRuntime(), 3000);
  CHECK_EQ((int)snippingTool.decision, (int)DetectionResult::Decision::Ignored);
  RuntimeFacts webRuntime = graphicsRuntime();
  webRuntime.webRuntime = true;
  CHECK((int)detectWith(reg, proc("chat-app.exe", 205, 0, "", 59000), {}, {}, gameWindow(), 60000,
                        webRuntime).decision != (int)DetectionResult::Decision::Detected);
  GameDefinition oldHostedApp;
  oldHostedApp.id = "d:runtime:web-host";
  oldHostedApp.name = "Hosted App";
  oldHostedApp.executables = {"hosted-app.exe"};
  oldHostedApp.installPaths = {"c:\\apps\\hosted\\"};
  oldHostedApp.launchers = {{"runtime", "web-host"}};
  oldHostedApp.productType = "game";
  reg.mergeDiscovered(oldHostedApp);
  CHECK_EQ((int)detectWith(reg, proc("hosted-app.exe", 209, 0, "c:\\apps\\hosted\\hosted-app.exe", 59000),
                           {}, {}, gameWindow(), 60000, webRuntime, 3000).decision,
           (int)DetectionResult::Decision::Ignored);
  GameDefinition staleRuntimeProduct;
  staleRuntimeProduct.id = "d:runtime:old-gui";
  staleRuntimeProduct.name = "Old GUI False Positive";
  staleRuntimeProduct.executables = {"old-gui.exe"};
  staleRuntimeProduct.installPaths = {"c:\\apps\\old-gui\\"};
  staleRuntimeProduct.launchers = {{"runtime", "old-gui"}};
  staleRuntimeProduct.productType = "game";
  reg.mergeDiscovered(staleRuntimeProduct);
  CHECK((int)detectWith(reg,
                        proc("old-gui.exe", 211, 0, "c:\\apps\\old-gui\\old-gui.exe", 59000),
                        {}, {}, gameWindow(), 60000, graphicsRuntime(), 10000).decision !=
        (int)DetectionResult::Decision::Detected);
  CHECK_EQ((int)detectWith(reg, proc("explorer.exe", 212), {}, {}, fullscreenGui, 60000,
                           graphicsRuntime(true), 10000).decision,
           (int)DetectionResult::Decision::Ignored);
  const ProcessInfo mediaPlayer =
      proc("player.exe", 207, 0, "c:\\tools\\player.exe", 59000,
           "player.exe c:\\videos\\movie.mkv --fullscreen");
  CHECK_EQ((int)detectWith(reg, mediaPlayer, {}, {}, gameWindow(true, "movie.mkv"), 60000,
                           graphicsRuntime(), 3000).decision,
           (int)DetectionResult::Decision::Ignored);
  RuntimeFacts mediaFramework = graphicsRuntime();
  mediaFramework.mediaRuntime = true;
  CHECK_EQ((int)detectWith(reg, proc("player.exe", 208, 0, "c:\\tools\\player.exe", 59000),
                           {}, {}, gameWindow(), 60000, mediaFramework, 3000).decision,
           (int)DetectionResult::Decision::Ignored);
  CHECK_EQ((int)detectWith(reg, proc("background.exe", 204)).decision,
           (int)DetectionResult::Decision::Ignored);
}

static void testDetectorLauncherChain()
{
  TestDir dir("detector-hint");
  GameRegistry reg;
  reg.setPath((dir.root / "games.json").string());
  reg.load();
  GameDefinition game;
  game.id = "d:steam:1001";
  game.name = "Launcher Game";
  game.installPaths = {"c:\\steam\\lgame\\"};
  game.launchers = {{"steam", "1001"}};
  game.productType = "game";

  auto chain = [](uint32_t id) {
    if (id == 300 || id == 303 || id == 304)
      return std::vector<uint32_t>{id, 301, 302};
    return std::vector<uint32_t>{id};
  };
  auto lookup = [](uint32_t id) {
    ProcessInfo p;
    p.pid = id;
    if (id == 301)
      p.exe = "steam.exe";
    return p;
  };

  const ProcessInfo renderer = proc("real-renderer.exe", 300, 301, "c:\\steam\\lgame\\bin\\real-renderer.exe");
  const auto detectedResult =
      detectWith(reg, renderer, chain, lookup, gameWindow(), 60000, graphicsRuntime(), 0, &game);
  CHECK_EQ((int)detectedResult.decision, (int)DetectionResult::Decision::Detected);
  CHECK_EQ(detectedResult.gameId, std::string("d:steam:1001"));
  CHECK_EQ(detectedResult.launcher, std::string("steam"));
  CHECK(reg.discoveredGames().empty());
  GameDefinition qualified = game;
  qualified.executables = {renderer.exe};
  reg.mergeDiscovered(qualified);
  CHECK_EQ(reg.discoveredGames().size(), (size_t)1);

  // Launcher ancestry and directory containment cannot admit a helper without
  // renderer evidence.
  const ProcessInfo helper = proc("helper.exe", 303, 301, "c:\\steam\\lgame\\helper.exe");
  const auto helperResult =
      detectWith(reg, helper, chain, lookup, gameWindow(), 60000, RuntimeFacts{}, 0, &game);
  CHECK((int)helperResult.decision != (int)DetectionResult::Decision::Detected);

  const ProcessInfo arbitrary = proc("arbitrary.exe", 304, 301, "c:\\other\\arbitrary.exe");
  const auto arbitraryResult = detectWith(reg, arbitrary, chain, lookup, gameWindow());
  CHECK((int)arbitraryResult.decision != (int)DetectionResult::Decision::Detected);
}

static void testDetectorUserIgnoreWins()
{
  GameRegistry reg;
  reg.setPath((fs::temp_directory_path() / "shard-tests-det4.json").string());
  reg.load();
  GameDefinition game;
  game.name = "Ignored Game";
  game.executables = {"igame.exe"};
  reg.upsertUserGame(game);
  reg.addIgnoredExe("igame.exe");
  WindowFacts window = gameWindow();
  window.fullscreen = true;
  const auto result = detectWith(reg, proc("igame.exe", 400), {}, {}, window, 60000, graphicsRuntime(true));
  CHECK_EQ((int)result.decision, (int)DetectionResult::Decision::Ignored);
}

static void testDetectorMultiExeIdentity()
{
  GameRegistry reg;
  reg.setPath((fs::temp_directory_path() / "shard-tests-det5.json").string());
  reg.load();
  GameDefinition game;
  game.name = "Multi Exe Game";
  game.executables = {"main.exe", "win64-shipping.exe"};
  reg.upsertUserGame(game);
  const auto a = detectWith(reg, proc("main.exe", 500), {}, {}, gameWindow(false));
  const auto b = detectWith(reg, proc("win64-shipping.exe", 501), {}, {}, gameWindow(false));
  CHECK_EQ((int)a.decision, (int)DetectionResult::Decision::Detected);
  CHECK_EQ((int)b.decision, (int)DetectionResult::Decision::Detected);
  CHECK_EQ(a.gameId, b.gameId);
}

static void testDetectorEmulatorFlag()
{
  GameRegistry reg;
  reg.setPath((fs::temp_directory_path() / "shard-tests-det7.json").string());
  reg.load();
  GameDefinition game;
  game.id = "d:custom:emu:dolphin";
  game.name = "Dolphin";
  game.executables = {"dolphin.exe"};
  game.productType = "game";
  game.emulator = true;
  reg.mergeDiscovered(game);
  const auto result =
      detectWith(reg, proc("dolphin.exe", 600), {}, {}, gameWindow(), 60000, graphicsRuntime());
  CHECK_EQ((int)result.decision, (int)DetectionResult::Decision::Detected);
  CHECK(result.emulator);
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

static void appendU32(std::string& out, uint32_t value)
{
  for (int shift = 0; shift < 32; shift += 8)
    out.push_back(static_cast<char>((value >> shift) & 0xff));
}

static void appendU64(std::string& out, uint64_t value)
{
  appendU32(out, static_cast<uint32_t>(value));
  appendU32(out, static_cast<uint32_t>(value >> 32));
}

static void writeSteamAppInfo(const fs::path& path,
                              const std::vector<std::pair<uint32_t, std::string>>& products)
{
  std::string bytes;
  appendU32(bytes, 0x07564429); // appinfo v41
  appendU32(bytes, 1);          // public universe
  appendU64(bytes, 0);          // patched with string-table offset below

  for (const auto& [appid, type] : products) {
    std::string kv;
    kv.push_back(0); appendU32(kv, 0); // appinfo
    kv.push_back(0); appendU32(kv, 1); // common
    kv.push_back(1); appendU32(kv, 2); // type
    kv.append(type);
    kv.push_back('\0');
    kv.push_back(8); // end common
    kv.push_back(8); // end appinfo

    appendU32(bytes, appid);
    appendU32(bytes, static_cast<uint32_t>(60 + kv.size()));
    appendU32(bytes, 2); // info state
    appendU32(bytes, 0); // last updated
    appendU64(bytes, 0); // PICS token
    bytes.append(20, '\0');
    appendU32(bytes, 0); // change number
    bytes.append(20, '\0');
    bytes.append(kv);
  }
  appendU32(bytes, 0); // app-entry terminator

  const uint64_t tableOffset = bytes.size();
  for (int i = 0; i < 8; i++)
    bytes[8 + i] = static_cast<char>((tableOffset >> (i * 8)) & 0xff);
  appendU32(bytes, 3);
  for (const char* value : {"appinfo", "common", "type"}) {
    bytes.append(value);
    bytes.push_back('\0');
  }

  fs::create_directories(path.parent_path());
  std::ofstream out(path, std::ios::binary);
  out.write(bytes.data(), static_cast<std::streamsize>(bytes.size()));
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
  writeFile(steamRoot / "steamapps" / "appmanifest_431960.acf",
            "\"AppState\"\n{\n\t\"name\"\t\t\"Wallpaper Engine\"\n\t\"installdir\"\t\t"
            "\"wallpaper_engine\"\n}\n");
  writeFile(steamRoot / "steamapps" / "common" / "wallpaper_engine" / "wallpaper64.exe", "x");
  writeFile(steamRoot / "steamapps" / "appmanifest_4091970.acf",
            "\"AppState\"\n{\n\t\"name\"\t\t\"Baballonia\"\n\t\"installdir\"\t\t"
            "\"Baballonia\"\n}\n");
  writeFile(steamRoot / "steamapps" / "common" / "Baballonia" / "Baballonia.exe", "x");
  writeSteamAppInfo(steamRoot / "appcache" / "appinfo.vdf",
                    {{730, "Game"}, {228980, "Tool"}, {431960, "Application"}, {4091970, "Application"}});

  ScanContext ctx;
  ctx.steamLibraryFile = (steamRoot / "steamapps" / "libraryfolders.vdf").string();
  ctx.steamAppInfoFile = (steamRoot / "appcache" / "appinfo.vdf").string();
  const auto games = LauncherDiscovery::scanSteam(ctx);
  CHECK_EQ(games.size(), (size_t)4);
  const auto findProduct = [&](const std::string& id) -> const GameDefinition* {
    const auto it = std::find_if(games.begin(), games.end(),
                                 [&](const GameDefinition& game) { return game.id == id; });
    return it == games.end() ? nullptr : &*it;
  };
  const GameDefinition* cs2 = findProduct("d:steam:730");
  const GameDefinition* wallpaper = findProduct("d:steam:431960");
  const GameDefinition* baballonia = findProduct("d:steam:4091970");
  CHECK(cs2 != nullptr);
  CHECK(wallpaper != nullptr);
  CHECK(baballonia != nullptr);
  if (cs2) {
    CHECK_EQ(cs2->productType, std::string("game"));
    CHECK(cs2->executables.empty()); // Steam ACF never recursively claims an install tree.
  }
  if (wallpaper) CHECK_EQ(wallpaper->productType, std::string("software"));
  if (baballonia) CHECK_EQ(baballonia->productType, std::string("software"));

  GameRegistry registry;
  registry.setPath((dir.root / "games.json").string());
  registry.load();
  LauncherDiscovery discovery;
  GameDefinition contaminated;
  contaminated.id = "d:steam:431960";
  contaminated.name = "Wallpaper Engine";
  contaminated.executables = {"wallpaperui.exe"};
  contaminated.productType = "game";
  registry.mergeDiscovered(contaminated);
  CHECK(registry.findByExe("wallpaperui.exe") != nullptr);
  CHECK(registry.discardNonGameProduct("d:steam:431960"));
  CHECK(registry.findByExe("wallpaperui.exe") == nullptr);
  CHECK(!registry.isIgnoredExe("wallpaperui.exe"));
  discovery.setContext(ctx);
  const auto scan = discovery.scanAll();
  CHECK_EQ(scan.products.size(), (size_t)4);
  CHECK(registry.discoveredGames().empty());
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
  if (!games.empty()) {
    CHECK_EQ(games[0].name, std::string("Fortnite"));
    CHECK(games[0].executables.empty());
  }
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
    CHECK(games[0].executables.empty());
  }
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
  if (!games.empty()) {
    CHECK_EQ(games[0].name, std::string("VALORANT"));
    CHECK(games[0].executables.empty());
  }
}


static void testExplicitOverridesAndInfrastructure()
{
  TestDir dir("explicit-overrides");
  GameRegistry reg;
  reg.setPath((dir.root / "games.json").string());
  reg.load();

  // Generic helper names do not need a maintained deny list. Without positive
  // identity, even a game-oriented runtime is insufficient once the process
  // is outside the current launch episode.
  const auto helper = detectWith(reg, proc("launch.exe", 700), {}, {}, gameWindow(), 60000,
                                 graphicsRuntime(true));
  CHECK((int)helper.decision != (int)DetectionResult::Decision::Detected);

  GameDefinition explicitHelper;
  explicitHelper.name = "Launch Game";
  explicitHelper.executables = {"launch.exe"};
  reg.upsertUserGame(explicitHelper);
  const auto userOverride = detectWith(reg, proc("launch.exe", 701), {}, {}, gameWindow(false));
  CHECK_EQ((int)userOverride.decision, (int)DetectionResult::Decision::Detected);

  // Ordinary application names are not hard-coded. An explicit user mapping
  // remains authoritative.
  GameDefinition explicitOrdinary;
  explicitOrdinary.name = "Custom App Game";
  explicitOrdinary.executables = {"custom-app.exe"};
  reg.upsertUserGame(explicitOrdinary);
  const auto ordinary = detectWith(reg, proc("custom-app.exe", 702), {}, {}, gameWindow(false));
  CHECK_EQ((int)ordinary.decision, (int)DetectionResult::Decision::Detected);
}
static void testInstallPathFallbackStrongEvidence()
{
  GameRegistry reg;
  reg.setPath((fs::temp_directory_path() / "shard-tests-fallback.json").string());
  reg.load();
  GameDefinition game;
  game.id = "d:steam:999";
  game.name = "MyGame";
  game.installPaths = {"c:\\games\\mygame\\"};
  game.productType = "game";
  game.source = GameSource::Discovered;
  reg.mergeDiscovered(game);

  const ProcessInfo helper = proc("helper.exe", 800, 0, "c:\\games\\mygame\\helper.exe");
  const auto noRenderer = detectWith(reg, helper, {}, {}, gameWindow());
  CHECK((int)noRenderer.decision != (int)DetectionResult::Decision::Detected);

  // Anti-cheat/protected games may deny module enumeration. A known installed
  // product must leave Candidate after a short stable foreground dwell.
  const auto protectedCandidate =
      detectWith(reg, helper, {}, {}, gameWindow(), 60000, RuntimeFacts{}, 1000);
  CHECK((int)protectedCandidate.decision != (int)DetectionResult::Decision::Detected);
  const auto protectedGame =
      detectWith(reg, helper, {}, {}, gameWindow(), 60000, RuntimeFacts{}, 1600);
  CHECK_EQ((int)protectedGame.decision, (int)DetectionResult::Decision::Detected);
  CHECK_EQ(protectedGame.gameId, std::string("d:steam:999"));

  const auto renderer =
      detectWith(reg, helper, {}, {}, gameWindow(), 60000, graphicsRuntime());
  CHECK_EQ((int)renderer.decision, (int)DetectionResult::Decision::Detected);
  CHECK_EQ(renderer.gameId, std::string("d:steam:999"));

  const auto backgroundRenderer =
      detectWith(reg, helper, {}, {}, gameWindow(false), 60000, graphicsRuntime());
  CHECK((int)backgroundRenderer.decision != (int)DetectionResult::Decision::Detected);
}


static void testLiveUnknownEvidence()
{
  GameRegistry reg;
  reg.setPath((fs::temp_directory_path() / "shard-tests-live-unknown.json").string());
  reg.load();

  auto launcherChain = [](uint32_t id) { return std::vector<uint32_t>{id, 901}; };
  auto lookup = [](uint32_t id) {
    ProcessInfo process;
    process.pid = id;
    if (id == 901)
      process.exe = "steam.exe";
    return process;
  };

  const ProcessInfo child = proc("anything.exe", 900, 901, "c:\\other\\anything.exe");
  const auto ancestryOnly = detectWith(reg, child, launcherChain, lookup, gameWindow());
  CHECK((int)ancestryOnly.decision != (int)DetectionResult::Decision::Detected);

  // A recognized game runtime can still qualify on the first foreground tick.
  const auto immediate =
      detectWith(reg, child, launcherChain, lookup, gameWindow(), 1001, graphicsRuntime(true));
  CHECK_EQ((int)immediate.decision, (int)DetectionResult::Decision::Detected);
  CHECK(immediate.gameId.empty());

  const auto background =
      detectWith(reg, child, launcherChain, lookup, gameWindow(false), 1001, graphicsRuntime());
  CHECK((int)background.decision != (int)DetectionResult::Decision::Detected);
}

static void testRuntimeExecutablePersistence()
{
  TestDir dir("runtime-executable");
  const fs::path path = dir.root / "games.json";
  {
    GameRegistry registry;
    registry.setPath(path.string());
    registry.load();
    GameDefinition product;
    product.id = "d:steam:42";
    product.name = "Runtime Product";
    product.installPaths = {"c:\\games\\runtime\\"};
    product.launchers = {{"steam", "42"}};
    product.productType = "game";
    registry.mergeDiscovered(product);
    CHECK(registry.findByExe("qualified.exe") == nullptr);
    CHECK(registry.addRuntimeExecutable(product.id, "qualified.exe"));
  }
  {
    GameRegistry registry;
    registry.setPath(path.string());
    registry.load();
    const GameDefinition* qualified = registry.findByExe("qualified.exe");
    CHECK(qualified != nullptr);
    if (qualified)
      CHECK_EQ(qualified->id, std::string("d:steam:42"));
  }
}


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
    testV9RegistryMigration();
    std::printf("ok: registry/v9-migration\n");
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
    testMsStoreDiscovery();
    std::printf("ok: launcher/msstore\n");
    testRiotDiscovery();
    std::printf("ok: launcher/riot\n");
    testExplicitOverridesAndInfrastructure();
    std::printf("ok: detector/explicit-overrides\n");
    testInstallPathFallbackStrongEvidence();
    std::printf("ok: detector/fallback-strong\n");
    testLiveUnknownEvidence();
    std::printf("ok: system/live-unknown\n");
    testRuntimeExecutablePersistence();
    std::printf("ok: system/runtime-executable\n");
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
