#pragma once

#include <cstdint>
#include <cmath>

namespace shard {

// OBS packet timestamps count ticks of 1/timebase_den (cur_pts advances by
// timebase_num per frame). Round once, never truncate through microseconds:
// 1/60 second cannot be represented exactly in integer microseconds.
inline int64_t replayRescale(int64_t ticks, int64_t fromDen, int64_t toDen)
{
  return static_cast<int64_t>(std::llround(static_cast<long double>(ticks) * toDen / fromDen));
}

struct ReplayTimestamps {
  int64_t pts;
  int64_t dts;
};

inline ReplayTimestamps replayTimestamps(int64_t pts, int64_t dts, int64_t fromDen,
                                         int64_t toDen, int64_t startUs)
{
  const auto offset = replayRescale(startUs, 1000000, toDen);
  return {replayRescale(pts, fromDen, toDen) - offset,
          replayRescale(dts, fromDen, toDen) - offset};
}

inline bool replayCanPurge(bool empty, int keyframes)
{
  return !empty && keyframes > 2;
}

} // namespace shard
