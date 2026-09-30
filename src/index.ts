import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import * as z from "zod";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { registerAdvancedTools } from "./advancedTools.js";

const ROOT = path.resolve("D:\\Documents For Work");
const LOG_DIR = path.resolve("C:\\MCP-Gateway\\logs");
const BACKUP_DIR = path.resolve("C:\\MCP-Gateway\\backups");
const PORT = 3000;
const HOST = "127.0.0.1";
const VERSION = "3.0.0";
const CONFIRMATION_TTL_MS = 10 * 60 * 1000;
const MAX_SEARCH_RESULTS = 500;
const MAX_READ_BYTES = 10 * 1024 * 1024;

await fs.mkdir(ROOT, { recursive: true });
await fs.mkdir(LOG_DIR, { recursive: true });
await fs.mkdir(BACKUP_DIR, { recursive: true });

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function jsonResult(data: unknown) {
  return textResult(JSON.stringify(data, null, 2));
}

function relativeDisplay(target: string): string {
  return path.relative(ROOT, target) || ".";
}

function safePath(input = ""): string {
  if (typeof input !== "string" || input.includes("\0")) throw new Error("Invalid path");
  const normalizedInput = input.trim();
  if (normalizedInput === "" || normalizedInput === ".") return ROOT;
  if (normalizedInput.startsWith("\\\\") || normalizedInput.startsWith("//")) {
    throw new Error("UNC paths are not allowed");
  }
  const target = path.isAbsolute(normalizedInput)
    ? path.resolve(normalizedInput)
    : path.resolve(ROOT, normalizedInput);
  const relative = path.relative(ROOT, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Access outside D:\\Documents For Work is not allowed");
  }
  return target;
}

async function ensureInsideRoot(target: string): Promise<void> {
  const realRoot = await fs.realpath(ROOT);
  let current = target;

  while (true) {
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) throw new Error("Symbolic links are not allowed");

      const real = await fs.realpath(current);
      const relative = path.relative(realRoot, real);
      if (relative.startsWith("..") || path.isAbsolute(relative)) {
        throw new Error("Path escapes allowed directory");
      }

      const relativeTarget = path.relative(ROOT, target);
      if (relativeTarget && !relativeTarget.startsWith("..")) {
        const parts = relativeTarget.split(path.sep);
        let cursor = ROOT;
        for (const part of parts) {
          cursor = path.join(cursor, part);
          try {
            const partStat = await fs.lstat(cursor);
            if (partStat.isSymbolicLink()) throw new Error(`Symbolic link is not allowed: ${part}`);
          } catch (err: any) {
            if (err?.code === "ENOENT") break;
            throw err;
          }
        }
      }
      return;
    } catch (err: any) {
      if (err?.code === "ENOENT") {
        const parent = path.dirname(current);
        if (parent === current) throw new Error("Invalid path");
        current = parent;
        continue;
      }
      throw err;
    }
  }
}

async function securePath(input = ""): Promise<string> {
  const target = safePath(input);
  await ensureInsideRoot(target);
  return target;
}

function ensureNotRoot(target: string): void {
  if (path.resolve(target) === ROOT) throw new Error("Operation on the root directory is not allowed");
}

async function audit(action: string, target: string, status: string, details?: unknown): Promise<void> {
  const line = JSON.stringify({
    time: new Date().toISOString(),
    action,
    target,
    status,
    ...(details !== undefined ? { details } : {})
  }) + "\n";
  await fs.appendFile(path.join(LOG_DIR, "audit.jsonl"), line, "utf8");
}

function backupName(target: string): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `${timestamp}-${randomUUID()}-${path.basename(target)}`;
}

async function backupPath(target: string): Promise<string | undefined> {
  try {
    const stat = await fs.lstat(target);
    const destination = path.join(BACKUP_DIR, backupName(target));
    if (stat.isFile()) {
      await fs.copyFile(target, destination);
    } else if (stat.isDirectory()) {
      await fs.cp(target, destination, { recursive: true, errorOnExist: true, force: false });
    } else {
      throw new Error("Only files and directories can be backed up");
    }
    return destination;
  } catch (err: any) {
    if (err?.code === "ENOENT") return undefined;
    throw err;
  }
}

