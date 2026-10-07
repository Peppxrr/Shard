// GPL-2.0-or-later
// Windowed D3D11 "game" that can pin the GPU's 3D engine on a schedule, used
// to reproduce recording lag under GPU starvation and to check that Shard's
// frame pacing recovers once the load drops (see docs/VERIFYING.md).
//
//   SHARD_STRESS_PHASES      "seconds:level,..." (default "10:0,40:1,60:0").
//                            level 0 = vsync-paced light frame, 1 = uncapped
//                            heavy pixel shading; the last phase persists.
//   SHARD_STRESS_ITERATIONS  shader loop count per pixel (default 6000).
//   SHARD_STRESS_WIDTH/HEIGHT window size (default 1600x900).
// Phase changes are printed to stdout as "PHASE <level> <unix-ms>".
#ifdef _WIN32
#include <windows.h>
#include <d3d11.h>
#include <d3dcompiler.h>
#include <dxgi.h>
#include <wrl/client.h>

#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <string>
#include <vector>

using Microsoft::WRL::ComPtr;

namespace {

struct Phase {
  double seconds;
  int level;
};

std::vector<Phase> parsePhases(const char* text)
{
  std::vector<Phase> phases;
  std::string spec = text && *text ? text : "10:0,40:1,60:0";
  size_t pos = 0;
  while (pos < spec.size()) {
    const size_t end = spec.find(',', pos);
    const std::string item = spec.substr(pos, end == std::string::npos ? std::string::npos : end - pos);
    const size_t colon = item.find(':');
    if (colon != std::string::npos)
      phases.push_back({std::atof(item.substr(0, colon).c_str()), std::atoi(item.substr(colon + 1).c_str())});
    if (end == std::string::npos)
      break;
    pos = end + 1;
  }
  if (phases.empty())
    phases.push_back({0, 0});
  return phases;
}

LRESULT CALLBACK windowProc(HWND window, UINT message, WPARAM wparam, LPARAM lparam)
{
  if (message == WM_DESTROY) {
    PostQuitMessage(0);
    return 0;
  }
  return DefWindowProcW(window, message, wparam, lparam);
}

constexpr char kShader[] = R"(
cbuffer Params : register(b0) { float time; uint iterations; float2 size; };
float4 vs(uint id : SV_VertexID) : SV_Position {
  float2 uv = float2((id << 1) & 2, id & 2);
  return float4(uv * float2(2, -2) + float2(-1, 1), 0, 1);
}
float4 ps(float4 position : SV_Position) : SV_Target {
  float2 p = position.xy / size;
  float3 c = float3(p, 0.5 + 0.5 * sin(time));
  [loop] for (uint i = 0; i < iterations; ++i) {
    c = frac(sin(c * 12.9898 + c.yzx * 78.233 + time) * 43758.5453);
  }
  return float4(c, 1);
}
)";

} // namespace

