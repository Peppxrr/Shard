// GPL-2.0-or-later
// Animated D3D11 target used by scripts/game-capture-test.mjs.
#ifdef _WIN32
#include <windows.h>
#include <d3d11.h>
#include <dxgi.h>
#include <wrl/client.h>

#include <chrono>
#include <cmath>
#include <iterator>
#include <thread>
#include <cstdlib>

using Microsoft::WRL::ComPtr;

namespace {
bool replacingWindow = false;
uint32_t requestedWidth = 0, requestedHeight = 0;
uint32_t width = 960, height = 540;

LRESULT CALLBACK windowProc(HWND window, UINT message, WPARAM wparam, LPARAM lparam)
{
  if (message == WM_DESTROY) {
    if (!replacingWindow) PostQuitMessage(0);
    return 0;
  }
  if (message == WM_APP + 1) {
    requestedWidth = static_cast<uint32_t>(wparam);
    requestedHeight = static_cast<uint32_t>(lparam);
    return 0;
  }
  return DefWindowProcW(window, message, wparam, lparam);
}

bool createDevice(HWND window, ComPtr<ID3D11Device>& device, ComPtr<ID3D11DeviceContext>& context,
                  ComPtr<IDXGISwapChain>& swapChain, ComPtr<ID3D11RenderTargetView>& renderTarget)
{
  DXGI_SWAP_CHAIN_DESC desc = {};
  desc.BufferDesc.Width = width;
  desc.BufferDesc.Height = height;
  desc.BufferDesc.Format = DXGI_FORMAT_R8G8B8A8_UNORM;
  desc.SampleDesc.Count = 1;
  desc.BufferUsage = DXGI_USAGE_RENDER_TARGET_OUTPUT;
  desc.BufferCount = 2;
  desc.OutputWindow = window;
  desc.Windowed = TRUE;
  desc.SwapEffect = DXGI_SWAP_EFFECT_DISCARD;

  D3D_FEATURE_LEVEL featureLevel;
  constexpr D3D_FEATURE_LEVEL levels[] = {D3D_FEATURE_LEVEL_11_1, D3D_FEATURE_LEVEL_11_0};
  HRESULT hr = D3D11CreateDeviceAndSwapChain(nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr, 0, levels,
                                              static_cast<UINT>(std::size(levels)), D3D11_SDK_VERSION, &desc,
                                              &swapChain, &device, &featureLevel, &context);
  if (hr == E_INVALIDARG) {
    hr = D3D11CreateDeviceAndSwapChain(nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr, 0, levels + 1, 1,
                                       D3D11_SDK_VERSION, &desc, &swapChain, &device, &featureLevel, &context);
  }
  if (FAILED(hr))
    return false;

  ComPtr<ID3D11Texture2D> backBuffer;
  if (FAILED(swapChain->GetBuffer(0, IID_PPV_ARGS(&backBuffer))))
    return false;
  return SUCCEEDED(device->CreateRenderTargetView(backBuffer.Get(), nullptr, &renderTarget));
}

} // namespace

int WINAPI wWinMain(HINSTANCE instance, HINSTANCE, PWSTR, int)
{
  SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
  if (const char* value = std::getenv("SHARD_GC_FIXTURE_WIDTH")) width = std::atoi(value);
  if (const char* value = std::getenv("SHARD_GC_FIXTURE_HEIGHT")) height = std::atoi(value);
  if (width < 160 || height < 90 || width > 3840 || height > 2160) return 2;
  constexpr wchar_t kClassName[] = L"ShardGcD3D11Fixture";
  WNDCLASSW wc = {};
  wc.hInstance = instance;
  wc.lpfnWndProc = windowProc;
  wc.lpszClassName = kClassName;
  wc.hCursor = LoadCursorW(nullptr, MAKEINTRESOURCEW(32512));
  if (!RegisterClassW(&wc))
    return 2;

  const auto createWindow = [&] {
    RECT rect = {0, 0, static_cast<LONG>(width), static_cast<LONG>(height)};
    AdjustWindowRect(&rect, WS_OVERLAPPEDWINDOW, FALSE);
    return CreateWindowExW(0, kClassName, L"Shard GC D3D11 Fixture", WS_OVERLAPPEDWINDOW | WS_VISIBLE,
                           20, 20, rect.right - rect.left, rect.bottom - rect.top,
                           nullptr, nullptr, instance, nullptr);
  };
  HWND window = createWindow();
  if (!window)
    return 3;

  ComPtr<ID3D11Device> device;
  ComPtr<ID3D11DeviceContext> context;
  ComPtr<IDXGISwapChain> swapChain;
  ComPtr<ID3D11RenderTargetView> renderTarget;
  if (!createDevice(window, device, context, swapChain, renderTarget))
    return 4;

  const auto started = std::chrono::steady_clock::now();
  MSG message = {};
  bool running = true;
  while (running) {
    while (PeekMessageW(&message, nullptr, 0, 0, PM_REMOVE)) {
      if (message.message == WM_QUIT) {
        running = false;
        break;
      }
      TranslateMessage(&message);
      DispatchMessageW(&message);
    }
    if (!running)
      break;
    if (requestedWidth >= 160 && requestedHeight >= 90 && requestedWidth <= 3840 && requestedHeight <= 2160) {
      width = requestedWidth; height = requestedHeight;
      requestedWidth = requestedHeight = 0;
      // Allocate the replacement first so Windows cannot recycle the HWND.
      HWND replacement = createWindow();
      if (!replacement) return 5;
      context->ClearState();
      renderTarget.Reset(); swapChain.Reset(); context.Reset(); device.Reset();
      replacingWindow = true;
      DestroyWindow(window);
      replacingWindow = false;
      window = replacement;
      if (!createDevice(window, device, context, swapChain, renderTarget)) return 6;
    }

    const float seconds = std::chrono::duration<float>(std::chrono::steady_clock::now() - started).count();
    const float color[] = {
        0.5f + 0.5f * std::sin(seconds * 2.1f),
        0.5f + 0.5f * std::sin(seconds * 2.7f + 2.0f),
        0.5f + 0.5f * std::sin(seconds * 3.3f + 4.0f),
        1.0f,
    };
    context->OMSetRenderTargets(1, renderTarget.GetAddressOf(), nullptr);
    context->ClearRenderTargetView(renderTarget.Get(), color);
    swapChain->Present(1, 0);
    std::this_thread::sleep_for(std::chrono::milliseconds(1));
  }

  return 0;
}
#else
int main() { return 0; }
#endif
