// Replay-save acceptance and worker lifecycle: rejected requests never reach
// the worker, and every acknowledged ("clip.queued") request receives exactly
// one terminal event after its acknowledgement, also while the ring is
// stopped and restarted concurrently.
#undef NDEBUG
#include "save_queue.h"

#include <atomic>
#include <cassert>
#include <cstdio>
#include <map>
#include <mutex>
#include <thread>
#include <vector>

using namespace shard;

namespace {

struct Request {
  uint64_t id = 0;
  int durationSec = 0;
};

// Event log in emission order, as the app would observe it.
struct Log {
  std::mutex mutex;
  std::vector<std::pair<char, uint64_t>> events; // 'q' queued, 't' terminal
  void add(char kind, uint64_t id)
  {
    std::lock_guard<std::mutex> lock(mutex);
    events.emplace_back(kind, id);
  }
};

// Mirrors ReplayRing::saveWorker: one terminal event per request taken.
void worker(SaveQueue<Request>& queue, Log& log)
{
  while (const auto next = queue.next())
    log.add('t', next->id);
}

} // namespace

int main()
{
  // Saving while inactive: never queued, no id, no acknowledgement.
  {
    SaveQueue<Request> queue;
    bool acknowledged = false;
    const auto ack = [&](const Request&, size_t) { acknowledged = true; };
    assert(queue.submit({}, ack) == 0); // never started
    queue.begin();
    assert(queue.submit({}, ack) == 0); // worker running, ring not active yet
    queue.accept();
    queue.close();
    assert(queue.submit({}, ack) == 0); // stopped
    assert(!acknowledged);
    assert(!queue.next().has_value()); // nothing reached the worker
    queue.accept();                    // a late accept after close stays closed
    assert(queue.submit({}, ack) == 0);
  }

  // Accepted requests are drained, in order, after close().
  {
    SaveQueue<Request> queue;
    Log log;
    queue.begin();
    queue.accept();
    const auto ack = [&](const Request& request, size_t depth) {
      log.add('q', request.id);
      assert(depth >= 1);
    };
    const uint64_t first = queue.submit({}, ack);
    const uint64_t second = queue.submit({}, ack);
    assert(first == 1 && second == 2);
    queue.close();
    std::thread drain([&] { worker(queue, log); });
    drain.join();
    assert((log.events == std::vector<std::pair<char, uint64_t>>{{'q', 1}, {'q', 2}, {'t', 1}, {'t', 2}}));
  }

  // Saving concurrently with stop/restart.
  {
    SaveQueue<Request> queue;
    Log log;
    std::atomic<bool> stop{false};
    std::atomic<uint64_t> accepted{0}, rejected{0};
    std::vector<std::thread> savers;
    for (int i = 0; i < 4; ++i) {
      savers.emplace_back([&] {
        while (!stop.load()) {
          const uint64_t id = queue.submit({}, [&](const Request& request, size_t) { log.add('q', request.id); });
          (id ? accepted : rejected).fetch_add(1);
        }
      });
    }
    for (int cycle = 0; cycle < 300; ++cycle) {
      queue.begin();
      std::thread saveWorker([&] { worker(queue, log); });
      queue.accept();
      // Let the savers land at least one accepted request in most cycles.
      const uint64_t before = accepted.load();
      for (int spin = 0; spin < 10000 && accepted.load() == before; ++spin)
        std::this_thread::yield();
      queue.close();
      saveWorker.join();
    }
    stop.store(true);
    for (auto& saver : savers)
      saver.join();
    // After the final stop nothing can be accepted any more.
    assert(queue.submit({}, [](const Request&, size_t) { assert(false); }) == 0);

    std::map<uint64_t, int> queuedAt, terminals;
    for (size_t i = 0; i < log.events.size(); ++i) {
      const auto& [kind, id] = log.events[i];
      if (kind == 'q') {
        assert(!queuedAt.count(id)); // ids are unique across restarts
        queuedAt[id] = static_cast<int>(i);
      } else {
        assert(queuedAt.count(id)); // a terminal always follows its clip.queued
        ++terminals[id];
      }
    }
    assert(queuedAt.size() == accepted.load());
    for (const auto& [id, at] : queuedAt) {
      (void)at;
      assert(terminals[id] == 1); // exactly one terminal per acknowledged request
    }
    assert(accepted.load() > 0 && rejected.load() > 0); // both paths exercised
  }

  std::puts("save queue tests passed");
  return 0;
}
