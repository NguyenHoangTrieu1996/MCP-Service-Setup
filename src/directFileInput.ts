import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import fs from "node:fs/promises";
import dns from "node:dns/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

const ROOT = path.resolve(process.env.MCP_ROOT || "C:\\Users\\ADMIN\\Documents\\For Works");
const LOG_DIR = path.resolve(process.env.MCP_LOG_DIR || "C:\\MCP-Gateway\\logs");
const DEFAULT_MAX_BYTES = 100 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 120_000;
const MAX_REDIRECTS = 5;
const CREATE = { readOnlyHint: false, destructiveHint: false, openWorldHint: true };

const OpenAIFileSchema = z.object({
  download_url: z.string().url(),
  file_id: z.string().min(1),
  mime_type: z.string().optional(),
  file_name: z.string().optional()
}).strict();

type OpenAIFile = z.infer<typeof OpenAIFileSchema>;

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function jsonResult(value: unknown) {
  return textResult(JSON.stringify(value, null, 2));
}

function display(target: string) {
  return path.relative(ROOT, target) || ".";
}

function maxBytes(): number {
  const configured = Number(process.env.MCP_DIRECT_FILE_MAX_BYTES || DEFAULT_MAX_BYTES);
  if (!Number.isSafeInteger(configured) || configured < 1) return DEFAULT_MAX_BYTES;
  return configured;
}

function assertInsideRoot(target: string) {
  const relative = path.relative(ROOT, target);
  if (relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) {
    throw new Error("Path escapes the configured MCP root");
  }
}

function safeTarget(input: string) {
  if (!input?.trim() || input.includes("\0")) throw new Error("path is required");
  if (/^[a-z]:[^\\/]/i.test(input) || /^[a-z]:$/i.test(input)) throw new Error("Drive-relative paths are not allowed");
  if (input.startsWith("\\\\") || input.startsWith("//")) throw new Error("UNC paths are not allowed");
  const withoutDrive = input.replace(/^[a-z]:[\\/]/i, "");
  if (withoutDrive.includes(":")) throw new Error("Alternate data streams are not allowed");
  for (const part of withoutDrive.split(/[\\/]/)) {
    if (!part || part === "." || part === "..") continue;
    if (/[. ]$/.test(part) || /[<>"|?*\x00-\x1f]/.test(part) || /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/i.test(part)) {
      throw new Error("Invalid or reserved Windows path component");
    }
  }
  const target = path.isAbsolute(input) ? path.resolve(input) : path.resolve(ROOT, input);
  assertInsideRoot(target);
  if (target === ROOT) throw new Error("Cannot create the MCP root as a file");
  return target;
}

async function ensureSafeParent(target: string) {
  await fs.mkdir(ROOT, { recursive: true });
  const parent = path.dirname(target);
  assertInsideRoot(parent);
  await fs.mkdir(parent, { recursive: true });

  const realRoot = await fs.realpath(ROOT);
  const realParent = await fs.realpath(parent);
  const relative = path.relative(realRoot, realParent);
  if (relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) {
    throw new Error("Destination parent escapes the configured MCP root");
  }

  const relativeTarget = path.relative(ROOT, target);
  let cursor = ROOT;
  for (const part of relativeTarget.split(path.sep).slice(0, -1)) {
    cursor = path.join(cursor, part);
    const stat = await fs.lstat(cursor);
    if (stat.isSymbolicLink()) throw new Error("Symbolic links are not allowed in destination paths");
  }
}

function isPrivateIpv4(address: string) {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some(value => !Number.isInteger(value) || value < 0 || value > 255)) return false;
  const [a, b] = parts;
  return a === 10 || a === 127 || a === 0 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    a >= 224;
}

function isPrivateIpv6(address: string) {
  const value = address.toLowerCase().split("%")[0] || "";
  return value === "::" || value === "::1" || value.startsWith("fc") || value.startsWith("fd") ||
    value.startsWith("fe8") || value.startsWith("fe9") || value.startsWith("fea") || value.startsWith("feb") ||
    value.startsWith("ff");
}

