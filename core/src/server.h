#pragma once

#include "config.h"
#include "jsonrpc.h"

#include <atomic>
#include <condition_variable>
#include <deque>
#include <memory>
#include <mutex>
#include <set>
#include <string>
#include <thread>

#include <ixwebsocket/IXWebSocket.h>
#include <ixwebsocket/IXWebSocketMessage.h>

// WebSocket JSON-RPC 2.0 server bound to 127.0.0.1. ixwebsocket v11 never
// reads back an OS-assigned ephemeral port, so we choose a concrete free port
// ourselves (config port, or a random high port when 0) and retry on failure.
// The chosen port is printed as the first stdout line: "PORT <n>".
// Events are pushed to every connected client as JSON-RPC notifications by a
// dedicated sender thread, so emitters (including libobs output, encoder and
// signal callbacks) never perform socket I/O themselves.
namespace shard {

class Server {
public:
  Server(Config& config, Rpc& rpc);
  ~Server();

  Server(const Server&) = delete;
  Server& operator=(const Server&) = delete;

  bool start(); // bind (retries on port conflict), print PORT line
  void stop();

  // Thread-safe, non-blocking event broadcast (called from OBS/worker
  // threads). Serializes and enqueues; the sender thread does the sends.
  void broadcast(const char* type, const nlohmann::json& params);

  int port() const { return port_; }

private:
  void onMessage(ix::WebSocket* ws, const ix::WebSocketMessagePtr& msg);
  static int pickFreePort();
  void senderLoop();

  Config& config_;
  Rpc& rpc_;

  std::unique_ptr<ix::WebSocketServer> server_;
  std::thread thread_;
  std::atomic<bool> running_{false};
  std::atomic<int> port_{0};

  std::mutex clientsMtx_;
  std::set<ix::WebSocket*> clients_;

  std::mutex outboxMtx_;
  std::condition_variable outboxCv_;
  std::deque<std::string> outbox_;
  uint64_t droppedEvents_ = 0;
};

} // namespace shard
