#pragma once

#include <nlohmann/json.hpp>

#include <map>
#include <string>
#include <vector>

namespace clipforge {

// One entry in the audio mix. `kind` mirrors the OBS wasapi source family:
//   "input"   -> wasapi_input_capture        (mic / Voicemeeter AUX in)
//   "output"  -> wasapi_output_capture       (Voicemeeter bus / device out)
//   "process" -> wasapi_process_output_capture (per-app audio; `window` set)
struct AudioSourceConfig {
  std::string id;     // WASAPI device id, or "default"; ignored for "process"
  std::string name;   // display name
  std::string kind;   // input | output | process
  std::string window; // "::<exe>" descriptor for kind == "process"
  float gain = 1.0f;
  bool enabled = true;

  nlohmann::json toJson() const;
  static AudioSourceConfig fromJson(const nlohmann::json& j);
};

struct VideoSettings {
  std::string encoder = "auto"; // auto | obs_x264 | obs_nvenc_h264_tex | obs_nvenc_av1_tex
  std::string preset = "medium"; // low | medium | high | custom
  bool custom = false;
  int bitrateKbps = 0;   // custom / explicit override (0 = preset-derived)
  int fps = 60;
  int width = 1920;
  int height = 1080;
  std::string x264Preset = "veryfast";

  nlohmann::json toJson() const;
  void applyPartial(const nlohmann::json& j);
};

struct CaptureSettings {
  std::string mode = "auto"; // auto | screen | game
  int monitor = 0;

  nlohmann::json toJson() const;
  void applyPartial(const nlohmann::json& j);
};

struct ReplaySettings {
  int maxSeconds = 600; // time cap of the RAM ring
  int maxMb = 2048;     // byte cap of the RAM ring

  nlohmann::json toJson() const;
  void applyPartial(const nlohmann::json& j);
};

struct GameSettings {
  bool autoRecord = false;
  std::string gamesPath; // path to games.json (registry)
  int graceSeconds = 30; // auto-record grace after the last game session ends
  bool verboseDetection = false; // structured [GameDetection] logs on stderr
  // Per-launcher discovery toggles (steam/epic/gog/ubisoft/ea/battlenet/riot/msstore).
  std::map<std::string, bool> launcherEnabled;

  nlohmann::json toJson() const;
  void applyPartial(const nlohmann::json& j);
};

struct Config {
  int port = 0;             // RPC port (0 = pick a free one)
  std::string configDir;    // --config-dir (module configs + config.json)
  std::string clipsDir;     // saved clip output dir
  std::string recordingsDir; // mkv scratch dir for manual recordings
  std::string coreBinDir;   // dir containing obs-plugins/ and obs-ffmpeg-mux.exe

  CaptureSettings capture;
  VideoSettings video;
  ReplaySettings replay;
  GameSettings game;
  std::vector<AudioSourceConfig> audioSources;

  // App-side settings mirrored here so state.get stays coherent.
  int storageLimitGb = 20;
  bool appStartWithWindows = false;
  std::string clipsBaseDir; // user-chosen base dir ("" = configDir); clips/recordings live under it

  static Config defaults(const std::string& configDir, const std::string& coreBinDir);
  static Config load(const std::string& configDir, const std::string& coreBinDir);

  void save();
  nlohmann::json toJson() const;

  // Recompute clipsDir/recordingsDir from clipsBaseDir (or configDir default).
  void updateDirs();

  // Apply a partial config.set payload. Returns the top-level keys touched.
  std::vector<std::string> applyPartial(const nlohmann::json& j);
};

} // namespace clipforge
