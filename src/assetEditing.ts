import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(process.env.MCP_ROOT || "C:\\Users\\ADMIN\\Documents\\For Works");
const LOG_DIR = path.resolve(process.env.MCP_LOG_DIR || "C:\\MCP-Gateway\\logs");
const CONFIRM_TTL_MS = 10 * 60 * 1000;

const READ = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
const CREATE = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
const EXTERNAL = { readOnlyHint: false, destructiveHint: false, openWorldHint: true };

const IMAGE_INPUTS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".tif", ".tiff"]);
const DESIGN_INPUTS = new Set([".psd", ".psb", ".pdf", ".ai", ".svg", ...IMAGE_INPUTS]);
const IMAGE_OUTPUTS = new Set([".png", ".jpg", ".jpeg", ".webp", ".tif", ".tiff"]);

type PendingExternal = {
  expiresAt: number;
  service: string;
  source: string;
  purpose: string;
};
const externalApprovals = new Map<string, PendingExternal>();

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function jsonResult(value: unknown) {
  return textResult(JSON.stringify(value, null, 2));
}

function display(target: string) {
  return path.relative(ROOT, target) || ".";
}

function assertInsideRoot(target: string) {
  const relative = path.relative(ROOT, target);
  if (relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) {
    throw new Error("Path escapes the configured MCP root");
  }
}

async function secureExistingFile(input: string) {
  const target = path.resolve(ROOT, input || ".");
  assertInsideRoot(target);
  const stat = await fs.lstat(target);
  if (stat.isSymbolicLink()) throw new Error("Symbolic links are not allowed");
  if (!stat.isFile()) throw new Error("Target is not a regular file");
  const real = await fs.realpath(target);
  assertInsideRoot(real);
  return real;
}

async function secureNewFile(input: string) {
  if (!input?.trim()) throw new Error("output_path is required");
  const target = path.resolve(ROOT, input);
  assertInsideRoot(target);
  if (target === ROOT) throw new Error("Output cannot be the MCP root");
  const parent = path.dirname(target);
  await fs.mkdir(parent, { recursive: true });
  const parentReal = await fs.realpath(parent);
  assertInsideRoot(parentReal);
  try {
    await fs.lstat(target);
    throw new Error("Output already exists. Asset editing is create-only; choose a new filename.");
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
  }
  return target;
}

async function audit(action: string, target: string, status: string, details?: unknown) {
  await fs.mkdir(LOG_DIR, { recursive: true });
  const record = JSON.stringify({ timestamp: new Date().toISOString(), action, target, status, details }) + os.EOL;
  await fs.appendFile(path.join(LOG_DIR, "audit.jsonl"), record, "utf8");
}

function executable(name: string) {
  return process.env[`MCP_${name.toUpperCase()}_PATH`] || name;
}

async function commandExists(name: string) {
  try {
    const command = executable(name);
    if (path.isAbsolute(command)) {
      await fs.access(command);
      return true;
    }
    await execFileAsync("where.exe", [command], { windowsHide: true, timeout: 5000, maxBuffer: 64 * 1024 });
    return true;
  } catch {
    return false;
  }
}

async function run(name: string, args: string[], timeout = 120_000) {
  if (!(await commandExists(name))) {
    throw new Error(`${name} is not installed. Install it or set MCP_${name.toUpperCase()}_PATH, then restart the gateway.`);
  }
  return execFileAsync(executable(name), args, { windowsHide: true, timeout, maxBuffer: 4 * 1024 * 1024, encoding: "utf8" });
}

function requireExtension(target: string, allowed: Set<string>, label: string) {
  const extension = path.extname(target).toLowerCase();
  if (!allowed.has(extension)) throw new Error(`${label} format is not supported: ${extension || "(none)"}`);
}

function imageArgs(input: string, output: string, options: {
  width?: number;
  height?: number;
  fit?: "contain" | "cover" | "stretch";
  rotate?: number;
  crop?: string;
  quality?: number;
  strip_metadata?: boolean;
}) {
  const args = [input];
  if (options.crop) args.push("-crop", options.crop, "+repage");
  if (options.rotate !== undefined && options.rotate !== 0) args.push("-rotate", String(options.rotate));
  if (options.width || options.height) {
    const w = options.width ? String(options.width) : "";
    const h = options.height ? String(options.height) : "";
    const modifier = options.fit === "cover" ? "^" : options.fit === "stretch" ? "!" : "";
    args.push("-resize", `${w}x${h}${modifier}`);
    if (options.fit === "cover" && options.width && options.height) {
      args.push("-gravity", "center", "-extent", `${options.width}x${options.height}`);
    }
  }
  if (options.quality !== undefined) args.push("-quality", String(options.quality));
  if (options.strip_metadata) args.push("-strip");
  args.push(output);
  return args;
}

