// Recording flow debug client
const port = process.env.CF_PORT;
const ws = new WebSocket(`ws://127.0.0.1:${port}`);
let id = 0;
ws.addEventListener("open", () => {
  ws.send(JSON.stringify({ jsonrpc: "2.0", id: ++id, method: "recording.start", params: {} }));
  console.log("sent recording.start");
});
ws.addEventListener("message", (ev) => {
  const m = JSON.parse(ev.data);
  console.log("MSG:", JSON.stringify(m).slice(0, 160));
  if (m.id && m.result && m.result.active === true) {
    setTimeout(() => ws.send(JSON.stringify({ jsonrpc: "2.0", id: ++id, method: "recording.stop", params: {} })), 8000);
  }
  if (m.method === "recording.state" && m.params.active === false) {
    console.log("RECORDING FINALIZED:", m.params.path);
    process.exit(0);
  }
});
setTimeout(() => process.exit(1), 30000);