type PendingAction = {
  id: string;
  action: string;
  createdAt: number;
  expiresAt: number;
  execute: () => Promise<string>;
};

const pending = new Map<string, PendingAction>();

function cleanupExpiredConfirmations(): void {
  const now = Date.now();
  for (const [id, action] of pending) {
    if (action.expiresAt <= now) pending.delete(id);
  }
}

function confirmation(action: string, execute: () => Promise<string>) {
  cleanupExpiredConfirmations();
  const id = randomUUID();
  const createdAt = Date.now();
  pending.set(id, { id, action, createdAt, expiresAt: createdAt + CONFIRMATION_TTL_MS, execute });
  return {
    confirmation_required: true,
    confirmation_id: id,
    action,
    expires_in_seconds: CONFIRMATION_TTL_MS / 1000,
    message: "User confirmation is required before this operation can be executed."
  };
}

function createMcpServer(): McpServer {
  const server = new McpServer({ name: "windows-filesystem-gateway", version: VERSION });

  server.tool(
    "fs_list",
    "List files and folders inside D:\\Documents For Work. Read-only; no confirmation required.",
    { path: z.string().default("") },
    async ({ path: input }) => {
      const target = await securePath(input);
      const stat = await fs.stat(target);
      if (!stat.isDirectory()) throw new Error("Target is not a directory");
      const entries = await fs.readdir(target, { withFileTypes: true });
      const result = entries.map(entry => ({
        name: entry.name,
        type: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other",
        path: path.relative(ROOT, path.join(target, entry.name))
      })).sort((a, b) => a.type !== b.type ? (a.type === "directory" ? -1 : 1) : a.name.localeCompare(b.name));
      await audit("LIST", relativeDisplay(target), "SUCCESS");
      return jsonResult(result);
    }
  );

  server.tool(
    "fs_read",
    "Read a UTF-8 text file inside D:\\Documents For Work. Read-only; no confirmation required.",
    { path: z.string() },
    async ({ path: input }) => {
      const target = await securePath(input);
      const stat = await fs.stat(target);
      if (!stat.isFile()) throw new Error("Target is not a file");
      if (stat.size > MAX_READ_BYTES) throw new Error(`File is too large. Maximum readable size is ${MAX_READ_BYTES} bytes.`);
      const content = await fs.readFile(target, "utf8");
      await audit("READ", relativeDisplay(target), "SUCCESS");
      return textResult(content);
    }
  );

  server.tool(
    "fs_search",
    "Search file and directory names recursively inside D:\\Documents For Work. Read-only.",
    { query: z.string().min(1), path: z.string().default("") },
    async ({ query, path: input }) => {
      const start = await securePath(input);
      const stat = await fs.stat(start);
      if (!stat.isDirectory()) throw new Error("Search path must be a directory");
      const results: Array<{ name: string; type: string; path: string }> = [];
      const needle = query.toLowerCase();

      async function walk(dir: string): Promise<void> {
        if (results.length >= MAX_SEARCH_RESULTS) return;
        const entries = await fs.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (results.length >= MAX_SEARCH_RESULTS) return;
          const full = path.join(dir, entry.name);
          if (entry.isSymbolicLink()) continue;
          if (entry.name.toLowerCase().includes(needle)) {
            results.push({
              name: entry.name,
              type: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other",
              path: path.relative(ROOT, full)
            });
          }
          if (entry.isDirectory()) await walk(full);
        }
      }

      await walk(start);
      await audit("SEARCH", relativeDisplay(start), "SUCCESS", { query, results: results.length });
      return jsonResult({ query, count: results.length, limit: MAX_SEARCH_RESULTS, results });
    }
  );

  server.tool(
    "fs_create_file",
    "Create a NEW UTF-8 file inside D:\\Documents For Work. No confirmation required. Existing files are never overwritten.",
    { path: z.string().min(1), content: z.string() },
    async ({ path: input, content }) => {
      const target = await securePath(input);
      ensureNotRoot(target);
      const parent = path.dirname(target);
      await ensureInsideRoot(parent);
      await fs.mkdir(parent, { recursive: true });
      try {
        await fs.writeFile(target, content, { encoding: "utf8", flag: "wx" });
      } catch (err: any) {
        if (err?.code === "EEXIST") throw new Error("File already exists. Use fs_edit_file instead.");
        throw err;
      }
      await audit("CREATE_FILE", relativeDisplay(target), "SUCCESS");
      return textResult(`Created: ${relativeDisplay(target)}`);
    }
  );

  server.tool(
    "fs_create_directory",
    "Create a NEW directory inside D:\\Documents For Work. No confirmation required. Existing directories are not modified.",
    { path: z.string().min(1) },
    async ({ path: input }) => {
      const target = await securePath(input);
      ensureNotRoot(target);
      await fs.mkdir(target, { recursive: false });
      await audit("CREATE_DIRECTORY", relativeDisplay(target), "SUCCESS");
      return textResult(`Created directory: ${relativeDisplay(target)}`);
    }
  );

  server.tool(
    "fs_edit_file",
    "Replace the entire content of an EXISTING UTF-8 file. ALWAYS requires explicit confirmation through fs_confirm.",
    { path: z.string().min(1), content: z.string() },
    async ({ path: input, content }) => {
      const target = await securePath(input);
      ensureNotRoot(target);
      const stat = await fs.stat(target);
      if (!stat.isFile()) throw new Error("Target is not a file");
      const request = confirmation(`EDIT ${relativeDisplay(target)}`, async () => {
        await ensureInsideRoot(target);
        const currentStat = await fs.stat(target);
        if (!currentStat.isFile()) throw new Error("Target is no longer a file");
        const backup = await backupPath(target);
        await fs.writeFile(target, content, "utf8");
        await audit("EDIT_FILE", relativeDisplay(target), "SUCCESS", { backup });
        return `Edited: ${relativeDisplay(target)}${backup ? `\nBackup: ${backup}` : ""}`;
      });
      await audit("EDIT_REQUEST", relativeDisplay(target), "PENDING", { confirmation_id: request.confirmation_id });
      return jsonResult(request);
    }
  );

  server.tool(
    "fs_delete",
    "Delete an existing file or directory. ALWAYS requires explicit confirmation through fs_confirm. A backup is created first.",
    { path: z.string().min(1) },
    async ({ path: input }) => {
      const target = await securePath(input);
      ensureNotRoot(target);
      await fs.access(target);
      const request = confirmation(`DELETE ${relativeDisplay(target)}`, async () => {
        await ensureInsideRoot(target);
        await fs.access(target);
        const backup = await backupPath(target);
        await fs.rm(target, { recursive: true, force: false });
        await audit("DELETE", relativeDisplay(target), "SUCCESS", { backup });
        return `Deleted: ${relativeDisplay(target)}${backup ? `\nBackup: ${backup}` : ""}`;
      });
      await audit("DELETE_REQUEST", relativeDisplay(target), "PENDING", { confirmation_id: request.confirmation_id });
      return jsonResult(request);
    }
  );

  server.tool(
    "fs_move",
    "Move or rename a file/directory inside D:\\Documents For Work. ALWAYS requires explicit confirmation through fs_confirm.",
    { from: z.string().min(1), to: z.string().min(1) },
    async ({ from, to }) => {
      const source = await securePath(from);
      const destination = await securePath(to);
      ensureNotRoot(source);
      ensureNotRoot(destination);
      await fs.access(source);
      try {
        await fs.access(destination);
        throw new Error("Destination already exists");
      } catch (err: any) {
        if (err?.message === "Destination already exists") throw err;
        if (err?.code !== "ENOENT") throw err;
      }
      const request = confirmation(`MOVE ${relativeDisplay(source)} -> ${relativeDisplay(destination)}`, async () => {
        await ensureInsideRoot(source);
        await ensureInsideRoot(destination);
        await fs.access(source);
        try {
          await fs.access(destination);
          throw new Error("Destination now exists");
        } catch (err: any) {
          if (err?.message === "Destination now exists") throw err;
          if (err?.code !== "ENOENT") throw err;
        }
        await fs.mkdir(path.dirname(destination), { recursive: true });
        await fs.rename(source, destination);
        await audit("MOVE", `${relativeDisplay(source)} -> ${relativeDisplay(destination)}`, "SUCCESS");
        return `Moved: ${relativeDisplay(source)} -> ${relativeDisplay(destination)}`;
      });
      await audit("MOVE_REQUEST", `${relativeDisplay(source)} -> ${relativeDisplay(destination)}`, "PENDING", { confirmation_id: request.confirmation_id });
      return jsonResult(request);
    }
  );

  server.tool(
    "fs_confirm",
    "Approve or reject a pending EDIT, DELETE, MOVE, or RENAME operation. Confirmation IDs expire after 10 minutes.",
    { confirmation_id: z.string().uuid(), approve: z.boolean() },
    async ({ confirmation_id, approve }) => {
      cleanupExpiredConfirmations();
      const action = pending.get(confirmation_id);
      if (!action) throw new Error("Confirmation expired or invalid");
      pending.delete(confirmation_id);
      if (!approve) {
        await audit("CONFIRMATION", action.action, "REJECTED", { confirmation_id });
        return textResult("Operation cancelled.");
      }
      try {
        const result = await action.execute();
        await audit("CONFIRMATION", action.action, "APPROVED", { confirmation_id });
        return textResult(result);
      } catch (err: any) {
        await audit("CONFIRMATION", action.action, "FAILED", { confirmation_id, error: err?.message ?? String(err) });
        throw err;
      }
    }
  );

  registerAdvancedTools(server, {
    root: ROOT,
    securePath,
    ensureInsideRoot,
    ensureNotRoot,
    relativeDisplay,
    audit
  });

  return server;
}

