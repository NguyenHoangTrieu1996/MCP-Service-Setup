import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAssetEditingTools } from "./assetEditing.js";
import { startGateway } from "./index.js";

const registered = new WeakSet<McpServer>();
const originalConnect = McpServer.prototype.connect;

McpServer.prototype.connect = async function (...args: Parameters<McpServer["connect"]>) {
  if (!registered.has(this)) {
    registerAssetEditingTools(this);
    registered.add(this);
  }
  return originalConnect.apply(this, args);
};

void startGateway();
