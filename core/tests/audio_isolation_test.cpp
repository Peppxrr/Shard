// Per-application audio isolation: config migration, row routing and the
// process/session partition. No OBS, WASAPI or audio hardware.
// Build: cmake --build build_x64 --config Debug --target shard_audio_isolation_tests
// Run:   build_x64/Debug/shard_audio_isolation_tests.exe
#include "audio_isolation.h"
#include "config.h"

#include <nlohmann/json.hpp>

#include <algorithm>
#include <cstdio>
#include <string>
#include <vector>

using namespace shard;

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

namespace {

AudioSourceConfig device(const std::string& kind, const std::string& id, bool enabled = true)
{
  AudioSourceConfig c;
  c.kind = kind;
  c.id = id;
  c.name = id;
  c.enabled = enabled;
  return c;
}

AudioSourceConfig app(const std::string& exe, bool exclude, bool enabled = true)
{
  AudioSourceConfig c;
  c.kind = "process";
  c.window = "::" + exe;
  c.name = "App: " + exe;
  c.excludeFromDesktop = exclude;
  c.enabled = enabled;
  return c;
}

AudioProcess proc(uint32_t pid, uint32_t parent, const std::string& exe, uint64_t created)
{
  return {pid, parent, exe, created};
}

std::vector<uint32_t> pids(const std::vector<AudioProcessKey>& keys)
{
  std::vector<uint32_t> out;
  for (const auto& key : keys)
    out.push_back(key.pid);
  return out;
}

using V = std::vector<uint32_t>;

// explorer launches Discord and Spotify; Chromium-style apps render from a
// utility child process, which is what owns the endpoint audio session.
std::vector<AudioProcess> desktopProcesses()
{
  return {
      proc(4, 0, "system", 1),
      proc(10, 4, "wininit.exe", 2),
      proc(50, 10, "explorer.exe", 5),
      proc(100, 50, "discord.exe", 10),
      proc(101, 100, "discord.exe", 11), // audio utility
      proc(102, 100, "discord.exe", 12), // gpu
      proc(200, 50, "spotify.exe", 20),
      proc(201, 200, "spotify.exe", 21), // audio utility
      proc(300, 50, "chrome.exe", 30),
      proc(301, 300, "chrome.exe", 31), // audio utility
      proc(400, 50, "game.exe", 40),
  };
}

void testConfigMigration()
{
  // Configs written before isolation existed keep the duplicate-capture path.
  const auto legacy = AudioSourceConfig::fromJson(
      nlohmann::json::parse(R"({"id":"","name":"App: spotify.exe","kind":"process","window":"::spotify.exe","gain":1,"enabled":true})"));
  CHECK(!legacy.excludeFromDesktop);

  const auto isolated = AudioSourceConfig::fromJson(
      nlohmann::json::parse(R"({"kind":"process","window":"::spotify.exe","excludeFromDesktop":true})"));
  CHECK(isolated.excludeFromDesktop);
  CHECK(AudioSourceConfig::fromJson(isolated.toJson()).excludeFromDesktop);

  // Only process rows can be isolated; malformed values are off.
  CHECK(!AudioSourceConfig::fromJson(nlohmann::json::parse(R"({"kind":"output","id":"x","excludeFromDesktop":true})"))
             .excludeFromDesktop);
  CHECK(!AudioSourceConfig::fromJson(nlohmann::json::parse(R"({"kind":"process","excludeFromDesktop":"yes"})"))
             .excludeFromDesktop);

  // Toggling isolation is an audio change but never a track-count change.
  Config config;
  config.applyPartial(nlohmann::json::parse(
      R"({"audio":{"sources":[{"kind":"output","id":"vm"},{"kind":"process","window":"::spotify.exe"}]}})"));
  CHECK(config.audioSources.size() == 2);
  CHECK(!config.audioSources[1].excludeFromDesktop);
  const auto touched = config.applyPartial(nlohmann::json::parse(
      R"({"audio":{"sources":[{"kind":"output","id":"vm"},{"kind":"process","window":"::spotify.exe","excludeFromDesktop":true}]}})"));
  CHECK(std::find(touched.begin(), touched.end(), "audio") != touched.end());
  CHECK(config.audioSources.size() == 2);
  CHECK(config.audioSources[1].excludeFromDesktop);
}

void testWindowDescriptor()
{
  CHECK(isolationExeFromWindow("::spotify.exe") == "spotify.exe");
  CHECK(isolationExeFromWindow("::Spotify.EXE ") == "spotify.exe");
  CHECK(isolationExeFromWindow("Chrome_WidgetWin_1:Spotify Premium:Spotify.exe") == "spotify.exe");
  CHECK(isolationExeFromWindow("cls:a#3Ab:my#22app.exe") == "my#app.exe");
  CHECK(isolationExeFromWindow("::") == "");
  CHECK(isolationExeFromWindow("") == "");
}

void testRouting()
{
  // Mix 0 plus a stable per-row mix; rows past the fifth share mix 5.
  CHECK(audioMixersForRow(0) == ((1u << 0) | (1u << 1)));
  CHECK(audioMixersForRow(4) == ((1u << 0) | (1u << 5)));
  CHECK(audioMixersForRow(7) == ((1u << 0) | (1u << 5)));

  // Existing config: nothing isolated, original OBS routes.
  auto plan = routeAudioSources({device("output", "vm"), device("input", "mic"), app("spotify.exe", false)}, true);
  CHECK(plan.routes == std::vector<AudioRowRoute>({AudioRowRoute::Device, AudioRowRoute::Device, AudioRowRoute::AppWindow}));
  CHECK(plan.isolatedExes.empty());

  // VoiceMeeter case: desktop is filtered, Spotify isolated, mic untouched.
  plan = routeAudioSources({device("output", "vm"), app("Spotify.exe", true), device("input", "mic")}, true);
  CHECK(plan.routes == std::vector<AudioRowRoute>(
                           {AudioRowRoute::FilteredDesktop, AudioRowRoute::IsolatedApp, AudioRowRoute::Device}));
  CHECK(plan.isolatedExes == std::vector<std::string>({"spotify.exe"}));

  // Disabled isolated app: desktop returns to whole-endpoint loopback.
  plan = routeAudioSources({device("output", "vm"), app("spotify.exe", true, false)}, true);
  CHECK(plan.routes == std::vector<AudioRowRoute>({AudioRowRoute::Device, AudioRowRoute::Disabled}));

  // Disabled desktop row keeps its reserved mix; the app is still isolated.
  plan = routeAudioSources({device("output", "vm", false), app("spotify.exe", true)}, true);
  CHECK(plan.routes == std::vector<AudioRowRoute>({AudioRowRoute::Disabled, AudioRowRoute::IsolatedApp}));

  // App without any desktop source still captures normally.
  plan = routeAudioSources({app("spotify.exe", true)}, true);
  CHECK(plan.routes == std::vector<AudioRowRoute>({AudioRowRoute::IsolatedApp}));

  // An isolated row with no app chosen yet isolates nothing.
  plan = routeAudioSources({device("output", "vm"), app("", true)}, true);
  CHECK(plan.routes == std::vector<AudioRowRoute>({AudioRowRoute::Device, AudioRowRoute::AppWindow}));

  // Two isolated apps, mixed with a non-isolated one, duplicates collapsed.
  plan = routeAudioSources({device("output", "vm"), app("discord.exe", true), app("spotify.exe", true),
                            app("chrome.exe", false), app("SPOTIFY.exe", true)},
                           true);
  CHECK(plan.isolatedExes == std::vector<std::string>({"discord.exe", "spotify.exe"}));
  CHECK(plan.routes[3] == AudioRowRoute::AppWindow);

  // Without process loopback support nothing is filtered, and it is reported.
  plan = routeAudioSources({device("output", "vm"), app("spotify.exe", true)}, false);
  CHECK(plan.isolationUnavailable);
  CHECK(plan.routes == std::vector<AudioRowRoute>({AudioRowRoute::Device, AudioRowRoute::AppWindow}));
  CHECK(!routeAudioSources({device("output", "vm")}, false).isolationUnavailable);
}

void testVoicemeeterPartition()
{
  const AudioProcessForest forest(desktopProcesses());
  // Both Discord and Spotify render to the VoiceMeeter endpoint.
  const auto plan = planAudioIsolation(forest, {"spotify.exe"}, {{true, {101, 201}}});
  CHECK(pids(plan.desktopRoots[0]) == V({101}));
  CHECK(pids(plan.appRoots.at("spotify.exe")) == V({200}));
  CHECK(plan.excluded.size() == 1 && plan.excluded[0].session.pid == 201 && plan.excluded[0].isolatedExe == "spotify.exe");
  CHECK(plan.overlaps.empty());
}

void testTwoIsolatedApps()
{
  const AudioProcessForest forest(desktopProcesses());
  const auto plan = planAudioIsolation(forest, {"discord.exe", "spotify.exe"}, {{true, {101, 201, 301}}});
  CHECK(pids(plan.desktopRoots[0]) == V({301}));
  CHECK(pids(plan.appRoots.at("discord.exe")) == V({100}));
  CHECK(pids(plan.appRoots.at("spotify.exe")) == V({200}));
  CHECK(plan.excluded.size() == 2);
  CHECK(plan.overlaps.empty());
}

void testAppLifecycle()
{
  // Not running yet (and not rendering): no capture, Desktop unaffected.
  auto processes = desktopProcesses();
  processes.erase(std::remove_if(processes.begin(), processes.end(),
                                 [](const AudioProcess& p) { return p.exe == "spotify.exe"; }),
                  processes.end());
  auto plan = planAudioIsolation(AudioProcessForest(processes), {"spotify.exe"}, {{true, {101}}});
  CHECK(plan.appRoots.at("spotify.exe").empty());
  CHECK(pids(plan.desktopRoots[0]) == V({101}));

  // Starts halfway through: picked up by executable without any session yet.
  processes.push_back(proc(600, 50, "spotify.exe", 60));
  plan = planAudioIsolation(AudioProcessForest(processes), {"spotify.exe"}, {{true, {101}}});
  CHECK(pids(plan.appRoots.at("spotify.exe")) == V({600}));

  // Restart with a new PID: the old root is gone, the new one is captured
  // and its new audio utility session is still kept out of Desktop.
  processes.back() = proc(700, 50, "spotify.exe", 70);
  processes.push_back(proc(701, 700, "spotify.exe", 71));
  plan = planAudioIsolation(AudioProcessForest(processes), {"spotify.exe"}, {{true, {101, 701}}});
  CHECK(pids(plan.appRoots.at("spotify.exe")) == V({700}));
  CHECK(pids(plan.desktopRoots[0]) == V({101}));

  // Two independent instances are both captured.
  processes.push_back(proc(800, 50, "spotify.exe", 80));
  plan = planAudioIsolation(AudioProcessForest(processes), {"spotify.exe"}, {});
  CHECK(pids(plan.appRoots.at("spotify.exe")) == V({700, 800}));
}

void testProcessTrees()
{
  auto processes = desktopProcesses();
  // A helper with another exe launched by Spotify belongs to Spotify's tree.
  processes.push_back(proc(210, 200, "crashpad_handler.exe", 22));
  // A process whose parent PID was reused by a younger Spotify process is
  // not part of that tree.
  processes.push_back(proc(900, 950, "tool.exe", 90));
  processes.push_back(proc(950, 50, "spotify.exe", 95));
  auto plan = planAudioIsolation(AudioProcessForest(processes), {"spotify.exe"}, {{true, {210, 900}}});
  CHECK(pids(plan.desktopRoots[0]) == V({900}));
  CHECK(plan.excluded.size() == 1 && plan.excluded[0].session.pid == 210);
  CHECK(pids(plan.appRoots.at("spotify.exe")) == V({200, 950}));

  // Sessions of a parent and its child: the parent's tree already includes
  // the child, so only one Desktop capture exists.
  plan = planAudioIsolation(AudioProcessForest(desktopProcesses()), {"spotify.exe"}, {{true, {300, 301}}});
  CHECK(pids(plan.desktopRoots[0]) == V({300}));

  // Session owners that exited before the snapshot and idle/system PIDs are skipped.
  plan = planAudioIsolation(AudioProcessForest(desktopProcesses()), {"spotify.exe"}, {{true, {0, 4, 12345, 400}}});
  CHECK(pids(plan.desktopRoots[0]) == V({400}));
}

void testOverlapIsReported()
{
  // explorer.exe owns a session and is Spotify's parent: its tree capture
  // would also contain Spotify, which is surfaced as degraded isolation.
  const auto plan = planAudioIsolation(AudioProcessForest(desktopProcesses()), {"spotify.exe"}, {{true, {50, 101}}});
  CHECK(pids(plan.desktopRoots[0]) == V({50}));
  CHECK(plan.overlaps.size() == 1);
  CHECK(plan.overlaps[0].outer.pid == 50 && plan.overlaps[0].inner.pid == 200);
  CHECK(plan.overlaps[0].outerTrack == "desktop:0" && plan.overlaps[0].innerTrack == "app:spotify.exe");

  // One isolated app launching another is reported too.
  auto processes = desktopProcesses();
  processes.push_back(proc(500, 100, "game.exe", 50));
  const auto nested = planAudioIsolation(AudioProcessForest(processes), {"discord.exe", "game.exe"}, {});
  CHECK(nested.overlaps.size() == 1 && nested.overlaps[0].outerTrack == "app:discord.exe" &&
        nested.overlaps[0].innerTrack == "app:game.exe");
}

void testEndpoints()
{
  const AudioProcessForest forest(desktopProcesses());
  // A process with sessions on two filtered endpoints is captured once.
  auto plan = planAudioIsolation(forest, {"spotify.exe"}, {{true, {101, 301}}, {true, {301, 400}}});
  CHECK(pids(plan.desktopRoots[0]) == V({101, 301}));
  CHECK(pids(plan.desktopRoots[1]) == V({400}));

  // An unavailable endpoint contributes nothing until it returns.
  plan = planAudioIsolation(forest, {"spotify.exe"}, {{false, {101}}, {true, {400}}});
  CHECK(plan.desktopRoots[0].empty());
  CHECK(pids(plan.desktopRoots[1]) == V({400}));

  // Physical output without VoiceMeeter: same partition rules.
  plan = planAudioIsolation(forest, {"discord.exe"}, {{true, {101, 201, 400}}});
  CHECK(pids(plan.desktopRoots[0]) == V({201, 400}));
  CHECK(pids(plan.appRoots.at("discord.exe")) == V({100}));
}

} // namespace

int main()
{
  testConfigMigration();
  testWindowDescriptor();
  testRouting();
  testVoicemeeterPartition();
  testTwoIsolatedApps();
  testAppLifecycle();
  testProcessTrees();
  testOverlapIsReported();
  testEndpoints();
  std::printf("%d checks, %d failures\n", g_checks, g_failures);
  return g_failures ? 1 : 0;
}