int WINAPI wWinMain(HINSTANCE instance, HINSTANCE, PWSTR, int)
{
  SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
  const std::vector<Phase> phases = parsePhases(std::getenv("SHARD_STRESS_PHASES"));
  const char* iterationsText = std::getenv("SHARD_STRESS_ITERATIONS");
  const UINT iterations = iterationsText ? static_cast<UINT>(std::atoi(iterationsText)) : 6000u;
  const char* widthText = std::getenv("SHARD_STRESS_WIDTH");
  const char* heightText = std::getenv("SHARD_STRESS_HEIGHT");
  const UINT width = widthText ? static_cast<UINT>(std::atoi(widthText)) : 1600u;
  const UINT height = heightText ? static_cast<UINT>(std::atoi(heightText)) : 900u;

  constexpr wchar_t kClassName[] = L"ShardGpuStressFixture";
  WNDCLASSW wc = {};
  wc.hInstance = instance;
  wc.lpfnWndProc = windowProc;
  wc.lpszClassName = kClassName;
  wc.hCursor = LoadCursorW(nullptr, MAKEINTRESOURCEW(32512));
  if (!RegisterClassW(&wc))
    return 2;
  RECT rect = {0, 0, static_cast<LONG>(width), static_cast<LONG>(height)};
  AdjustWindowRect(&rect, WS_OVERLAPPEDWINDOW, FALSE);
  // Never take focus: the fixture may run beside a real game session.
  HWND window = CreateWindowExW(WS_EX_NOACTIVATE, kClassName, L"Shard GPU Stress Fixture", WS_OVERLAPPEDWINDOW, 40, 40,
                                rect.right - rect.left, rect.bottom - rect.top, nullptr, nullptr, instance, nullptr);
  if (!window)
    return 3;
  ShowWindow(window, SW_SHOWNOACTIVATE);

  DXGI_SWAP_CHAIN_DESC desc = {};
  desc.BufferDesc.Width = width;
  desc.BufferDesc.Height = height;
  desc.BufferDesc.Format = DXGI_FORMAT_R8G8B8A8_UNORM;
  desc.SampleDesc.Count = 1;
  desc.BufferUsage = DXGI_USAGE_RENDER_TARGET_OUTPUT;
  desc.BufferCount = 2;
  desc.OutputWindow = window;
  desc.Windowed = TRUE;
  desc.SwapEffect = DXGI_SWAP_EFFECT_FLIP_DISCARD;
  ComPtr<ID3D11Device> device;
  ComPtr<ID3D11DeviceContext> context;
  ComPtr<IDXGISwapChain> swapChain;
  if (FAILED(D3D11CreateDeviceAndSwapChain(nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr, 0, nullptr, 0,
                                           D3D11_SDK_VERSION, &desc, &swapChain, &device, nullptr, &context)))
    return 4;
  ComPtr<ID3D11Texture2D> backBuffer;
  ComPtr<ID3D11RenderTargetView> target;
  if (FAILED(swapChain->GetBuffer(0, IID_PPV_ARGS(&backBuffer))) ||
      FAILED(device->CreateRenderTargetView(backBuffer.Get(), nullptr, &target)))
    return 5;

  ComPtr<ID3DBlob> vsBlob, psBlob, errors;
  if (FAILED(D3DCompile(kShader, sizeof(kShader) - 1, "stress", nullptr, nullptr, "vs", "vs_5_0", 0, 0, &vsBlob, &errors)) ||
      FAILED(D3DCompile(kShader, sizeof(kShader) - 1, "stress", nullptr, nullptr, "ps", "ps_5_0", 0, 0, &psBlob, &errors)))
    return 6;
  ComPtr<ID3D11VertexShader> vertexShader;
  ComPtr<ID3D11PixelShader> pixelShader;
  device->CreateVertexShader(vsBlob->GetBufferPointer(), vsBlob->GetBufferSize(), nullptr, &vertexShader);
  device->CreatePixelShader(psBlob->GetBufferPointer(), psBlob->GetBufferSize(), nullptr, &pixelShader);
  struct Params {
    float time;
    UINT iterations;
    float size[2];
  };
  D3D11_BUFFER_DESC bufferDesc = {sizeof(Params), D3D11_USAGE_DYNAMIC, D3D11_BIND_CONSTANT_BUFFER,
                                  D3D11_CPU_ACCESS_WRITE, 0, 0};
  ComPtr<ID3D11Buffer> params;
  if (FAILED(device->CreateBuffer(&bufferDesc, nullptr, &params)))
    return 7;

  const auto started = std::chrono::steady_clock::now();
  int currentLevel = -1;
  MSG message = {};
  for (;;) {
    while (PeekMessageW(&message, nullptr, 0, 0, PM_REMOVE)) {
      if (message.message == WM_QUIT)
        return 0;
      TranslateMessage(&message);
      DispatchMessageW(&message);
    }
    const double elapsed = std::chrono::duration<double>(std::chrono::steady_clock::now() - started).count();
    double boundary = 0;
    int level = phases.back().level;
    for (const auto& phase : phases) {
      boundary += phase.seconds;
      if (elapsed < boundary) {
        level = phase.level;
        break;
      }
    }
    if (level != currentLevel) {
      currentLevel = level;
      const auto unixMs = std::chrono::duration_cast<std::chrono::milliseconds>(
                              std::chrono::system_clock::now().time_since_epoch())
                              .count();
      std::printf("PHASE %d %lld\n", level, static_cast<long long>(unixMs));
      std::fflush(stdout);
      SetWindowTextW(window, level ? L"Shard GPU Stress Fixture [HEAVY]" : L"Shard GPU Stress Fixture [light]");
    }

    D3D11_MAPPED_SUBRESOURCE mapped = {};
    if (SUCCEEDED(context->Map(params.Get(), 0, D3D11_MAP_WRITE_DISCARD, 0, &mapped))) {
      auto* p = static_cast<Params*>(mapped.pData);
      p->time = static_cast<float>(elapsed);
      p->iterations = level ? iterations : 4;
      p->size[0] = static_cast<float>(width);
      p->size[1] = static_cast<float>(height);
      context->Unmap(params.Get(), 0);
    }
    const D3D11_VIEWPORT viewport = {0, 0, static_cast<float>(width), static_cast<float>(height), 0, 1};
    context->RSSetViewports(1, &viewport);
    context->OMSetRenderTargets(1, target.GetAddressOf(), nullptr);
    context->IASetPrimitiveTopology(D3D11_PRIMITIVE_TOPOLOGY_TRIANGLELIST);
    context->VSSetShader(vertexShader.Get(), nullptr, 0);
    context->PSSetShader(pixelShader.Get(), nullptr, 0);
    context->PSSetConstantBuffers(0, 1, params.GetAddressOf());
    context->Draw(3, 0);
    // Heavy phases present uncapped so the 3D queue never drains, like a
    // GPU-bound game without a frame cap.
    swapChain->Present(level ? 0 : 1, 0);
  }
}
#else
int main() { return 0; }
#endif