async function assertPublicHttpsUrl(raw: string) {
  const url = new URL(raw);
  if (url.protocol !== "https:") throw new Error("ChatGPT file download URL must use HTTPS");
  if (url.username || url.password) throw new Error("Credentials in download URLs are not allowed");

  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const ipKind = net.isIP(hostname);
  if ((ipKind === 4 && isPrivateIpv4(hostname)) || (ipKind === 6 && isPrivateIpv6(hostname))) {
    throw new Error("Private, loopback, link-local and multicast download addresses are not allowed");
  }
  if (!ipKind) {
    const addresses = await dns.lookup(hostname, { all: true, verbatim: true });
    if (!addresses.length) throw new Error("Download hostname did not resolve");
    for (const entry of addresses) {
      if ((entry.family === 4 && isPrivateIpv4(entry.address)) || (entry.family === 6 && isPrivateIpv6(entry.address))) {
        throw new Error("Download hostname resolves to a private or local address");
      }
    }
  }
  return url;
}

async function fetchOpenAIFile(downloadUrl: string): Promise<Response> {
  let current = await assertPublicHttpsUrl(downloadUrl);
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
    const response = await fetch(current, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: { "user-agent": "MCP-Service-Setup/direct-file-input" }
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location) throw new Error("File download redirect did not include a Location header");
      if (redirects === MAX_REDIRECTS) throw new Error("Too many redirects while downloading ChatGPT file");
      current = await assertPublicHttpsUrl(new URL(location, current).toString());
      continue;
    }
    if (!response.ok) throw new Error(`ChatGPT file download failed with HTTP ${response.status}`);
    if (!response.body) throw new Error("ChatGPT file download returned no body");
    return response;
  }
  throw new Error("Unable to download ChatGPT file");
}

async function audit(action: string, target: string, status: string, details?: unknown) {
  await fs.mkdir(LOG_DIR, { recursive: true });
  const record = JSON.stringify({ timestamp: new Date().toISOString(), action, target, status, details }) + os.EOL;
  await fs.appendFile(path.join(LOG_DIR, "audit.jsonl"), record, "utf8");
}

async function createFromOpenAIFile(inputPath: string, file: OpenAIFile) {
  const target = safeTarget(inputPath);
  await ensureSafeParent(target);
  const limit = maxBytes();
  const response = await fetchOpenAIFile(file.download_url);
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > limit) {
    throw new Error(`File is too large: ${declaredLength} bytes; MCP_DIRECT_FILE_MAX_BYTES is ${limit}`);
  }

  let handle: fs.FileHandle | undefined;
  let created = false;
  let bytes = 0;
  const hash = createHash("sha256");
  try {
    try {
      handle = await fs.open(target, "wx");
      created = true;
    } catch (error: any) {
      if (error?.code === "EEXIST") throw new Error("Destination already exists. Choose a new file name; direct file input never overwrites existing files.");
      throw error;
    }

    const reader = response.body!.getReader();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;
      bytes += value.byteLength;
      if (bytes > limit) throw new Error(`File exceeded MCP_DIRECT_FILE_MAX_BYTES (${limit}) while downloading`);
      const chunk = Buffer.from(value);
      hash.update(chunk);
      await handle.write(chunk);
    }
    await handle.sync();
    await handle.close();
    handle = undefined;
    await audit("CREATE_FROM_FILE", display(target), "SUCCESS", {
      bytes,
      sha256: hash.digest("hex"),
      file_id: file.file_id,
      source_name: file.file_name ?? null,
      source_mime_type: file.mime_type ?? null
    });
    return {
      created: display(target),
      bytes,
      file_id: file.file_id,
      source_name: file.file_name ?? null,
      mime_type: file.mime_type ?? response.headers.get("content-type") ?? null
    };
  } catch (error: any) {
    try { await handle?.close(); } catch { /* ignore close error */ }
    if (created) {
      try { await fs.rm(target, { force: true }); } catch { /* ignore cleanup error */ }
    }
    await audit("CREATE_FROM_FILE", display(target), "FAILED", { error: error?.message ?? String(error), file_id: file.file_id });
    throw error;
  }
}

export function registerDirectFileInputTools(server: McpServer): void {
  server.registerTool(
    "fs_create_from_file",
    {
      title: "Create file from ChatGPT file",
      description: "Create a NEW file directly from a ChatGPT-provided file parameter. ChatGPT supplies a temporary download URL and file ID; the gateway downloads the bytes directly to MCP_ROOT without base64. Existing files are never overwritten.",
      inputSchema: {
        path: z.string().min(1),
        file: OpenAIFileSchema
      },
      annotations: CREATE,
      _meta: {
        "openai/fileParams": ["file"]
      }
    },
    async ({ path: input, file }) => jsonResult(await createFromOpenAIFile(input, file))
  );
}
