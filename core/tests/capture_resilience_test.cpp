#include "capture_resilience.h"

#include <cassert>
#include <cstdio>

using clipforge::CaptureRecoveryState;
using clipforge::computeClientAreaCrop;
using clipforge::captionBoundaryInset;

int main()
{
  const auto framed = computeClientAreaCrop(976, 579, 100, 100, 108, 131, 960, 540);
  assert(framed.valid);
  assert(framed.left == 8);
  assert(framed.top == 31);
  assert(framed.right == 8);
  assert(framed.bottom == 8);

  assert(captionBoundaryInset(96) == 4);
  assert(captionBoundaryInset(120) == 5);
  assert(captionBoundaryInset(192) == 8);
  const auto guarded =
      computeClientAreaCrop(976, 579, 100, 100, 108, 131 + captionBoundaryInset(120),
                            960, 540 - captionBoundaryInset(120));
  assert(guarded.valid);
  assert(guarded.top == 36);
  assert(guarded.bottom == 8);

  const auto borderless = computeClientAreaCrop(1920, 1080, 0, 0, 0, 0, 1920, 1080);
  assert(borderless.valid);
  assert(borderless.left == 0 && borderless.top == 0 && borderless.right == 0 && borderless.bottom == 0);

  const auto stale = computeClientAreaCrop(1280, 720, 0, 0, 5000, 5000, 960, 540);
  assert(!stale.valid);
  assert(stale.left == 0 && stale.top == 0 && stale.right == 0 && stale.bottom == 0);

  CaptureRecoveryState recovery;
  recovery.onDisplayState(1); // Initial registration callback: not a wake.
  assert(!recovery.consumeRecovery());
  recovery.onDisplayState(0);
  assert(!recovery.consumeRecovery());
  recovery.onDisplayState(1);
  assert(recovery.consumeRecovery());
  assert(!recovery.consumeRecovery());
  recovery.onResume();
  assert(recovery.consumeRecovery());

  std::puts("capture resilience tests passed");
  return 0;
}
