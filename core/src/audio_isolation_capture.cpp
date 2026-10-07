#include "audio_isolation_capture.h"

#include "log.h"

#include <obs-module.h>

#include <atomic>
#include <cstdio>
#include <cstring>
#include <map>
#include <set>
#include <sstream>
#include <thread>
#include <unordered_map>
#include <vector>

#ifdef _WIN32
#include <windows.h>
#include <tlhelp32.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <audiopolicy.h>
#include <audioclientactivationparams.h>
#include <functiondiscoverykeys_devpkey.h>
#include <wrl/client.h>
#include <wrl/implements.h>
#include <util/threading.h>
#include <util/windows/win-version.h>
#endif

namespace shard {

#ifdef _WIN32

namespace {

using Microsoft::WRL::ComPtr;
using Microsoft::WRL::FtmBase;
using Microsoft::WRL::RuntimeClass;
using Microsoft::WRL::RuntimeClassFlags;
using Microsoft::WRL::ClassicCom;

constexpr const char* kLoopbackSourceId = "shard_process_loopback_capture";
constexpr REFERENCE_TIME kLoopbackBuffer = 5 * 10000000; // same buffer as OBS win-wasapi
constexpr DWORD kCaptureRetryMs = 2000;
constexpr DWORD kReconcileMs = 1000;
// Consecutive failed activations (~4 s) before a live process counts as uncapturable.
constexpr uint32_t kFailuresBeforeFallback = 3;
constexpr uint32_t kEnumerationFailuresBeforeFallback = 3;

void logIsolation(const char* level, const std::string& line)
{
  logFormat("[audio-isolation][%s] %s\n", level, line.c_str());
}

std::string hrText(HRESULT hr)
{
  char buffer[16];
  std::snprintf(buffer, sizeof(buffer), "0x%08lX", static_cast<unsigned long>(hr));
  return buffer;
}

std::string quoted(std::string value)
{
  for (char& c : value) {
    if (c == '"')
      c = '\'';
  }
  return "\"" + value + "\"";
}

std::string utf8(const wchar_t* text)
{
  if (!text || !*text)
    return {};
  const int length = WideCharToMultiByte(CP_UTF8, 0, text, -1, nullptr, 0, nullptr, nullptr);
  if (length <= 1)
    return {};
  std::string out(static_cast<size_t>(length - 1), '\0');
  WideCharToMultiByte(CP_UTF8, 0, text, -1, out.data(), length, nullptr, nullptr);
  return out;
}

std::wstring wide(const std::string& text)
{
  if (text.empty())
    return {};
  const int length = MultiByteToWideChar(CP_UTF8, 0, text.c_str(), -1, nullptr, 0);
  if (length <= 1)
    return {};
  std::wstring out(static_cast<size_t>(length - 1), L'\0');
  MultiByteToWideChar(CP_UTF8, 0, text.c_str(), -1, out.data(), length);
  return out;
}

// ------------------------------------------------- process loopback source --

enum class LoopbackState : int { Starting, Capturing, Failed };

struct LoopbackCapture {
  obs_source_t* source = nullptr;
  DWORD pid = 0;
  HANDLE stopEvent = nullptr;
  HANDLE readyEvent = nullptr;
  std::thread thread;
  // Read by the isolation controller for health/fallback decisions.
  std::atomic<int> state{static_cast<int>(LoopbackState::Starting)};
  std::atomic<uint32_t> failures{0};
  std::atomic<long> lastError{S_OK};
};

class ActivationHandler
    : public RuntimeClass<RuntimeClassFlags<ClassicCom>, FtmBase, IActivateAudioInterfaceCompletionHandler> {
public:
  ActivationHandler() : done_(CreateEventW(nullptr, TRUE, FALSE, nullptr)) {}
  ~ActivationHandler()
  {
    if (done_)
      CloseHandle(done_);
  }

  HANDLE done() const { return done_; }
  HRESULT result() const { return result_; }
  ComPtr<IAudioClient> client() const { return client_; }

  STDMETHOD(ActivateCompleted)(IActivateAudioInterfaceAsyncOperation* operation) override
  {
    HRESULT activateResult = E_FAIL;
    ComPtr<IUnknown> unknown;
    HRESULT hr = operation->GetActivateResult(&activateResult, &unknown);
    if (SUCCEEDED(hr))
      hr = activateResult;
    if (SUCCEEDED(hr))
      hr = unknown.As(&client_);
    result_ = hr;
    SetEvent(done_);
    return S_OK;
  }

private:
  HANDLE done_;
  HRESULT result_ = E_PENDING;
  ComPtr<IAudioClient> client_;
};

DWORD channelMask(speaker_layout layout)
{
  switch (layout) {
  case SPEAKERS_MONO:
    return KSAUDIO_SPEAKER_MONO;
  case SPEAKERS_STEREO:
    return KSAUDIO_SPEAKER_STEREO;
  case SPEAKERS_2POINT1:
    return KSAUDIO_SPEAKER_2POINT1;
  case SPEAKERS_4POINT0:
    return KSAUDIO_SPEAKER_SURROUND;
  case SPEAKERS_4POINT1:
    return KSAUDIO_SPEAKER_SURROUND | SPEAKER_LOW_FREQUENCY;
  case SPEAKERS_5POINT1:
    return KSAUDIO_SPEAKER_5POINT1_SURROUND;
  case SPEAKERS_7POINT1:
    return KSAUDIO_SPEAKER_7POINT1_SURROUND;
  default:
    return 0;
  }
}

// One activation + capture run. Returns S_OK when stopped, the failing HRESULT
// otherwise (the caller retries; the target may simply not be rendering yet).
HRESULT runLoopback(LoopbackCapture& capture)
{
  obs_audio_info oai = {};
  if (!obs_get_audio_info(&oai))
    return E_UNEXPECTED;

  // Process loopback has no mix format; request OBS's own layout/rate as
  // float, exactly like OBS's application audio capture.
  const WORD channels = static_cast<WORD>(get_audio_channels(oai.speakers));
  WAVEFORMATEXTENSIBLE format = {};
  format.Format.wFormatTag = WAVE_FORMAT_EXTENSIBLE;
  format.Format.nChannels = channels;
  format.Format.nSamplesPerSec = oai.samples_per_sec;
  format.Format.wBitsPerSample = 32;
  format.Format.nBlockAlign = static_cast<WORD>(channels * 4);
  format.Format.nAvgBytesPerSec = oai.samples_per_sec * format.Format.nBlockAlign;
  format.Format.cbSize = sizeof(format) - sizeof(format.Format);
  format.Samples.wValidBitsPerSample = 32;
  format.dwChannelMask = channelMask(oai.speakers);
  format.SubFormat = KSDATAFORMAT_SUBTYPE_IEEE_FLOAT;

  AUDIOCLIENT_ACTIVATION_PARAMS params = {};
  params.ActivationType = AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK;
  params.ProcessLoopbackParams.TargetProcessId = capture.pid;
  params.ProcessLoopbackParams.ProcessLoopbackMode = PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE;
  PROPVARIANT activation = {};
  activation.vt = VT_BLOB;
  activation.blob.cbSize = sizeof(params);
  activation.blob.pBlobData = reinterpret_cast<BYTE*>(&params);

  ComPtr<ActivationHandler> handler = Microsoft::WRL::Make<ActivationHandler>();
  if (!handler || !handler->done())
    return E_OUTOFMEMORY;
  ComPtr<IActivateAudioInterfaceAsyncOperation> operation;
  HRESULT hr = ActivateAudioInterfaceAsync(VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK, __uuidof(IAudioClient), &activation,
                                           handler.Get(), &operation);
  if (FAILED(hr))
    return hr;
  const HANDLE activationWaits[] = {capture.stopEvent, handler->done()};
  if (WaitForMultipleObjects(2, activationWaits, FALSE, INFINITE) == WAIT_OBJECT_0)
    return S_OK; // the pending operation keeps the handler alive until it completes
  if (FAILED(handler->result()))
    return handler->result();

  ComPtr<IAudioClient> client = handler->client();
  hr = client->Initialize(AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
                          kLoopbackBuffer, 0, &format.Format, nullptr);
  if (FAILED(hr))
    return hr;
  ComPtr<IAudioCaptureClient> captureClient;
  hr = client->GetService(IID_PPV_ARGS(&captureClient));
  if (FAILED(hr))
    return hr;
  ResetEvent(capture.readyEvent);
  hr = client->SetEventHandle(capture.readyEvent);
  if (FAILED(hr))
    return hr;
  hr = client->Start();
  if (FAILED(hr))
    return hr;

  capture.failures = 0;
  capture.lastError = S_OK;
  capture.state = static_cast<int>(LoopbackState::Capturing);

  std::vector<uint8_t> silence;
  const HANDLE waits[] = {capture.stopEvent, capture.readyEvent};
  for (;;) {
    if (WaitForMultipleObjects(2, waits, FALSE, kReconcileMs) == WAIT_OBJECT_0)
      break;
    for (;;) {
      UINT32 packet = 0;
      hr = captureClient->GetNextPacketSize(&packet);
      if (FAILED(hr)) {
        client->Stop();
        return hr;
      }
      if (!packet)
        break;
      BYTE* data = nullptr;
      UINT32 frames = 0;
      DWORD flags = 0;
      UINT64 position = 0;
      UINT64 qpc = 0;
      hr = captureClient->GetBuffer(&data, &frames, &flags, &position, &qpc);
      if (FAILED(hr)) {
        client->Stop();
        return hr;
      }
      if (flags & AUDCLNT_BUFFERFLAGS_SILENT) {
        const size_t bytes = static_cast<size_t>(frames) * format.Format.nBlockAlign;
        if (silence.size() < bytes)
          silence.resize(bytes);
        data = silence.data();
      }
      obs_source_audio audio = {};
      audio.data[0] = data;
      audio.frames = frames;
      audio.speakers = oai.speakers;
      audio.samples_per_sec = oai.samples_per_sec;
      audio.format = AUDIO_FORMAT_FLOAT;
      audio.timestamp = qpc * 100; // QPC 100 ns units -> os_gettime_ns clock, as OBS does
      obs_source_output_audio(capture.source, &audio);
      captureClient->ReleaseBuffer(frames);
    }
  }
  client->Stop();
  return S_OK;
}

void loopbackThread(LoopbackCapture* capture)
{
  os_set_thread_name("shard: process loopback");
  const HRESULT co = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  while (WaitForSingleObject(capture->stopEvent, 0) != WAIT_OBJECT_0) {
    const HRESULT hr = runLoopback(*capture);
    if (WaitForSingleObject(capture->stopEvent, 0) == WAIT_OBJECT_0)
      break;
    capture->lastError = hr;
    capture->state = static_cast<int>(FAILED(hr) ? LoopbackState::Failed : LoopbackState::Starting);
    if (FAILED(hr))
      capture->failures++;
    WaitForSingleObject(capture->stopEvent, kCaptureRetryMs);
  }
  if (SUCCEEDED(co))
    CoUninitialize();
}

const char* loopbackName(void*)
{
  return "Shard application loopback";
}

void* loopbackCreate(obs_data_t* settings, obs_source_t* source)
{
  auto* capture = new LoopbackCapture();
  capture->source = source;
  capture->pid = static_cast<DWORD>(obs_data_get_int(settings, "pid"));
  capture->stopEvent = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  capture->readyEvent = CreateEventW(nullptr, FALSE, FALSE, nullptr);
  if (!capture->stopEvent || !capture->readyEvent || !capture->pid) {
    if (capture->stopEvent)
      CloseHandle(capture->stopEvent);
    if (capture->readyEvent)
      CloseHandle(capture->readyEvent);
    delete capture;
    return nullptr;
  }
  capture->thread = std::thread(loopbackThread, capture);
  return capture;
}

void loopbackDestroy(void* data)
{
  auto* capture = static_cast<LoopbackCapture*>(data);
  if (!capture)
    return;
  SetEvent(capture->stopEvent);
  if (capture->thread.joinable())
    capture->thread.join();
  CloseHandle(capture->stopEvent);
  CloseHandle(capture->readyEvent);
  delete capture;
}

const LoopbackCapture* loopbackOf(obs_source_t* source)
{
  if (!source || std::strcmp(obs_source_get_id(source), kLoopbackSourceId) != 0)
    return nullptr;
  return static_cast<const LoopbackCapture*>(obs_obj_get_data(source));
}

// Wakes the controller as soon as an app opens a stream on a watched endpoint.
class SessionWake : public RuntimeClass<RuntimeClassFlags<ClassicCom>, FtmBase, IAudioSessionNotification> {
public:
  explicit SessionWake(HANDLE wake) : wake_(wake) {}
  STDMETHOD(OnSessionCreated)(IAudioSessionControl*) override
  {
    SetEvent(wake_);
    return S_OK;
  }

private:
  HANDLE wake_;
};

} // namespace

bool processLoopbackSupported()
{
  // MS documents 20348, but OBS (and Shard's existing app capture) rely on
  // process loopback from 19041 onwards.
  static const bool supported = [] {
    win_version_info version = {};
    get_win_ver(&version);
    win_version_info minimum = {};
    minimum.major = 10;
    minimum.minor = 0;
    minimum.build = 19041;
    return win_version_compare(&version, &minimum) >= 0;
  }();
  return supported;
}

void registerProcessLoopbackSource()
{
  if (!processLoopbackSupported()) {
    logIsolation("warn", "event=process_loopback state=unsupported reason=windows_build_below_19041");
    return;
  }
  if (obs_source_get_display_name(kLoopbackSourceId))
    return;
  static obs_source_info info = {};
  info.id = kLoopbackSourceId;
  info.type = OBS_SOURCE_TYPE_INPUT;
  info.output_flags = OBS_SOURCE_AUDIO | OBS_SOURCE_DO_NOT_DUPLICATE | OBS_SOURCE_DO_NOT_SELF_MONITOR;
  info.get_name = loopbackName;
  info.create = loopbackCreate;
  info.destroy = loopbackDestroy;
  obs_register_source(&info);
}

// ------------------------------------------------------------- controller --

struct AudioIsolationController::Impl {
  struct OwnedSource {
    obs_source_t* source = nullptr;
    obs_sceneitem_t* item = nullptr;
    std::string exe;
    bool failureReported = false;
  };

