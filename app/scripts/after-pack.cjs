// electron-builder afterPack hook: removes Chromium GPU payload Shard never
// loads. The renderer uses only DOM, <video> and 2D canvas; no WebGPU or
// WebGL. Removed:
//   - dxcompiler/dxil: DirectX Shader Compiler, loaded only by WebGPU's D3D12
//     backend (ANGLE's D3D11 path uses d3dcompiler_47.dll, which stays).
//   - SwiftShader Vulkan ICD: software WebGL/WebGPU fallback, which Chromium
//     no longer enables without --enable-unsafe-swiftshader. With hardware
//     acceleration off, Chromium composites in software without it.
//   - Bundled Vulkan loader: only that ICD needed it; a system loader from
//     the GPU driver is used if Chromium ever asks for Vulkan.
// LICENSES.chromium.html stays: it is the required third-party notice.
const { existsSync, rmSync } = require("node:fs");
const path = require("node:path");

const REMOVED = {
  win32: ["dxcompiler.dll", "dxil.dll", "vk_swiftshader.dll", "vk_swiftshader_icd.json", "vulkan-1.dll"],
  linux: ["libvk_swiftshader.so", "vk_swiftshader_icd.json", "libvulkan.so.1"],
};

exports.default = async function afterPack(context) {
  const names = REMOVED[context.electronPlatformName] ?? [];
  for (const name of names) {
    const file = path.join(context.appOutDir, name);
    if (!existsSync(file)) continue;
    rmSync(file, { force: true });
    console.log(`  • removed unused Chromium payload ${name}`);
  }
};

exports.REMOVED = REMOVED;
