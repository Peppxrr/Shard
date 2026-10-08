#pragma once

// Replay-save request queue shared by ReplayRing and its tests; no OBS
// dependency. Acceptance, enqueueing and the worker's exit decision all happen
// under one mutex, so:
// - a request is accepted (and gets an id) only while the queue is open: the
//   ring is active and its worker is running. A rejected request never enters
//   the queue;
// - the acceptance callback ("clip.queued") runs before the worker can take
//   that request, so it precedes the request's terminal event;
// - close() stops acceptance atomically with telling the worker to finish; the
//   worker drains every accepted request before next() reports the end, so each
//   acknowledged request reaches exactly one terminal event.

#include <condition_variable>
#include <cstddef>
#include <cstdint>
#include <deque>
#include <mutex>
#include <optional>

namespace shard {

template <class Request> // Request has a `uint64_t id` member
class SaveQueue {
public:
  // A worker is about to run next(). Requests are not accepted yet.
  void begin()
  {
    std::lock_guard<std::mutex> lock(mutex_);
    running_ = true;
    accepting_ = false;
  }

  // The ring is active: accept requests while the worker runs.
  void accept()
  {
    std::lock_guard<std::mutex> lock(mutex_);
    accepting_ = running_;
  }

  // Stop accepting; the worker drains what was accepted, then next() ends.
  void close()
  {
    {
      std::lock_guard<std::mutex> lock(mutex_);
      accepting_ = false;
      running_ = false;
    }
    cv_.notify_all();
  }

  // Assigns the id and enqueues; `onQueued(request, depth)` runs before the
  // worker can see it. Returns the id, or 0 (nothing enqueued) when closed.
  template <class OnQueued>
  uint64_t submit(Request request, OnQueued&& onQueued)
  {
    uint64_t id = 0;
    {
      std::lock_guard<std::mutex> lock(mutex_);
      if (!accepting_)
        return 0;
      id = request.id = nextId_++;
      queue_.push_back(request);
      onQueued(queue_.back(), queue_.size());
    }
    cv_.notify_one();
    return id;
  }

  // Next accepted request; nullopt once closed and drained.
  std::optional<Request> next()
  {
    std::unique_lock<std::mutex> lock(mutex_);
    cv_.wait(lock, [&] { return !running_ || !queue_.empty(); });
    if (queue_.empty())
      return std::nullopt;
    Request request = queue_.front();
    queue_.pop_front();
    return request;
  }

private:
  std::mutex mutex_;
  std::condition_variable cv_;
  std::deque<Request> queue_;
  bool running_ = false;
  bool accepting_ = false;
  uint64_t nextId_ = 1; // unique for the life of the core, across ring restarts
};

} // namespace shard