  struct RowState {
    IsolationRow row;
    uint32_t mixers = 0;
    size_t desktopSlot = 0; // index into the plan's desktopRoots
    // Desktop endpoint tracking.
    enum class Endpoint { Unknown, Available, Unavailable } endpoint = Endpoint::Unknown;
    std::string endpointId;
    ComPtr<IAudioSessionManager2> sessionManager;
    ComPtr<SessionWake> sessionWake;
    std::set<uint32_t> sessionPids;
    uint32_t enumerationFailures = 0;
    bool systemSoundsReported = false;
    std::map<AudioProcessKey, OwnedSource> captures;
    OwnedSource passthrough; // degraded: whole-endpoint loopback
  };

  struct CachedProcess {
    uint32_t parentPid = 0;
    std::string exe;
    uint64_t createTime = 0;
  };

  obs_scene_t* scene = nullptr;
  std::vector<RowState> rows;
  std::vector<std::string> isolatedExes;
  std::set<std::string> isolatedSet;
  size_t desktopRows = 0;
  HANDLE stopEvent = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  HANDLE wakeEvent = CreateEventW(nullptr, FALSE, FALSE, nullptr);
  std::thread thread;
  ComPtr<IMMDeviceEnumerator> devices;
  std::unordered_map<uint32_t, CachedProcess> processCache;
  bool degraded = false;
  bool stateReported = false;
  std::set<std::string> overlapKeys;

