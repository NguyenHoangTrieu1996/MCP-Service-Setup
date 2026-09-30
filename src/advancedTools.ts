import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const MAX_INLINE_BINARY_BYTES = 8 * 1024 * 1024;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_CREATE_BINARY_BYTES = 20 * 1024 * 1024;
const MAX_OFFICE_BYTES = 100 * 1024 * 1024;

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".bmp": "image/bmp",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".mkv": "video/x-matroska",
  ".avi": "video/x-msvideo",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".psd": "image/vnd.adobe.photoshop",
  ".ai": "application/postscript",
  ".zip": "application/zip"
};

function mimeFor(filePath: string): string {
  return MIME_BY_EXT[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

function imageResult(data: Buffer, mimeType: string) {
  return {
    content: [
      {
        type: "image" as const,
        data: data.toString("base64"),
        mimeType
      }
    ]
  };
}

function textResult(text: string) {
  return {
    content: [
      {
        type: "text" as const,
        text
      }
    ]
  };
}

async function commandExists(command: string): Promise<boolean> {
  try {
    await execFileAsync("where.exe", [command], { windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

async function runPowerShell(script: string, args: string[] = []) {
  return execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script, ...args],
    { windowsHide: true, maxBuffer: 32 * 1024 * 1024 }
  );
}

export type AdvancedToolContext = {
  root: string;
  securePath: (input?: string) => Promise<string>;
  ensureInsideRoot: (target: string) => Promise<void>;
  ensureNotRoot: (target: string) => void;
  relativeDisplay: (target: string) => string;
  audit: (action: string, target: string, status: string, details?: unknown) => Promise<void>;
};

export function registerAdvancedTools(server: McpServer, ctx: AdvancedToolContext): void {
  const { root, securePath, ensureInsideRoot, ensureNotRoot, relativeDisplay, audit } = ctx;

  server.tool(
    "fs_stat",
    "Return metadata for a file or directory inside the allowed root.",
    { path: z.string().default("") },
    async ({ path: input }) => {
      const target = await securePath(input);
      const stat = await fs.stat(target);
      const result = {
        path: relativeDisplay(target),
        type: stat.isDirectory() ? "directory" : stat.isFile() ? "file" : "other",
        size: stat.size,
        mimeType: stat.isFile() ? mimeFor(target) : undefined,
        createdAt: stat.birthtime.toISOString(),
        modifiedAt: stat.mtime.toISOString()
      };
      await audit("STAT", relativeDisplay(target), "SUCCESS", result);
      return textResult(JSON.stringify(result, null, 2));
    }
  );

  server.tool(
    "fs_read_binary",
    "Read a small binary file as base64. Use this for files up to 8 MB; use specialized preview/extraction tools for larger media/design files.",
    { path: z.string().min(1) },
    async ({ path: input }) => {
      const target = await securePath(input);
      const stat = await fs.stat(target);
      if (!stat.isFile()) throw new Error("Target is not a file");
      if (stat.size > MAX_INLINE_BINARY_BYTES) {
        throw new Error(`Binary file is too large for inline base64 (${stat.size} bytes). Maximum is ${MAX_INLINE_BINARY_BYTES} bytes.`);
      }
      const data = await fs.readFile(target);
      await audit("READ_BINARY", relativeDisplay(target), "SUCCESS", { size: stat.size, mimeType: mimeFor(target) });
      return textResult(JSON.stringify({
        path: relativeDisplay(target),
        size: stat.size,
        mimeType: mimeFor(target),
        encoding: "base64",
        data: data.toString("base64")
      }));
    }
  );

  server.tool(
    "fs_create_binary",
    "Create a NEW binary file from base64 inside the allowed root. Existing files are never overwritten. Maximum decoded size is 20 MB.",
    {
      path: z.string().min(1),
      data_base64: z.string().min(1)
    },
    async ({ path: input, data_base64 }) => {
      const target = await securePath(input);
      ensureNotRoot(target);
      const parent = path.dirname(target);
      await ensureInsideRoot(parent);
      const data = Buffer.from(data_base64, "base64");
      if (data.length > MAX_CREATE_BINARY_BYTES) {
        throw new Error(`Decoded binary is too large. Maximum is ${MAX_CREATE_BINARY_BYTES} bytes.`);
      }
      await fs.mkdir(parent, { recursive: true });
      try {
        await fs.writeFile(target, data, { flag: "wx" });
      } catch (err: any) {
        if (err?.code === "EEXIST") throw new Error("File already exists. Binary overwrite is intentionally blocked.");
        throw err;
      }
      await audit("CREATE_BINARY", relativeDisplay(target), "SUCCESS", { size: data.length, mimeType: mimeFor(target) });
      return textResult(`Created binary file: ${relativeDisplay(target)} (${data.length} bytes)`);
    }
  );

  server.tool(
    "image_read",
    "Read an image and return it as native MCP image content so vision-capable clients can inspect it directly.",
    { path: z.string().min(1) },
    async ({ path: input }) => {
      const target = await securePath(input);
      const stat = await fs.stat(target);
      if (!stat.isFile()) throw new Error("Target is not a file");
      const mimeType = mimeFor(target);
      if (!mimeType.startsWith("image/") || mimeType === "image/vnd.adobe.photoshop") {
        throw new Error("Unsupported direct image format. Use file_preview for PSD/AI/PDF/video.");
      }
      if (stat.size > MAX_IMAGE_BYTES) throw new Error(`Image is too large. Maximum is ${MAX_IMAGE_BYTES} bytes.`);
      const data = await fs.readFile(target);
      await audit("READ_IMAGE", relativeDisplay(target), "SUCCESS", { size: stat.size, mimeType });
      return imageResult(data, mimeType);
    }
  );

  server.tool(
    "video_probe",
    "Inspect video/audio metadata using ffprobe. Requires FFmpeg/ffprobe installed and available in PATH.",
    { path: z.string().min(1) },
    async ({ path: input }) => {
      const target = await securePath(input);
      if (!(await commandExists("ffprobe"))) throw new Error("ffprobe is not installed or not available in PATH");
      const { stdout } = await execFileAsync(
        "ffprobe",
        ["-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", target],
        { windowsHide: true, maxBuffer: 16 * 1024 * 1024 }
      );
      await audit("VIDEO_PROBE", relativeDisplay(target), "SUCCESS");
      return textResult(stdout);
    }
  );

  server.tool(
    "video_extract_frame",
    "Extract one frame from a video and return it as MCP image content. Requires FFmpeg installed and available in PATH.",
    {
      path: z.string().min(1),
      timestamp_seconds: z.number().min(0).default(0)
    },
    async ({ path: input, timestamp_seconds }) => {
      const target = await securePath(input);
      if (!(await commandExists("ffmpeg"))) throw new Error("ffmpeg is not installed or not available in PATH");
      const output = path.join(os.tmpdir(), `mcp-frame-${Date.now()}-${Math.random().toString(16).slice(2)}.jpg`);
      try {
        await execFileAsync(
          "ffmpeg",
          ["-hide_banner", "-loglevel", "error", "-ss", String(timestamp_seconds), "-i", target, "-frames:v", "1", "-q:v", "2", "-y", output],
          { windowsHide: true, maxBuffer: 8 * 1024 * 1024 }
        );
        const data = await fs.readFile(output);
        await audit("VIDEO_FRAME", relativeDisplay(target), "SUCCESS", { timestamp_seconds });
        return imageResult(data, "image/jpeg");
      } finally {
        await fs.rm(output, { force: true }).catch(() => undefined);
      }
    }
  );

  server.tool(
    "office_extract_text",
    "Extract readable text from DOCX or basic cell values from XLSX using Windows PowerShell/.NET without modifying the source file.",
    { path: z.string().min(1) },
    async ({ path: input }) => {
      const target = await securePath(input);
      const stat = await fs.stat(target);
      if (!stat.isFile()) throw new Error("Target is not a file");
      if (stat.size > MAX_OFFICE_BYTES) throw new Error(`Office file is too large. Maximum is ${MAX_OFFICE_BYTES} bytes.`);
      const ext = path.extname(target).toLowerCase();
      if (ext !== ".docx" && ext !== ".xlsx") throw new Error("Only .docx and .xlsx are supported by office_extract_text");

      const ps = ext === ".docx"
        ? String.raw`param($p)
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip=[IO.Compression.ZipFile]::OpenRead($p)
try {
  $entry=$zip.GetEntry('word/document.xml')
  if(-not $entry){ throw 'word/document.xml not found' }
  $sr=New-Object IO.StreamReader($entry.Open())
  try { $xml=[xml]$sr.ReadToEnd() } finally { $sr.Dispose() }
  $ns=New-Object Xml.XmlNamespaceManager($xml.NameTable)
  $ns.AddNamespace('w','http://schemas.openxmlformats.org/wordprocessingml/2006/main')
  $paras=$xml.SelectNodes('//w:p',$ns)
  foreach($para in $paras){
    $texts=$para.SelectNodes('.//w:t',$ns) | ForEach-Object { $_.'#text' }
    if($texts){ ($texts -join '') }
  }
} finally { $zip.Dispose() }`
        : String.raw`param($p)
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip=[IO.Compression.ZipFile]::OpenRead($p)
try {
  $shared=@()
  $ss=$zip.GetEntry('xl/sharedStrings.xml')
  if($ss){
    $sr=New-Object IO.StreamReader($ss.Open())
    try { $x=[xml]$sr.ReadToEnd() } finally { $sr.Dispose() }
    $shared=@($x.sst.si | ForEach-Object {
      if($_.t){ [string]$_.t }
      elseif($_.r){ (($_.r | ForEach-Object { [string]$_.t }) -join '') }
      else { '' }
    })
  }
  $sheets=$zip.Entries | Where-Object { $_.FullName -match '^xl/worksheets/sheet[0-9]+\.xml$' } | Sort-Object FullName
  foreach($entry in $sheets){
    "### $($entry.FullName)"
    $sr=New-Object IO.StreamReader($entry.Open())
    try { $x=[xml]$sr.ReadToEnd() } finally { $sr.Dispose() }
    foreach($row in $x.worksheet.sheetData.row){
      $vals=@()
      foreach($c in $row.c){
        $v=[string]$c.v
        if($c.t -eq 's' -and $v -match '^\d+$'){ $v=$shared[[int]$v] }
        elseif($c.t -eq 'inlineStr'){ $v=[string]$c.is.t }
        $vals += $v
      }
      ($vals -join "`t")
    }
  }
} finally { $zip.Dispose() }`;

      const { stdout } = await runPowerShell(ps, [target]);
      await audit("OFFICE_EXTRACT", relativeDisplay(target), "SUCCESS", { extension: ext });
      return textResult(stdout.trim());
    }
  );

  server.tool(
    "file_preview",
    "Render a visual preview for PDF, PSD, AI, common images, or a video frame. Uses ImageMagick/pdftoppm/FFmpeg when required and available in PATH.",
    {
      path: z.string().min(1),
      page: z.number().int().min(1).default(1),
      timestamp_seconds: z.number().min(0).default(0)
    },
    async ({ path: input, page, timestamp_seconds }) => {
      const target = await securePath(input);
      const ext = path.extname(target).toLowerCase();
      const directMime = mimeFor(target);

      if ([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"].includes(ext)) {
        const data = await fs.readFile(target);
        if (data.length > MAX_IMAGE_BYTES) throw new Error(`Image is too large. Maximum is ${MAX_IMAGE_BYTES} bytes.`);
        return imageResult(data, directMime);
      }

      if ([".mp4", ".mov", ".mkv", ".avi"].includes(ext)) {
        if (!(await commandExists("ffmpeg"))) throw new Error("ffmpeg is required to preview video files");
        const output = path.join(os.tmpdir(), `mcp-preview-${Date.now()}.jpg`);
        try {
          await execFileAsync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-ss", String(timestamp_seconds), "-i", target, "-frames:v", "1", "-q:v", "2", "-y", output], { windowsHide: true });
          const data = await fs.readFile(output);
          await audit("FILE_PREVIEW", relativeDisplay(target), "SUCCESS", { type: "video", timestamp_seconds });
          return imageResult(data, "image/jpeg");
        } finally {
          await fs.rm(output, { force: true }).catch(() => undefined);
        }
      }

      const output = path.join(os.tmpdir(), `mcp-preview-${Date.now()}-${Math.random().toString(16).slice(2)}.png`);
      try {
        if (ext === ".pdf" && (await commandExists("pdftoppm"))) {
          const prefix = output.replace(/\.png$/i, "");
          await execFileAsync("pdftoppm", ["-f", String(page), "-singlefile", "-png", "-r", "150", target, prefix], { windowsHide: true });
        } else if (await commandExists("magick")) {
          const source = ext === ".pdf" || ext === ".psd" ? `${target}[${Math.max(0, page - 1)}]` : target;
          await execFileAsync("magick", [source, "-thumbnail", "2000x2000>", output], { windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
        } else {
          throw new Error("No compatible preview converter found. Install ImageMagick (magick), Poppler (pdftoppm), or FFmpeg depending on the file type.");
        }
        const data = await fs.readFile(output);
        await audit("FILE_PREVIEW", relativeDisplay(target), "SUCCESS", { page });
        return imageResult(data, "image/png");
      } finally {
        await fs.rm(output, { force: true }).catch(() => undefined);
      }
    }
  );
}
