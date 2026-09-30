import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAssetEditingTools } from "./assetEditing.js";
import { startGateway } from "./index.js";

const registered = new WeakSet<object>();
const prototype = McpServer.prototype as any;
const originalConnect = prototype.connect as (...args: any[]) => Promise<unknown>;

prototype.connect = async function (...args: any[]) {
  if (!registered.has(this)) {
    registerAssetEditingTools(this as McpServer);
    registered.add(this);
  }
  return originalConnect.apply(this, args);
};

void startGateway();