  ~Impl()
  {
    if (stopEvent)
      CloseHandle(stopEvent);
    if (wakeEvent)
      CloseHandle(wakeEvent);
  }

  static const char* trackOf(const RowState& state)
  {
    return state.row.kind == IsolationRow::Kind::App ? "app" : "desktop";
  }

  std::string rowText(const RowState& state) const
  {
    std::ostringstream out;
    out << "row=" << state.row.configuredIndex << " track=" << trackOf(state) << " name=" << quoted(state.row.name);
    return out.str();
  }

  void run()
  {
    os_set_thread_name("shard: audio isolation");
    const HRESULT co = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    if (desktopRows) {
      const HRESULT hr = CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL, IID_PPV_ARGS(&devices));
      if (FAILED(hr))
        degrade("device_enumerator_unavailable hr=" + hrText(hr));
    }
    for (;;) {
      reconcile();
      const HANDLE waits[] = {stopEvent, wakeEvent};
      if (WaitForMultipleObjects(2, waits, FALSE, kReconcileMs) == WAIT_OBJECT_0)
        break;
    }
    teardown();
    devices.Reset();
    if (SUCCEEDED(co))
      CoUninitialize();
  }

  std::vector<AudioProcess> snapshotProcesses()
  {
    std::vector<AudioProcess> processes;
    HANDLE snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    if (snapshot == INVALID_HANDLE_VALUE)
      return processes;
    std::unordered_map<uint32_t, CachedProcess> next;
    PROCESSENTRY32W entry = {};
    entry.dwSize = sizeof(entry);
    for (BOOL ok = Process32FirstW(snapshot, &entry); ok; ok = Process32NextW(snapshot, &entry)) {
      CharLowerW(entry.szExeFile);
      const uint32_t pid = entry.th32ProcessID;
      CachedProcess cached;
      cached.parentPid = entry.th32ParentProcessID;
      cached.exe = utf8(entry.szExeFile);
      const auto previous = processCache.find(pid);
      if (previous != processCache.end() && previous->second.parentPid == cached.parentPid &&
          previous->second.exe == cached.exe) {
        cached.createTime = previous->second.createTime;
      } else if (pid > 4) {
        if (HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid)) {
          FILETIME created = {}, exited = {}, kernel = {}, user = {};
          if (GetProcessTimes(process, &created, &exited, &kernel, &user))
            cached.createTime = (static_cast<uint64_t>(created.dwHighDateTime) << 32) | created.dwLowDateTime;
          CloseHandle(process);
        }
      }
      processes.push_back({pid, cached.parentPid, cached.exe, cached.createTime});
      next.emplace(pid, std::move(cached));
    }
    CloseHandle(snapshot);
    processCache = std::move(next);
    return processes;
  }

  void releaseEndpoint(RowState& state)
  {
    if (state.sessionManager && state.sessionWake)
      state.sessionManager->UnregisterSessionNotification(state.sessionWake.Get());
    state.sessionWake.Reset();
    state.sessionManager.Reset();
  }

  void markUnavailable(RowState& state, const std::string& reason)
  {
    if (state.endpoint != RowState::Endpoint::Unavailable)
      logIsolation("warn", rowText(state) + " event=endpoint_state state=unavailable device=" +
                               quoted(state.row.deviceId) + " reason=" + reason +
                               " effect=\"desktop track silent until the endpoint returns\"");
    state.endpoint = RowState::Endpoint::Unavailable;
    state.enumerationFailures = 0;
    releaseEndpoint(state);
  }

  static bool endpointGone(HRESULT hr)
  {
    return hr == AUDCLNT_E_DEVICE_INVALIDATED || hr == E_NOTFOUND || hr == HRESULT_FROM_WIN32(ERROR_NOT_FOUND);
  }

  void enumerationFailed(RowState& state, const std::string& stage, HRESULT hr)
  {
    releaseEndpoint(state);
    if (++state.enumerationFailures >= kEnumerationFailuresBeforeFallback)
      degrade("session_enumeration_failed " + rowText(state) + " stage=" + stage + " hr=" + hrText(hr));
  }

  EndpointSessions enumerateSessions(RowState& state)
  {
    EndpointSessions result;
    if (!devices)
      return result;
    ComPtr<IMMDevice> device;
    HRESULT hr = _stricmp(state.row.deviceId.c_str(), "default") == 0
                     ? devices->GetDefaultAudioEndpoint(eRender, eConsole, &device)
                     : devices->GetDevice(wide(state.row.deviceId).c_str(), &device);
    DWORD deviceState = 0;
    if (SUCCEEDED(hr))
      hr = device->GetState(&deviceState);
    if (FAILED(hr) || deviceState != DEVICE_STATE_ACTIVE) {
      markUnavailable(state, FAILED(hr) ? "hr=" + hrText(hr) : "device_state=" + std::to_string(deviceState));
      return result;
    }
    std::string id;
    LPWSTR rawId = nullptr;
    if (SUCCEEDED(device->GetId(&rawId))) {
      id = utf8(rawId);
      CoTaskMemFree(rawId);
    }

    if (!state.sessionManager || id != state.endpointId) {
      releaseEndpoint(state);
      ComPtr<IAudioSessionManager2> manager;
      hr = device->Activate(__uuidof(IAudioSessionManager2), CLSCTX_ALL, nullptr,
                            reinterpret_cast<void**>(manager.GetAddressOf()));
      if (FAILED(hr)) {
        if (endpointGone(hr))
          markUnavailable(state, "hr=" + hrText(hr));
        else
          enumerationFailed(state, "activate_session_manager", hr);
        return result;
      }
      // Session notifications are only delivered after an enumerator exists.
      ComPtr<IAudioSessionEnumerator> primer;
      manager->GetSessionEnumerator(&primer);
      ComPtr<SessionWake> wake = Microsoft::WRL::Make<SessionWake>(wakeEvent);
      if (wake && SUCCEEDED(manager->RegisterSessionNotification(wake.Get())))
        state.sessionWake = wake;
      else
        logIsolation("warn", rowText(state) + " event=session_notifications state=unavailable fallback=polling_1s");
      state.sessionManager = manager;

      std::string friendly;
      ComPtr<IPropertyStore> props;
      if (SUCCEEDED(device->OpenPropertyStore(STGM_READ, &props))) {
        PROPVARIANT value;
        PropVariantInit(&value);
        if (SUCCEEDED(props->GetValue(PKEY_Device_FriendlyName, &value)) && value.vt == VT_LPWSTR)
          friendly = utf8(value.pwszVal);
        PropVariantClear(&value);
      }
      const bool changed = !state.endpointId.empty() && state.endpointId != id;
      state.endpointId = id;
      state.endpoint = RowState::Endpoint::Available;
      logIsolation("info", rowText(state) + " event=endpoint_state state=available device=" + quoted(state.row.deviceId) +
                               " endpoint=" + quoted(id) + " endpoint_name=" + quoted(friendly) +
                               (changed ? " change=endpoint_switched" : ""));
    }

    ComPtr<IAudioSessionEnumerator> sessions;
    hr = state.sessionManager->GetSessionEnumerator(&sessions);
    int count = 0;
    if (SUCCEEDED(hr))
      hr = sessions->GetCount(&count);
    if (FAILED(hr)) {
      if (endpointGone(hr))
        markUnavailable(state, "hr=" + hrText(hr));
      else
        enumerationFailed(state, "enumerate_sessions", hr);
      return result;
    }
    bool systemSounds = false;
    for (int i = 0; i < count; i++) {
      ComPtr<IAudioSessionControl> control;
      ComPtr<IAudioSessionControl2> control2;
      if (FAILED(sessions->GetSession(i, &control)) || FAILED(control.As(&control2)))
        continue;
      AudioSessionState sessionState = AudioSessionStateInactive;
      if (SUCCEEDED(control2->GetState(&sessionState)) && sessionState == AudioSessionStateExpired)
        continue;
      if (control2->IsSystemSoundsSession() == S_OK) {
        systemSounds = true;
        continue;
      }
      DWORD pid = 0;
      // AUDCLNT_S_NO_SINGLE_PROCESS still reports the creating process.
      if (SUCCEEDED(control2->GetProcessId(&pid)) && pid)
        result.pids.push_back(pid);
    }
    if (systemSounds && !state.systemSoundsReported) {
      state.systemSoundsReported = true;
      logIsolation("info", rowText(state) +
                               " event=system_sounds state=not_captured reason=no_owning_process_tree"
                               " effect=\"Windows system sounds are absent from filtered Desktop audio\"");
    }
    state.enumerationFailures = 0;
    result.available = true;
    return result;
  }

  OwnedSource createSource(const RowState& state, const char* id, obs_data_t* settings, const std::string& name)
  {
    OwnedSource owned;
    owned.source = obs_source_create(id, name.c_str(), settings, nullptr);
    if (!owned.source)
      return owned;
    obs_source_set_volume(owned.source, state.row.gain);
    obs_source_set_audio_mixers(owned.source, state.mixers);
    owned.item = obs_scene_add(scene, owned.source);
    return owned;
  }

  static void releaseSource(OwnedSource& owned)
  {
    if (owned.item)
      obs_sceneitem_remove(owned.item);
    if (owned.source)
      obs_source_release(owned.source);
    owned = {};
  }

  void syncCaptures(RowState& state, const std::vector<AudioProcessKey>& desired, const AudioProcessForest& forest)
  {
    const bool app = state.row.kind == IsolationRow::Kind::App;
    const std::set<AudioProcessKey> wanted(desired.begin(), desired.end());
    for (auto it = state.captures.begin(); it != state.captures.end();) {
      if (wanted.count(it->first)) {
        ++it;
        continue;
      }
      const AudioProcess* process = forest.find(it->first.pid);
      const bool exited = !process || process->createTime != it->first.createTime;
      logIsolation("info", rowText(state) + (app ? " event=app_process_detached" : " event=desktop_process_detached") +
                               " exe=" + it->second.exe + " pid=" + std::to_string(it->first.pid) + " reason=" +
                               (exited ? "exited" : app ? "process_tree_changed" : "session_removed"));
      releaseSource(it->second);
      it = state.captures.erase(it);
    }
    for (const auto& key : desired) {
      if (state.captures.count(key))
        continue;
      const AudioProcess* process = forest.find(key.pid);
      const std::string exe = process ? process->exe : std::string("unknown");
      obs_data_t* settings = obs_data_create();
      obs_data_set_int(settings, "pid", key.pid);
      OwnedSource owned =
          createSource(state, kLoopbackSourceId, settings, state.row.name + " [" + exe + " " + std::to_string(key.pid) + "]");
      obs_data_release(settings);
      if (!owned.source) {
        logIsolation("warn", rowText(state) + " event=capture_failed stage=source_create exe=" + exe +
                                 " pid=" + std::to_string(key.pid));
        if (desktopRows && !degraded) {
          degrade("process_loopback_source_unavailable");
          if (!app)
            return; // this Desktop row now uses endpoint loopback
        }
        continue;
      }
      owned.exe = exe;
      const AudioProcess* parent = process ? forest.parentOf(*process) : nullptr;
      logIsolation("info", rowText(state) + (app ? " event=app_process_attached" : " event=desktop_process_attached") +
                               " exe=" + exe + " pid=" + std::to_string(key.pid) +
                               " parent_pid=" + std::to_string(parent ? parent->pid : 0) +
                               " parent_exe=" + (parent ? parent->exe : std::string("none")) +
                               " mode=include_process_tree");
      state.captures.emplace(key, std::move(owned));
    }
  }

  void logSessionChanges(RowState& state, const EndpointSessions& sessions, const AudioProcessForest& forest)
  {
    const std::set<uint32_t> now(sessions.pids.begin(), sessions.pids.end());
    for (const uint32_t pid : now) {
      if (state.sessionPids.count(pid))
        continue;
      const AudioProcess* process = forest.find(pid);
      const AudioProcess* owner = process ? forest.isolatedOwner(*process, isolatedSet) : nullptr;
      logIsolation("info", rowText(state) + " event=session_added pid=" + std::to_string(pid) +
                               " exe=" + (process ? process->exe : std::string("unknown")) +
                               " route=" + (owner ? "isolated:" + owner->exe : std::string("desktop")));
    }
    for (const uint32_t pid : state.sessionPids) {
      if (!now.count(pid))
        logIsolation("info", rowText(state) + " event=session_removed pid=" + std::to_string(pid));
    }
    state.sessionPids = now;
  }

  void logOverlaps(const IsolationPlan& plan)
  {
    std::set<std::string> now;
    for (const auto& overlap : plan.overlaps) {
      const std::string key = std::to_string(overlap.outer.pid) + ":" + std::to_string(overlap.outer.createTime) + ">" +
                              std::to_string(overlap.inner.pid) + ":" + std::to_string(overlap.inner.createTime);
      now.insert(key);
      if (overlapKeys.count(key))
        continue;
      logIsolation("warn", "event=isolation_overlap state=degraded outer_track=" + overlap.outerTrack +
                               " outer_exe=" + overlap.outerExe + " outer_pid=" + std::to_string(overlap.outer.pid) +
                               " inner_track=" + overlap.innerTrack + " inner_exe=" + overlap.innerExe +
                               " inner_pid=" + std::to_string(overlap.inner.pid) +
                               " effect=\"inner process tree is heard on both tracks (process loopback has no "
                               "single-process mode)\"");
    }
    for (const auto& key : overlapKeys) {
      if (!now.count(key))
        logIsolation("info", "event=isolation_overlap_cleared key=" + key);
    }
    overlapKeys = std::move(now);
  }

  void checkHealth(const AudioProcessForest& forest)
  {
    std::string failure;
    for (auto& state : rows) {
      for (auto& [key, owned] : state.captures) {
        const LoopbackCapture* capture = loopbackOf(owned.source);
        if (!capture)
          continue;
        const auto current = static_cast<LoopbackState>(capture->state.load());
        if (!owned.failureReported && capture->failures.load() >= kFailuresBeforeFallback) {
          owned.failureReported = true;
          const AudioProcess* process = forest.find(key.pid);
          if (!process || process->createTime != key.createTime)
            continue; // exiting; removed on the next reconcile
          const std::string detail = rowText(state) + " exe=" + owned.exe + " pid=" + std::to_string(key.pid) +
                                     " hr=" + hrText(capture->lastError.load());
          logIsolation("warn", "event=capture_failed " + detail);
          if (failure.empty())
            failure = "process_loopback_failed " + detail;
        } else if (owned.failureReported && current == LoopbackState::Capturing) {
          owned.failureReported = false;
          logIsolation("info", rowText(state) + " event=capture_recovered exe=" + owned.exe +
                                   " pid=" + std::to_string(key.pid));
        }
      }
    }
    // degrade() releases Desktop captures, so it must run after iteration.
    if (!failure.empty() && desktopRows)
      degrade(failure);
  }

  // Preserve audio: every Desktop row returns to whole-endpoint loopback, so
  // nothing that a failing capture missed is lost. Isolated apps are then
  // heard on both their own and the Desktop track until reconfiguration.
  void degrade(const std::string& reason)
  {
    if (degraded)
      return;
    degraded = true;
    stateReported = true;
    logIsolation("warn", "event=isolation_state state=degraded reason=" + reason +
                             " fallback=endpoint_loopback effect=\"isolated apps are also recorded in Desktop audio\"");
    for (auto& state : rows) {
      if (state.row.kind != IsolationRow::Kind::Desktop)
        continue;
      for (auto& [key, owned] : state.captures)
        releaseSource(owned);
      state.captures.clear();
      state.sessionPids.clear();
      releaseEndpoint(state);
      obs_data_t* settings = obs_data_create();
      obs_data_set_string(settings, "device_id", state.row.deviceId.c_str());
      obs_data_set_bool(settings, "use_device_timing", false);
      state.passthrough = createSource(state, "wasapi_output_capture", settings, state.row.name);
      obs_data_release(settings);
      logIsolation(state.passthrough.source ? "info" : "error",
                   rowText(state) + " event=fallback_source state=" +
                       (state.passthrough.source ? "created" : "failed") + " device=" + quoted(state.row.deviceId));
    }
  }

  void reconcile()
  {
    // Sessions first: a process that opened a stream is then already in the snapshot.
    std::vector<EndpointSessions> desktops(desktopRows);
    for (auto& state : rows) {
      if (state.row.kind == IsolationRow::Kind::Desktop && !degraded)
        desktops[state.desktopSlot] = enumerateSessions(state);
    }
    const AudioProcessForest forest(snapshotProcesses());
    const IsolationPlan plan = planAudioIsolation(forest, isolatedExes, desktops);

    for (auto& state : rows) {
      if (state.row.kind == IsolationRow::Kind::App) {
        const auto roots = plan.appRoots.find(state.row.exe);
        syncCaptures(state, roots == plan.appRoots.end() ? std::vector<AudioProcessKey>{} : roots->second, forest);
      } else if (!degraded) {
        logSessionChanges(state, desktops[state.desktopSlot], forest);
        syncCaptures(state, plan.desktopRoots[state.desktopSlot], forest);
      }
    }
    logOverlaps(plan);
    checkHealth(forest);

    if (!stateReported) {
      stateReported = true;
      std::string apps;
      for (const auto& exe : isolatedExes)
        apps += (apps.empty() ? "" : ",") + exe;
      logIsolation("info", "event=isolation_state state=active apps=" + apps +
                               " desktop_rows=" + std::to_string(desktopRows) +
                               " app_rows=" + std::to_string(rows.size() - desktopRows));
    }
  }

  void teardown()
  {
    for (auto& state : rows) {
      for (auto& [key, owned] : state.captures)
        releaseSource(owned);
      state.captures.clear();
      releaseSource(state.passthrough);
      releaseEndpoint(state);
    }
    logIsolation("info", "event=isolation_stopped");
  }
};

