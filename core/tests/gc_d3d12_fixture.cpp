// GPL-2.0-or-later
// Animated D3D12 target used by scripts/game-capture-test.mjs.
#ifdef _WIN32
#include <windows.h>
#include <d3d12.h>
#include <dxgi1_4.h>
#include <wrl/client.h>

#include <chrono>
#include <cmath>
#include <utility>
#include <thread>

using Microsoft::WRL::ComPtr;

namespace {
constexpr UINT kBufferCount = 2;

LRESULT CALLBACK windowProc(HWND window, UINT message, WPARAM wparam, LPARAM lparam)
{
  if (message == WM_DESTROY) {
    PostQuitMessage(0);
    return 0;
  }
  return DefWindowProcW(window, message, wparam, lparam);
}

struct Renderer {
  ComPtr<ID3D12Device> device;
  ComPtr<ID3D12CommandQueue> queue;
  ComPtr<IDXGISwapChain3> swapChain;
  ComPtr<ID3D12DescriptorHeap> rtvHeap;
  ComPtr<ID3D12Resource> buffers[kBufferCount];
  ComPtr<ID3D12CommandAllocator> allocators[kBufferCount];
  ComPtr<ID3D12GraphicsCommandList> commands;
  ComPtr<ID3D12Fence> fence;
  HANDLE fenceEvent = nullptr;
  UINT rtvStride = 0;
  UINT64 fenceValue = 0;

  ~Renderer()
  {
    wait();
    if (fenceEvent)
      CloseHandle(fenceEvent);
  }

  bool init(HWND window)
  {
    ComPtr<IDXGIFactory4> factory;
    if (FAILED(CreateDXGIFactory1(IID_PPV_ARGS(&factory))) ||
        FAILED(D3D12CreateDevice(nullptr, D3D_FEATURE_LEVEL_11_0, IID_PPV_ARGS(&device))))
      return false;

    D3D12_COMMAND_QUEUE_DESC queueDesc = {};
    queueDesc.Type = D3D12_COMMAND_LIST_TYPE_DIRECT;
    if (FAILED(device->CreateCommandQueue(&queueDesc, IID_PPV_ARGS(&queue))))
      return false;

    DXGI_SWAP_CHAIN_DESC1 swapDesc = {};
    swapDesc.Width = 960;
    swapDesc.Height = 540;
    swapDesc.Format = DXGI_FORMAT_R8G8B8A8_UNORM;
    swapDesc.SampleDesc.Count = 1;
    swapDesc.BufferUsage = DXGI_USAGE_RENDER_TARGET_OUTPUT;
    swapDesc.BufferCount = kBufferCount;
    swapDesc.SwapEffect = DXGI_SWAP_EFFECT_FLIP_DISCARD;
    ComPtr<IDXGISwapChain1> swapChain1;
    if (FAILED(factory->CreateSwapChainForHwnd(queue.Get(), window, &swapDesc, nullptr, nullptr, &swapChain1)) ||
        FAILED(swapChain1.As(&swapChain)))
      return false;

    D3D12_DESCRIPTOR_HEAP_DESC heapDesc = {};
    heapDesc.NumDescriptors = kBufferCount;
    heapDesc.Type = D3D12_DESCRIPTOR_HEAP_TYPE_RTV;
    if (FAILED(device->CreateDescriptorHeap(&heapDesc, IID_PPV_ARGS(&rtvHeap))))
      return false;
    rtvStride = device->GetDescriptorHandleIncrementSize(D3D12_DESCRIPTOR_HEAP_TYPE_RTV);
    D3D12_CPU_DESCRIPTOR_HANDLE rtv = rtvHeap->GetCPUDescriptorHandleForHeapStart();
    for (UINT i = 0; i < kBufferCount; ++i) {
      if (FAILED(swapChain->GetBuffer(i, IID_PPV_ARGS(&buffers[i]))) ||
          FAILED(device->CreateCommandAllocator(D3D12_COMMAND_LIST_TYPE_DIRECT, IID_PPV_ARGS(&allocators[i]))))
        return false;
      device->CreateRenderTargetView(buffers[i].Get(), nullptr, rtv);
      rtv.ptr += rtvStride;
    }

    if (FAILED(device->CreateCommandList(0, D3D12_COMMAND_LIST_TYPE_DIRECT, allocators[0].Get(), nullptr,
                                         IID_PPV_ARGS(&commands))) ||
        FAILED(commands->Close()) || FAILED(device->CreateFence(0, D3D12_FENCE_FLAG_NONE, IID_PPV_ARGS(&fence))))
      return false;
    fenceEvent = CreateEventW(nullptr, FALSE, FALSE, nullptr);
    return fenceEvent != nullptr;
  }