export function registerAssetEditingTools(server: McpServer): void {
  server.tool(
    "asset_edit_capabilities",
    "Report local image/design editing engines and external-service workflow support. Read-only.",
    {}, READ,
    async () => {
      const converters = {
        magick: await commandExists("magick"),
        ffmpeg: await commandExists("ffmpeg"),
        ffprobe: await commandExists("ffprobe"),
        powershell: await commandExists("powershell")
      };
      return jsonResult({
        root: ROOT,
        converters,
        local_editing: {
          image_transform: converters.magick,
          image_composite: converters.magick,
          design_export_preview: converters.magick,
          video_processing: converters.ffmpeg
        },
        external_services: {
          supported_flow: ["figma", "canva", "openai-image", "other"],
          policy: "Sending a source asset outside the PC requires explicit external_asset_approve first. Returned files must be imported as NEW files; existing originals are never overwritten by this pipeline."
        },
        original_file_policy: "create-new by default; no overwrite"
      });
    }
  );

  server.tool(
    "image_transform",
    "Create a NEW transformed raster image with ImageMagick. Supports resize, crop, rotate, quality and metadata stripping. Never overwrites existing files.",
    {
      input_path: z.string().min(1),
      output_path: z.string().min(1),
      width: z.number().int().positive().max(30000).optional(),
      height: z.number().int().positive().max(30000).optional(),
      fit: z.enum(["contain", "cover", "stretch"]).default("contain"),
      rotate: z.number().min(-360).max(360).optional(),
      crop: z.string().regex(/^\d+x\d+\+\d+\+\d+$/).optional(),
      quality: z.number().int().min(1).max(100).optional(),
      strip_metadata: z.boolean().default(false)
    }, CREATE,
    async ({ input_path, output_path, width, height, fit, rotate, crop, quality, strip_metadata }) => {
      const input = await secureExistingFile(input_path);
      requireExtension(input, IMAGE_INPUTS, "Input image");
      const output = await secureNewFile(output_path);
      requireExtension(output, IMAGE_OUTPUTS, "Output image");
      try {
        await run("magick", imageArgs(input, output, { width, height, fit, rotate, crop, quality, strip_metadata }));
        const stat = await fs.stat(output);
        await audit("IMAGE_TRANSFORM", `${display(input)} -> ${display(output)}`, "SUCCESS", { width, height, fit, rotate, crop, quality, strip_metadata, size: stat.size });
        return jsonResult({ created: display(output), bytes: stat.size, original_unchanged: true });
      } catch (error) {
        await fs.rm(output, { force: true }).catch(() => undefined);
        throw error;
      }
    }
  );

  server.tool(
    "image_composite",
    "Create a NEW image by compositing an overlay/logo/image over a base image with ImageMagick. Never overwrites existing files.",
    {
      base_path: z.string().min(1),
      overlay_path: z.string().min(1),
      output_path: z.string().min(1),
      gravity: z.enum(["center", "north", "south", "east", "west", "northeast", "northwest", "southeast", "southwest"]).default("center"),
      offset_x: z.number().int().min(-30000).max(30000).default(0),
      offset_y: z.number().int().min(-30000).max(30000).default(0),
      overlay_width: z.number().int().positive().max(30000).optional(),
      overlay_height: z.number().int().positive().max(30000).optional()
    }, CREATE,
    async ({ base_path, overlay_path, output_path, gravity, offset_x, offset_y, overlay_width, overlay_height }) => {
      const base = await secureExistingFile(base_path);
      const overlay = await secureExistingFile(overlay_path);
      requireExtension(base, IMAGE_INPUTS, "Base image");
      requireExtension(overlay, IMAGE_INPUTS, "Overlay image");
      const output = await secureNewFile(output_path);
      requireExtension(output, IMAGE_OUTPUTS, "Output image");
      const resizedOverlay = overlay_width || overlay_height ? path.join(os.tmpdir(), `mcp-overlay-${randomUUID()}.png`) : overlay;
      try {
        if (resizedOverlay !== overlay) {
          const w = overlay_width ? String(overlay_width) : "";
          const h = overlay_height ? String(overlay_height) : "";
          await run("magick", [overlay, "-resize", `${w}x${h}`, resizedOverlay]);
        }
        await run("magick", [base, resizedOverlay, "-gravity", gravity, "-geometry", `${offset_x >= 0 ? "+" : ""}${offset_x}${offset_y >= 0 ? "+" : ""}${offset_y}`, "-composite", output]);
        const stat = await fs.stat(output);
        await audit("IMAGE_COMPOSITE", `${display(base)} + ${display(overlay)} -> ${display(output)}`, "SUCCESS", { gravity, offset_x, offset_y, overlay_width, overlay_height, size: stat.size });
        return jsonResult({ created: display(output), bytes: stat.size, original_unchanged: true });
      } catch (error) {
        await fs.rm(output, { force: true }).catch(() => undefined);
        throw error;
      } finally {
        if (resizedOverlay !== overlay) await fs.rm(resizedOverlay, { force: true }).catch(() => undefined);
      }
    }
  );

  server.tool(
    "design_export_preview",
    "Render a supported image/design file to a NEW PNG/JPEG preview with ImageMagick. Useful for PSD/PSB/PDF/AI/SVG when local delegates support the format. Never overwrites.",
    {
      input_path: z.string().min(1),
      output_path: z.string().min(1),
      page_or_layer: z.number().int().nonnegative().default(0),
      max_width: z.number().int().positive().max(12000).default(2400)
    }, CREATE,
    async ({ input_path, output_path, page_or_layer, max_width }) => {
      const input = await secureExistingFile(input_path);
      requireExtension(input, DESIGN_INPUTS, "Design input");
      const output = await secureNewFile(output_path);
      requireExtension(output, new Set([".png", ".jpg", ".jpeg"]), "Preview output");
      const source = [".psd", ".psb", ".pdf", ".ai"].includes(path.extname(input).toLowerCase()) ? `${input}[${page_or_layer}]` : input;
      try {
        await run("magick", [source, "-background", "white", "-alpha", "remove", "-alpha", "off", "-resize", `${max_width}x>`, output]);
        const stat = await fs.stat(output);
        await audit("DESIGN_PREVIEW_EXPORT", `${display(input)} -> ${display(output)}`, "SUCCESS", { page_or_layer, max_width, size: stat.size });
        return jsonResult({ created: display(output), bytes: stat.size, original_unchanged: true, note: "Preview is a rendered derivative, not an editable reconstruction of proprietary layers." });
      } catch (error) {
        await fs.rm(output, { force: true }).catch(() => undefined);
        throw error;
      }
    }
  );

  server.tool(
    "external_asset_request",
    "Request explicit approval before a local source asset may be sent to an external editing service such as Figma, Canva or an image AI. This tool does not upload anything by itself.",
    {
      path: z.string().min(1),
      service: z.enum(["figma", "canva", "openai-image", "other"]),
      purpose: z.string().min(1).max(1000)
    }, EXTERNAL,
    async ({ path: input, service, purpose }) => {
      const source = await secureExistingFile(input);
      const approval_id = randomUUID();
      externalApprovals.set(approval_id, { expiresAt: Date.now() + CONFIRM_TTL_MS, service, source, purpose });
      await audit("EXTERNAL_ASSET_REQUEST", display(source), "PENDING", { approval_id, service, purpose });
      return jsonResult({
        approval_id,
        expires_in_seconds: CONFIRM_TTL_MS / 1000,
        source: display(source),
        service,
        purpose,
        warning: "Approval allows this asset to leave the local PC boundary. Nothing has been uploaded yet.",
        next_tool: "external_asset_approve"
      });
    }
  );

  server.tool(
    "external_asset_approve",
    "Approve or reject one pending external asset transfer request. Approval returns an authorization receipt for the ChatGPT connector/plugin workflow; this MCP still does not upload automatically.",
    { approval_id: z.string().uuid(), approve: z.boolean() }, EXTERNAL,
    async ({ approval_id, approve }) => {
      const pending = externalApprovals.get(approval_id);
      externalApprovals.delete(approval_id);
      if (!pending || pending.expiresAt < Date.now()) throw new Error("External approval expired or invalid");
      if (!approve) {
        await audit("EXTERNAL_ASSET_APPROVAL", display(pending.source), "REJECTED", { approval_id, service: pending.service });
        return textResult("External transfer cancelled.");
      }
      const receipt = randomUUID();
      await audit("EXTERNAL_ASSET_APPROVAL", display(pending.source), "APPROVED", { approval_id, receipt, service: pending.service, purpose: pending.purpose });
      return jsonResult({
        authorized: true,
        receipt,
        service: pending.service,
        source: display(pending.source),
        purpose: pending.purpose,
        instructions: "Use the selected ChatGPT connector/plugin to perform the external edit. When a binary result is returned, store it under a NEW filename using fs_create_binary. Do not overwrite the original."
      });
    }
  );
}