const app = express();
app.use(express.json({ limit: "32mb" }));

app.get("/health", (_req, res) => {
  res.status(200).json({
    status: "ok",
    service: "windows-filesystem-gateway",
    version: VERSION,
    root: ROOT,
    mcp: `http://${HOST}:${PORT}/mcp`,
    capabilities: ["text", "binary", "image", "video", "docx", "xlsx", "pdf-preview", "psd-preview", "ai-preview"]
  });
});

app.post("/mcp", async (req, res) => {
  const server = createMcpServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err: any) {
    console.error("[MCP ERROR]", err);
    await audit("MCP_REQUEST", "/mcp", "FAILED", { error: err?.message ?? String(err) });
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal MCP server error" }, id: null });
    }
  } finally {
    try { await transport.close(); } catch { /* ignore close errors */ }
  }
});

app.get("/mcp", (_req, res) => {
  res.status(405).json({ error: "Method Not Allowed", message: "Use POST for the MCP Streamable HTTP endpoint." });
});

app.delete("/mcp", (_req, res) => {
  res.status(405).json({ error: "Method Not Allowed", message: "This MCP server uses stateless Streamable HTTP." });
});

app.use((_req, res) => res.status(404).json({ error: "Not Found" }));

const httpServer = app.listen(PORT, HOST, () => {
  console.log("");
  console.log("==========================================");
  console.log(" Windows Filesystem MCP Gateway");
  console.log("==========================================");
  console.log(`Root   : ${ROOT}`);
  console.log(`MCP    : http://${HOST}:${PORT}/mcp`);
  console.log(`Health : http://${HOST}:${PORT}/health`);
  console.log("Mode   : Stateless Streamable HTTP");
  console.log(`Version: ${VERSION}`);
  console.log("==========================================");
  console.log("");
});

async function shutdown(signal: string) {
  console.log(`\nReceived ${signal}. Shutting down...`);
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
