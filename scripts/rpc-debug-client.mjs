// Manual RPC round-trip debug client
const port = process.env.CF_PORT;
const ws = new WebSocket(`ws://127.0.0.1:${port}`);
let id = 0;
const log = (...a) => console.log(...a);
ws.addEventListener("open", () => {
  log("open");
  ws.send(JSON.stringify({ jsonrpc: "2.0", id: ++id, method: "state.get", params: {} }));
  log("sent state.get");
  setTimeout(() => {
    ws.send(JSON.stringify({ jsonrpc: "2.0", id: ++id, method: "config.set", params: { capture: { mode: "screen", monitor: 0 } } }));
    log("sent config.set");
  }, 800);
});
ws.addEventListener("message", (ev) => log("MSG:", String(ev.data).slice(0, 150)));
ws.addEventListener("error", (e) => log("ERR", e.message ?? ""));
ws.addEventListener("close", (e) => log("close", e.code));
setTimeout(() => { log("done"); process.exit(0); }, 6000);