AudioIsolationController::AudioIsolationController() = default;

AudioIsolationController::~AudioIsolationController()
{
  stop();
}

void AudioIsolationController::start(obs_scene_t* scene, std::vector<IsolationRow> rows,
                                     std::vector<std::string> isolatedExes)
{
  stop();
  if (rows.empty() || !scene)
    return;
  auto impl = std::make_unique<Impl>();
  if (!impl->stopEvent || !impl->wakeEvent) {
    logIsolation("error", "event=isolation_state state=failed reason=event_create_failed");
    return;
  }
  impl->scene = scene;
  impl->isolatedExes = std::move(isolatedExes);
  impl->isolatedSet.insert(impl->isolatedExes.begin(), impl->isolatedExes.end());
  std::string apps;
  for (const auto& exe : impl->isolatedExes)
    apps += (apps.empty() ? "" : ",") + exe;
  for (auto& row : rows) {
    Impl::RowState state;
    state.mixers = audioMixersForRow(row.configuredIndex);
    if (row.kind == IsolationRow::Kind::Desktop)
      state.desktopSlot = impl->desktopRows++;
    state.row = std::move(row);
    impl->rows.push_back(std::move(state));
  }
  logIsolation("info", "event=isolation_started apps=" + apps + " desktop_rows=" + std::to_string(impl->desktopRows) +
                           " app_rows=" + std::to_string(impl->rows.size() - impl->desktopRows));
  Impl* raw = impl.get();
  impl->thread = std::thread([raw] { raw->run(); });
  impl_ = std::move(impl);
}

void AudioIsolationController::stop()
{
  if (!impl_)
    return;
  SetEvent(impl_->stopEvent);
  if (impl_->thread.joinable())
    impl_->thread.join();
  impl_.reset();
}

#else // !_WIN32

struct AudioIsolationController::Impl {};

bool processLoopbackSupported()
{
  return false;
}

void registerProcessLoopbackSource() {}

AudioIsolationController::AudioIsolationController() = default;
AudioIsolationController::~AudioIsolationController() = default;
void AudioIsolationController::start(obs_scene_t*, std::vector<IsolationRow>, std::vector<std::string>) {}
void AudioIsolationController::stop() {}

#endif

} // namespace shard
