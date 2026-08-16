#include "config.h"

#include <fstream>
#include <filesystem>

namespace clipforge {

namespace fs = std::filesystem;

nlohmann::json AudioSourceConfig::toJson() const
{
  return {{"id", id}, {"name", name}, {"kind", kind}, {"window", window}, {"gain", gain}, {"enabled", enabled}};
}

AudioSourceConfig AudioSourceConfig::fromJson(const nlohmann::json& j)
{
  AudioSourceConfig c;
  c.id = j.value("id", std::string());
  c.name = j.value("name", std::string());
  c.kind = j.value("kind", std::string("output"));
  c.window = j.value("window", std::string());
  c.gain = j.value("gain", 1.0f);
  c.enabled = j.value("enabled", true);
  return c;
}

nlohmann::json VideoSettings::toJson() const
{
  return {{"encoder", encoder},       {"preset", preset}, {"custom", custom},
          {"bitrateKbps", bitrateKbps}, {"fps", fps},     {"width", width},
          {"height", height},         {"x264Preset", x264Preset}};
}

void VideoSettings::applyPartial(const nlohmann::json& j)
{
  if (j.contains("encoder")) encoder = j.value("encoder", encoder);
  if (j.contains("preset")) preset = j.value("preset", preset);
  if (j.contains("custom")) custom = j.value("custom", custom);
  if (j.contains("bitrateKbps")) bitrateKbps = j.value("bitrateKbps", bitrateKbps);
  if (j.contains("fps")) fps = j.value("fps", fps);
  if (j.contains("width")) width = j.value("width", width);
  if (j.contains("height")) height = j.value("height", height);
  if (j.contains("x264Preset")) x264Preset = j.value("x264Preset", x264Preset);
}

nlohmann::json CaptureSettings::toJson() const
{
  return {{"mode", mode}, {"monitor", monitor}};
}

void CaptureSettings::applyPartial(const nlohmann::json& j)
{
  if (j.contains("mode")) mode = j.value("mode", mode);
  if (j.contains("monitor")) monitor = j.value("monitor", monitor);
}

nlohmann::json ReplaySettings::toJson() const
{
  return {{"maxSeconds", maxSeconds}, {"maxMb", maxMb}};
}

void ReplaySettings::applyPartial(const nlohmann::json& j)
{
  if (j.contains("maxSeconds")) maxSeconds = j.value("maxSeconds", maxSeconds);
  if (j.contains("maxMb")) maxMb = j.value("maxMb", maxMb);
}

nlohmann::json GameSettings::toJson() const
{
  return {{"autoRecord", autoRecord},
          {"gamesPath", gamesPath},
          {"graceSeconds", graceSeconds},
          {"verboseDetection", verboseDetection},
          {"launchers", launcherEnabled}};
}

void GameSettings::applyPartial(const nlohmann::json& j)
{
  if (j.contains("autoRecord")) autoRecord = j.value("autoRecord", autoRecord);
  if (j.contains("gamesPath")) gamesPath = j.value("gamesPath", gamesPath);
  if (j.contains("graceSeconds")) graceSeconds = j.value("graceSeconds", graceSeconds);
  if (j.contains("verboseDetection")) verboseDetection = j.value("verboseDetection", verboseDetection);
  if (j.contains("launchers") && j["launchers"].is_object())
    for (auto it = j["launchers"].begin(); it != j["launchers"].end(); ++it)
      launcherEnabled[it.key()] = it.value().get<bool>();
}

void Config::updateDirs()
{
  if (clipsBaseDir.empty()) {
    clipsDir = (fs::path(configDir) / "clips").string();
    recordingsDir = (fs::path(configDir) / "recordings").string();
  } else {
    clipsDir = (fs::path(clipsBaseDir) / "clips").string();
    recordingsDir = (fs::path(clipsBaseDir) / "recordings").string();
  }
}

Config Config::defaults(const std::string& configDir, const std::string& coreBinDir)
{
  Config c;
  c.configDir = configDir;
  c.coreBinDir = coreBinDir;
  c.updateDirs();
  return c;
}

Config Config::load(const std::string& configDir, const std::string& coreBinDir)
{
  Config c = defaults(configDir, coreBinDir);

  fs::path p = fs::path(configDir) / "config.json";
  std::ifstream in(p);
  if (!in.is_open())
    return c;

  try {
    nlohmann::json j;
    in >> j;
    c.applyPartial(j);
  } catch (...) {
    // Corrupt config: fall back to defaults, do not crash.
  }
  return c;
}

void Config::save()
{
  fs::create_directories(configDir);
  fs::path p = fs::path(configDir) / "config.json";
  std::ofstream out(p, std::ios::trunc);
  if (out.is_open())
    out << toJson().dump(2);
}

nlohmann::json Config::toJson() const
{
  nlohmann::json sources = nlohmann::json::array();
  for (const auto& s : audioSources)
    sources.push_back(s.toJson());

  return {
      {"capture", capture.toJson()},
      {"video", video.toJson()},
      {"replay", replay.toJson()},
      {"game", game.toJson()},
      {"audio", {{"sources", sources}}},
      {"storage", {{"limitGb", storageLimitGb}, {"clipsDir", clipsBaseDir}}},
      {"app", {{"startWithWindows", appStartWithWindows}}},
      {"dirs", {{"clips", clipsDir}, {"recordings", recordingsDir}}},
  };
}

std::vector<std::string> Config::applyPartial(const nlohmann::json& j)
{
  std::vector<std::string> touched;

  auto touch = [&](const char* k) { touched.emplace_back(k); };

  if (j.contains("capture")) {
    capture.applyPartial(j["capture"]);
    touch("capture");
  }
  if (j.contains("video")) {
    video.applyPartial(j["video"]);
    touch("video");
  }
  if (j.contains("replay")) {
    replay.applyPartial(j["replay"]);
    touch("replay");
  }
  if (j.contains("game")) {
    game.applyPartial(j["game"]);
    touch("game");
  }
  if (j.contains("audio") && j["audio"].contains("sources")) {
    audioSources.clear();
    for (const auto& s : j["audio"]["sources"])
      audioSources.push_back(AudioSourceConfig::fromJson(s));
    touch("audio");
  }
  if (j.contains("storage")) {
    if (j["storage"].contains("limitGb")) {
      storageLimitGb = j["storage"]["limitGb"];
      touch("storage");
    }
    if (j["storage"].contains("clipsDir") && j["storage"]["clipsDir"].is_string()) {
      clipsBaseDir = j["storage"]["clipsDir"];
      updateDirs();
      touch("storage");
    }
  }
  if (j.contains("app") && j["app"].contains("startWithWindows")) {
    appStartWithWindows = j["app"]["startWithWindows"];
    touch("app");
  }

  return touched;
}

} // namespace clipforge
