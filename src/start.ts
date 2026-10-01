// Default launcher configuration. Environment variables still take precedence.
process.env.MCP_PORT ??= "8765";

await import("./bootstrap.js");
