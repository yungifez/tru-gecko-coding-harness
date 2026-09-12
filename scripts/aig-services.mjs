import { startBridge } from "./aig-claude-bridge.mjs";
import { startServer } from "./aig-tru-adapter.mjs";

const bridge = startBridge();
const target = startServer();
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    bridge.closeAllConnections();
    target.closeAllConnections();
    bridge.close();
    target.close();
  });
}
