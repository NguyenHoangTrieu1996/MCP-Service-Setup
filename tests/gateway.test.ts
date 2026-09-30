import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
type ToolResult = { content: Array<{ type: string; text?: string }>; isError?: boolean };

async function vacantPort(): Promise<number> {
  const reservation = net.createServer();
  await new Promise<void>((resolve, reject) => {
    reservation.once("error", reject);
    reservation.listen(0, "127.0.0.1", resolve);
  });
  const address = reservation.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()));
  return port;
}

async function cleanupFixture(fixture: string): Promise<void> {
  const temporaryRoot = await fs.realpath(os.tmpdir());
  const resolved = await fs.realpath(fixture);
  const relative = path.relative(temporaryRoot, resolved);
  assert.ok(
    relative !== "" && !relative.includes(path.sep) && !path.isAbsolute(relative) &&
    relative.startsWith("mcp-gateway-integration-"),
    "recursive cleanup is restricted to this test's resolved temporary subtree"
  );
  await fs.rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

test("gateway HTTP/MCP integration in an isolated temporary root", { timeout: 120_000 }, async t => {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-gateway-integration-"));
  const root = path.join(fixture, "allowed");
  const logDir = path.join(fixture, "logs");
  const backupDir = path.join(fixture, "backups");
  await Promise.all([root, logDir, backupDir].map(dir => fs.mkdir(dir)));
  let child: ChildProcess | undefined;
  let childExited: Promise<void> | undefined;
  let output = "";
  let startupError: Error | undefined;
  try {
    const port = await vacantPort();
    const endpoint = "http://127.0.0.1:" + port;
    const converterOverrides = Object.fromEntries(
      ["ffmpeg", "ffprobe", "magick", "pdftotext", "pdfinfo", "pdftoppm", "exiftool"].map(name =>
        ["MCP_" + name.toUpperCase() + "_PATH", path.join(fixture, "missing-" + name + ".exe")])
    );
    child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
      cwd: projectRoot,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...converterOverrides, MCP_ROOT: root, MCP_LOG_DIR: logDir, MCP_BACKUP_DIR: backupDir, MCP_PORT: String(port) }
    });
    childExited = new Promise(resolve => child!.once("exit", () => resolve()));
    child.on("error", error => { startupError = error; });
    child.stdout?.on("data", chunk => { output = (output + chunk.toString()).slice(-16_384); });
    child.stderr?.on("data", chunk => { output = (output + chunk.toString()).slice(-16_384); });
    const deadline = Date.now() + 30_000;
    let health: any;
    while (Date.now() < deadline) {
      if (startupError) throw startupError;
      if (child.exitCode !== null || child.signalCode !== null) throw new Error("Gateway exited during startup:\n" + output);
      try {
        const response = await fetch(endpoint + "/health", { signal: AbortSignal.timeout(1500) });
        if (response.ok) { health = await response.json(); break; }
      } catch { /* gateway may still be loading TypeScript */ }
      await delay(100);
    }
    assert.ok(health, "gateway health becomes ready:\n" + output);
    assert.equal(health.root, root);
    let requestId = 0;
    async function rpc(method: string, params: Record<string, unknown> = {}): Promise<any> {
      const response = await fetch(endpoint + "/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-06-18" },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++requestId, method, params }),
        signal: AbortSignal.timeout(20_000)
      });
      const body = await response.text();
      assert.equal(response.status, 200, method + ": " + body);
      const decoded = JSON.parse(body);
      assert.equal(decoded.error, undefined, JSON.stringify(decoded.error));
      return decoded.result;
    }
    async function rawTool(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
      return rpc("tools/call", { name, arguments: args });
    }
    function resultText(result: ToolResult): string {
      return result.content.filter(part => part.type === "text").map(part => part.text ?? "").join("\n");
    }
    async function callText(name: string, args: Record<string, unknown> = {}): Promise<string> {
      const result = await rawTool(name, args);
      assert.notEqual(result.isError, true, name + ": " + resultText(result));
      return resultText(result);
    }
    async function callJson(name: string, args: Record<string, unknown> = {}): Promise<any> {
      return JSON.parse(await callText(name, args));
    }
    async function expectToolError(name: string, args: Record<string, unknown>, pattern: RegExp) {
      const result = await rawTool(name, args);
      assert.equal(result.isError, true, name + " should reject the request");
      assert.match(resultText(result), pattern);
    }
    async function backupFor(name: string): Promise<Buffer[]> {
      const names = (await fs.readdir(backupDir)).filter(entry => entry.endsWith("-" + name));
      return Promise.all(names.map(entry => fs.readFile(path.join(backupDir, entry))));
    }

    await t.test("MCP discovery includes the new read, analysis and confirmation tools", async () => {
      const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "gateway-integration-test", version: "1.0.0" } });
      assert.equal(init.serverInfo.name, "windows-filesystem-gateway");
      const listed = await rpc("tools/list");
      const names = new Set(listed.tools.map((tool: any) => tool.name));
      for (const name of ["fs_read", "fs_read_binary", "fs_search", "fs_list", "fs_edit_binary", "fs_confirm", "fs_capabilities", "file_analyze", "office_extract_text", "model_inspect"]) {
        assert.ok(names.has(name), name + " is registered");
      }
    });

    await t.test("new text, directories and binary files are created immediately without confirmation", async () => {
      assert.match(await callText("fs_create_directory", { path: "created" }), /Created directory/);
      assert.match(await callText("fs_create_file", { path: "created/note.txt", content: "original tiếng Việt 😀" }), /Created:/);
      assert.equal(await fs.readFile(path.join(root, "created", "note.txt"), "utf8"), "original tiếng Việt 😀");
      const bytes = Buffer.from([0, 1, 128, 255, 42]);
      const created = await callJson("fs_create_binary", { path: "created/data.bin", data_base64: bytes.toString("base64") });
      assert.equal(created.confirmation_required, undefined);
      assert.deepEqual(await fs.readFile(path.join(root, "created", "data.bin")), bytes);
      await expectToolError("fs_create_file", { path: "created/note.txt", content: "overwrite" }, /already exists/i);
      assert.equal(await fs.readFile(path.join(root, "created", "note.txt"), "utf8"), "original tiếng Việt 😀");
    });

    await t.test("text larger than the former 10 MiB limit is reconstructed exactly through HTTP byte pages", async () => {
      const line = "Nội dung đầy đủ 😀漢字\n";
      const text = line.repeat(Math.ceil(11 * 1024 * 1024 / Buffer.byteLength(line)));
      const target = path.join(root, "large.txt");
      await fs.writeFile(target, text);
      assert.ok((await fs.stat(target)).size > 10 * 1024 * 1024);
      const parts: string[] = [];
      let offset = 0;
      let expectedVersion: string | undefined;
      for (let pageNumber = 0; pageNumber < 100; pageNumber++) {
        const part = await callJson("fs_read", { path: "large.txt", offset, length: 1024 * 1024, expected_version: expectedVersion });
        assert.equal(part.offset, offset);
        parts.push(part.text);
        expectedVersion = part.version;
        if (part.eof) { assert.equal(part.next_offset, part.size); break; }
        assert.ok(part.next_offset > offset);
        offset = part.next_offset;
        assert.ok(pageNumber < 99, "pagination terminates");
      }
      assert.equal(parts.join(""), text);
    });

    await t.test("directory listing and name search exceed 500 total matches without omission", async () => {
      const batch = path.join(root, "many");
      await fs.mkdir(batch);
      await Promise.all(Array.from({ length: 610 }, (_, index) => fs.writeFile(path.join(batch, "entry-" + index + ".txt"), "")));
      for (const tool of ["fs_list", "fs_search"]) {
        const names = new Set<string>();
        let cursor: string | undefined;
        for (let pageNumber = 0; pageNumber < 100; pageNumber++) {
          const page = await callJson(tool, { path: "many", ...(tool === "fs_search" ? { query: "entry-" } : {}), limit: 87, cursor });
          for (const entry of page.entries) {
            assert.equal(names.has(entry.path), false);
            names.add(entry.path);
          }
          if (page.complete) { assert.equal(page.next_cursor, null); break; }
          assert.ok(page.next_cursor);
          cursor = page.next_cursor;
          assert.ok(pageNumber < 99, "pagination terminates");
        }
        assert.equal(names.size, 610);
      }
    });

    await t.test("text edits wait for fs_confirm, support cancellation and retain backups", async () => {
      const target = path.join(root, "created", "note.txt");
      const original = await fs.readFile(target, "utf8");
      const rejected = await callJson("fs_edit_file", { path: "created/note.txt", content: "must not be written" });
      assert.equal(rejected.confirmation_required, true);
      assert.equal(await fs.readFile(target, "utf8"), original);
      await callText("fs_confirm", { confirmation_id: rejected.confirmation_id, approve: false });
      assert.equal(await fs.readFile(target, "utf8"), original);
      assert.equal((await backupFor("note.txt")).length, 0);
      const accepted = await callJson("fs_edit_file", { path: "created/note.txt", content: "approved edit" });
      assert.equal(await fs.readFile(target, "utf8"), original);
      await callText("fs_confirm", { confirmation_id: accepted.confirmation_id, approve: true });
      assert.equal(await fs.readFile(target, "utf8"), "approved edit");
      assert.ok((await backupFor("note.txt")).some(bytes => bytes.toString("utf8") === original));
      await expectToolError("fs_confirm", { confirmation_id: accepted.confirmation_id, approve: true }, /expired or invalid/);

      const stale = await callJson("fs_edit_file", { path: "created/note.txt", content: "stale proposed edit" });
      await fs.writeFile(target, "another application changed this file");
      await expectToolError("fs_confirm", { confirmation_id: stale.confirmation_id, approve: true }, /changed since edit request/i);
      assert.equal(await fs.readFile(target, "utf8"), "another application changed this file");
    });

    await t.test("binary files reject text edits and binary replacement requires confirmation", async () => {
      const target = path.join(root, "created", "data.bin");
      const original = await fs.readFile(target);
      await expectToolError("fs_edit_file", { path: "created/data.bin", content: "corruption" }, /Binary|format|UTF-8/i);
      const replacement = Buffer.from([255, 0, 30, 127, 128, 70, 99]);
      const pending = await callJson("fs_edit_binary", { path: "created/data.bin", data_base64: replacement.toString("base64") });
      assert.equal(pending.confirmation_required, true);
      assert.deepEqual(await fs.readFile(target), original);
      await callText("fs_confirm", { confirmation_id: pending.confirmation_id, approve: true });
      assert.deepEqual(await fs.readFile(target), replacement);
      assert.ok((await backupFor("data.bin")).some(bytes => bytes.equals(original)));
      const first = await callJson("fs_read_binary", { path: "created/data.bin", offset: 0, length: 4 });
      const second = await callJson("fs_read_binary", { path: "created/data.bin", offset: first.next_offset, length: 4, expected_version: first.version });
      assert.deepEqual(Buffer.concat([Buffer.from(first.data_base64, "base64"), Buffer.from(second.data_base64, "base64")]), replacement);
      assert.equal(second.eof, true);
      await expectToolError("fs_create_binary", { path: "bad.bin", data_base64: "not canonical!!" }, /base64/i);
      await assert.rejects(fs.stat(path.join(root, "bad.bin")), { code: "ENOENT" });
    });

    await t.test("deletion waits for confirmation and backs up content before removal", async () => {
      const target = path.join(root, "delete-me.txt");
      await callText("fs_create_file", { path: "delete-me.txt", content: "recoverable deletion" });
      const pending = await callJson("fs_delete", { path: "delete-me.txt" });
      assert.equal(pending.confirmation_required, true);
      assert.equal(await fs.readFile(target, "utf8"), "recoverable deletion");
      await callText("fs_confirm", { confirmation_id: pending.confirmation_id, approve: true });
      await assert.rejects(fs.stat(target), { code: "ENOENT" });
      assert.ok((await backupFor("delete-me.txt")).some(bytes => bytes.toString("utf8") === "recoverable deletion"));
    });

    await t.test("root protection, traversal and alternate data stream aliases are enforced", async () => {
      await fs.writeFile(path.join(fixture, "outside.txt"), "outside sentinel");
      await expectToolError("fs_read", { path: "../outside.txt" }, /outside|escapes/i);
      await expectToolError("fs_create_file", { path: "../escaped.txt", content: "escape" }, /outside|escapes/i);
      await expectToolError("fs_delete", { path: "." }, /root directory/i);
      if (process.platform === "win32") {
        const alternateCase = root.split("").map(letter => letter === letter.toLowerCase() ? letter.toUpperCase() : letter.toLowerCase()).join("");
        await expectToolError("fs_delete", { path: alternateCase }, /root directory/i);
        await expectToolError("fs_create_file", { path: "created/note.txt:stream", content: "ADS" }, /Alternate data streams/i);
        await expectToolError("fs_create_file", { path: "NUL.txt", content: "reserved" }, /reserved/i);
        await expectToolError("fs_create_file", { path: "name.txt.", content: "alias" }, /Invalid/i);
      }
      assert.equal(await fs.readFile(path.join(fixture, "outside.txt"), "utf8"), "outside sentinel");
      await assert.rejects(fs.stat(path.join(fixture, "escaped.txt")), { code: "ENOENT" });
      assert.ok((await fs.stat(root)).isDirectory());
    });

    await t.test("PSD analysis interprets dimensions and states its header-only coverage", async () => {
      const psd = Buffer.alloc(26);
      psd.write("8BPS", 0, "ascii");
      psd.writeUInt16BE(1, 4);
      psd.writeUInt16BE(3, 12);
      psd.writeUInt32BE(720, 14);
      psd.writeUInt32BE(1280, 18);
      psd.writeUInt16BE(8, 22);
      psd.writeUInt16BE(3, 24);
      await fs.writeFile(path.join(root, "design.psd"), psd);
      const interpreted = await callJson("file_analyze", { path: "design.psd" });
      assert.equal(interpreted.format, "PSD");
      assert.equal(interpreted.width, 1280);
      assert.equal(interpreted.height, 720);
      assert.equal(interpreted.channels, 3);
      assert.match(interpreted.coverage, /header only/i);
      assert.ok(interpreted.limitations.length);
    });

    await t.test("capabilities and tool errors accurately report forced-missing converters", async () => {
      const capabilities = await callJson("fs_capabilities");
      assert.equal(capabilities.total_read_size_limit, null);
      assert.equal(capabilities.total_directory_result_limit, null);
      assert.equal(capabilities.writes.create_confirmation, false);
      assert.equal(capabilities.writes.edit_confirmation, true);
      assert.equal(capabilities.writes.delete_confirmation, true);
      for (const converter of ["ffmpeg", "ffprobe", "magick", "pdftotext", "pdfinfo", "pdftoppm", "exiftool"]) {
        assert.equal(capabilities.converters[converter], false, converter + " does not exist at its configured path");
        assert.equal(health.capabilities.converters[converter], false);
      }
      assert.equal(capabilities.handlers.pdf_ai.text, false);
      assert.equal(capabilities.handlers.pdf_ai.preview, false);
      assert.equal(capabilities.handlers.video.metadata, false);
      assert.equal(capabilities.handlers.video.frames, false);
      assert.equal(capabilities.handlers.psd_psb.layer_preview, false);
      await fs.writeFile(path.join(root, "placeholder.mp4"), "not rendered");
      await expectToolError("video_probe", { path: "placeholder.mp4" }, /ffprobe is missing/i);
      await fs.writeFile(path.join(root, "placeholder.pdf"), "%PDF-1.7\n");
      await expectToolError("pdf_extract_text", { path: "placeholder.pdf" }, /pdfinfo is missing/i);
      await fs.writeFile(path.join(root, "native.afdesign"), Buffer.from([1, 2, 3]));
      const native = await callJson("file_analyze", { path: "native.afdesign" });
      assert.equal(native.kind, "unsupported-native-format");
      assert.ok(native.limitations.length);
      assert.ok(native.next_steps.length);
    });
  } finally {
    if (child?.pid !== undefined && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await Promise.race([childExited, delay(5000, undefined, { ref: false })]);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await Promise.race([childExited, delay(5000, undefined, { ref: false })]);
      }
      assert.ok(child.exitCode !== null || child.signalCode !== null, "only the owned gateway process is stopped before cleanup");
    }
    await cleanupFixture(fixture);
  }
});
