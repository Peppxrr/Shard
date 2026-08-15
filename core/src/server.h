#pragma once

#include "config.h"
#include "jsonrpc.h"

#include <atomic>
#include <memory>
#include <mutex>
#include <set>
#include <thread>

#include <ixwebsocket/IXWebSocket.h>
#include <ixwebsocket/IXWebSocketMessage.h>

// WebSocket JSON-RPC 2.0 server bound to 127.0.0.1. ixwebsocket v11 never
// reads back an OS-assigned ephemeral port, so we choose a concrete free port
// ourselves (config port, or a random high port when 0) and retry on failure.
// The chosen port is printed as the first stdout line: "PORT <n>".
// Events are pushed to every connected client as JSON-RPC notifications.
namespace clipforge {

class Server {
public:
  Server(Config& config, Rpc& rpc);
  ~Server();

  Server(const Server&) = delete;
  Server& operator=(const Server&) = delete;

  bool start(); // bind (retries on port conflict), print PORT line
  void stop();

  // Thread-safe event broadcast (called from OBS/worker threads).
  void broadcast(const char* type, const nlohmann::json& params);

  int port() const { return port_; }

private:
  void onMessage(ix::WebSocket* ws, const ix::WebSocketMessagePtr& msg);
  static int pickFreePort();

  Config& config_;
  Rpc& rpc_;

  std::unique_ptr<ix::WebSocketServer> server_;
  std::thread thread_;
  std::atomic<bool> running_{false};
  std::atomic<int> port_{0};

  std::mutex clientsMtx_;
  std::set<ix::WebSocket*> clients_;
};

} // namespace clipforge
