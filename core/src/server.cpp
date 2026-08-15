#include "server.h"

#include <cstdio>
#include <random>

#ifdef _WIN32
#define WIN32_LEAN_AND_MEAN
#include <winsock2.h>
#endif

#include <ixwebsocket/IXConnectionState.h>
#include <ixwebsocket/IXWebSocket.h>
#include <ixwebsocket/IXWebSocketMessage.h>
#include <ixwebsocket/IXWebSocketServer.h>

namespace clipforge {

Server::Server(Config& config, Rpc& rpc) : config_(config), rpc_(rpc) {}

Server::~Server()
{
  stop();
}

int Server::pickFreePort()
{
  // Find a free TCP port by binding a probe socket to port 0. There is a
  // small TOCTOU window until we re-bind; the retry loop in start() covers it.
#ifdef _WIN32
  WSADATA wsa;
  if (WSAStartup(MAKEWORD(2, 2), &wsa) != 0)
    return -1;
  SOCKET s = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
  if (s == INVALID_SOCKET) {
    WSACleanup();
    return -1;
  }
  sockaddr_in addr = {};
  addr.sin_family = AF_INET;
  addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  addr.sin_port = 0;
  if (bind(s, (sockaddr*)&addr, sizeof(addr)) != 0) {
    closesocket(s);
    WSACleanup();
    return -1;
  }
  int len = sizeof(addr);
  int port = -1;
  if (getsockname(s, (sockaddr*)&addr, &len) == 0)
    port = ntohs(addr.sin_port);
  closesocket(s);
  WSACleanup();
  return port;
#else
  return -1;
#endif
}

bool Server::start()
{
  if (running_.exchange(true))
    return false;

  int requested = config_.port;
  if (requested == 0)
    requested = -1; // -1 signals "pick a free port"
  int attempt = 0;
  const int maxAttempts = 16;

  for (; attempt < maxAttempts; attempt++) {
    int port = requested > 0 ? requested : pickFreePort();
    if (port <= 0)
      break;

    // ixwebsocket v11: (port, host, backlog, maxConnections, handshakeTimeoutSecs)
    server_ = std::make_unique<ix::WebSocketServer>(port, "127.0.0.1", 4, 4, 15);

    server_->setOnConnectionCallback([this](std::weak_ptr<ix::WebSocket> wsWeak,
                                            std::shared_ptr<ix::ConnectionState> st) {
      (void)st;
      std::shared_ptr<ix::WebSocket> ws = wsWeak.lock();
      if (!ws)
        return;

      {
        std::lock_guard<std::mutex> lock(clientsMtx_);
        clients_.insert(ws.get());
      }

      ws->setOnMessageCallback([this, wsWeak](const ix::WebSocketMessagePtr& msg) {
        std::shared_ptr<ix::WebSocket> ws = wsWeak.lock();
        if (!ws)
          return;

        if (msg->type == ix::WebSocketMessageType::Open) {
          // Handshake complete — greet the client so the app knows the core
          // came up. (Sending from the connection callback would race the
          // HTTP upgrade.)
          ws->send(nlohmann::json({{"jsonrpc", "2.0"}, {"method", "ready"}, {"params", rpc_.buildState()}}).dump());
        } else if (msg->type == ix::WebSocketMessageType::Message) {
          onMessage(ws.get(), msg);
        } else if (msg->type == ix::WebSocketMessageType::Close) {
          std::lock_guard<std::mutex> lock(clientsMtx_);
          clients_.erase(ws.get());
        }
      });
    });

    if (server_->listenAndStart()) {
      port_.store(server_->getPort());
      break;
    }
    server_.reset();
  }

  if (port_.load() <= 0) {
    std::fprintf(stderr, "clipcore: failed to bind RPC server after %d attempts\n", attempt);
    return false;
  }

  thread_ = std::thread([this] {
    while (running_.load())
      std::this_thread::sleep_for(std::chrono::milliseconds(100));
  });

  std::printf("PORT %d\n", port_.load());
  std::fflush(stdout);
  return true;
}

void Server::stop()
{
  if (!running_.exchange(false))
    return;
  {
    std::lock_guard<std::mutex> lock(clientsMtx_);
    clients_.clear();
  }
  if (server_)
    server_->stop();
  if (thread_.joinable())
    thread_.join();
  server_.reset();
}

void Server::onMessage(ix::WebSocket* ws, const ix::WebSocketMessagePtr& msg)
{
  std::string reply = rpc_.handle(msg->str);
  if (!reply.empty())
    ws->send(reply);
}

void Server::broadcast(const char* type, const nlohmann::json& params)
{
  if (!running_.load() || !server_)
    return;
  nlohmann::json notification = {{"jsonrpc", "2.0"}, {"method", type}, {"params", params}};
  std::string text = notification.dump();

  std::lock_guard<std::mutex> lock(clientsMtx_);
  for (ix::WebSocket* ws : clients_) {
    if (ws)
      ws->send(text);
  }
}

} // namespace clipforge