  void wait()
  {
    if (!queue || !fence || !fenceEvent)
      return;
    const UINT64 value = ++fenceValue;
    if (SUCCEEDED(queue->Signal(fence.Get(), value)) && fence->GetCompletedValue() < value) {
      fence->SetEventOnCompletion(value, fenceEvent);
      WaitForSingleObject(fenceEvent, 2000);
    }
  }

  bool draw(const float color[4])
  {
    const UINT index = swapChain->GetCurrentBackBufferIndex();
    wait();
    if (FAILED(allocators[index]->Reset()) || FAILED(commands->Reset(allocators[index].Get(), nullptr)))
      return false;

    D3D12_RESOURCE_BARRIER barrier = {};
    barrier.Type = D3D12_RESOURCE_BARRIER_TYPE_TRANSITION;
    barrier.Transition.pResource = buffers[index].Get();
    barrier.Transition.Subresource = D3D12_RESOURCE_BARRIER_ALL_SUBRESOURCES;
    barrier.Transition.StateBefore = D3D12_RESOURCE_STATE_PRESENT;
    barrier.Transition.StateAfter = D3D12_RESOURCE_STATE_RENDER_TARGET;
    commands->ResourceBarrier(1, &barrier);

    D3D12_CPU_DESCRIPTOR_HANDLE rtv = rtvHeap->GetCPUDescriptorHandleForHeapStart();
    rtv.ptr += static_cast<SIZE_T>(index) * rtvStride;
    commands->OMSetRenderTargets(1, &rtv, FALSE, nullptr);
    commands->ClearRenderTargetView(rtv, color, 0, nullptr);

    std::swap(barrier.Transition.StateBefore, barrier.Transition.StateAfter);
    commands->ResourceBarrier(1, &barrier);
    if (FAILED(commands->Close()))
      return false;
    ID3D12CommandList* lists[] = {commands.Get()};
    queue->ExecuteCommandLists(1, lists);
    swapChain->Present(1, 0);
    return true;
  }
};
} // namespace

int WINAPI wWinMain(HINSTANCE instance, HINSTANCE, PWSTR, int)
{
  constexpr wchar_t kClassName[] = L"ShardGcD3D12Fixture";
  WNDCLASSW wc = {};
  wc.hInstance = instance;
  wc.lpfnWndProc = windowProc;
  wc.lpszClassName = kClassName;
  wc.hCursor = LoadCursorW(nullptr, MAKEINTRESOURCEW(32512));
  if (!RegisterClassW(&wc))
    return 2;
  HWND window = CreateWindowExW(0, kClassName, L"Shard GC D3D12 Fixture", WS_OVERLAPPEDWINDOW | WS_VISIBLE,
                                CW_USEDEFAULT, CW_USEDEFAULT, 960, 540, nullptr, nullptr, instance, nullptr);
  if (!window)
    return 3;

  Renderer renderer;
  if (!renderer.init(window))
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

    const float seconds = std::chrono::duration<float>(std::chrono::steady_clock::now() - started).count();
    const float color[] = {
        0.5f + 0.5f * std::sin(seconds * 2.1f),
        0.5f + 0.5f * std::sin(seconds * 2.7f + 2.0f),
        0.5f + 0.5f * std::sin(seconds * 3.3f + 4.0f),
        1.0f,
    };
    if (!renderer.draw(color))
      return 5;
    std::this_thread::sleep_for(std::chrono::milliseconds(1));
  }
  return 0;
}
#else
int main() { return 0; }
#endif
