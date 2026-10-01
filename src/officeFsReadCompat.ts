import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import fs from "node:fs/promises";
import path from "node:path";
import { officeTextPage } from "./index.js";

const OFFICE_EXTENSIONS = new Set([".docx", ".docm", ".xlsx", ".xlsm", ".pptx", ".pptm", ".odt", ".ods", ".odp"]);
const DEFAULT_ROOT = "C:\\Users\\ADMIN\\Documents\\For Works";
const MAX_OFFICE_PAGE_CHARS = 128_000;

function rootPath(): string {
  return path.resolve(process.env.MCP_ROOT || DEFAULT_ROOT);
}

function assertUnderRoot(root: string, target: string): void {
  const relative = path.relative(root, target);
  if (relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) {
    throw new Error("Access outside the configured allowed root is not allowed");
  }
}

export async function resolveOfficeReadPath(input: string): Promise<string> {
  if (typeof input !== "string" || input.includes("\0")) throw new Error("Invalid path");
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

  const root = rootPath();
  const target = path.isAbsolute(input) ? path.resolve(input) : path.resolve(root, input);
  assertUnderRoot(root, target);

  const realRoot = await fs.realpath(root);
  let cursor = root;
  const relativeTarget = path.relative(root, target);
  for (const part of relativeTarget.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    const stat = await fs.lstat(cursor);
    if (stat.isSymbolicLink()) throw new Error("Symbolic links are not allowed");
  }

  const realTarget = await fs.realpath(target);
  assertUnderRoot(realRoot, realTarget);
  const stat = await fs.stat(realTarget);
  if (!stat.isFile()) throw new Error("Target is not a regular file");
  return realTarget;
}

export async function readOfficeViaFsRead(input: {
  path: string;
  offset?: number;
  length?: number;
  expected_version?: string;
}) {
  const target = await resolveOfficeReadPath(input.path);
  const extension = path.extname(target).toLowerCase();
  if (!OFFICE_EXTENSIONS.has(extension)) throw new Error("Not an Office document supported by the fs_read compatibility layer");

  const offset = input.offset ?? 0;
  const requestedLength = input.length ?? 65_536;
  const length = Math.min(requestedLength, MAX_OFFICE_PAGE_CHARS);
  const result = await officeTextPage(target, offset, length, input.expected_version);
  return {
    ...result,
    read_mode: "office_text",
    offset_unit: "UTF-16 characters",
    compatibility: "fs_read automatically routed this Office document through the format-aware extractor"
  };
}

let installed = false;

/**
 * Backward compatibility for clients that only expose the historical fs_read tool.
 * Existing UTF-8 behavior is untouched; supported Office files are routed to officeTextPage.
 */
export function installOfficeFsReadCompatibility(): void {
  if (installed) return;
  installed = true;

  const prototype = McpServer.prototype as any;
  const originalTool = prototype.tool as (...args: any[]) => any;

  prototype.tool = function (...args: any[]) {
    if (args[0] === "fs_read" && typeof args[args.length - 1] === "function") {
      const originalHandler = args[args.length - 1];
      args[1] = "Read UTF-8 text files in consecutive pages. For DOCX/XLSX/PPTX/ODT/ODS/ODP, automatically use the Office text extractor. Follow next_offset until eof=true and pass expected_version when supplied.";
      args[args.length - 1] = async function (input: any, extra: any) {
        const extension = path.extname(String(input?.path ?? "")).toLowerCase();
        if (!OFFICE_EXTENSIONS.has(extension)) return originalHandler.call(this, input, extra);
        const result = await readOfficeViaFsRead(input);
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      };
    }
    return originalTool.apply(this, args);
  };
}
