import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readOfficeViaFsRead, resolveOfficeReadPath } from "../src/officeFsReadCompat.js";

function crc32(data: Buffer) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function zip(entries: Record<string, string | Buffer>): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [entryName, text] of Object.entries(entries)) {
    const name = Buffer.from(entryName);
    const data = Buffer.isBuffer(text) ? text : Buffer.from(text);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt32LE(crc32(data), 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, data);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x800, 8);
    cd.writeUInt32LE(crc32(data), 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, name);
    offset += local.length + name.length + data.length;
  }
  const body = Buffer.concat(locals);
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(body.length, 16);
  return Buffer.concat([body, directory, end]);
}

test("fs_read compatibility extracts Vietnamese DOCX and supports continuation", { skip: process.platform !== "win32" }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-office-compat-"));
  const previousRoot = process.env.MCP_ROOT;
  process.env.MCP_ROOT = root;
  try {
    const folder = path.join(root, "50nam");
    await fs.mkdir(folder);
    const target = path.join(folder, "Đề cương điều chỉnh TPHCM - 50nam Việt-Anh.docx");
    await fs.writeFile(target, zip({
      "word/document.xml": '<w:document xmlns:w="word"><w:body><w:p><w:r><w:t>Thành phố Hồ Chí Minh - Việt Nam. Nội dung song ngữ Việt-Anh.</w:t></w:r></w:p></w:body></w:document>',
      "word/header1.xml": '<w:hdr xmlns:w="word"><w:p><w:r><w:t>50 năm</w:t></w:r></w:p></w:hdr>'
    }));

    const first = await readOfficeViaFsRead({ path: path.join("50nam", path.basename(target)), offset: 0, length: 32 });
    assert.equal(first.read_mode, "office_text");
    assert.equal(first.offset_unit, "UTF-16 characters");
    assert.equal(first.eof, false);
    assert.equal(typeof first.next_offset, "number");

    let combined = first.text;
    let next = first.next_offset;
    let version = first.version;
    for (let i = 0; i < 20 && next !== null; i++) {
      const page = await readOfficeViaFsRead({ path: path.join("50nam", path.basename(target)), offset: next, length: 32, expected_version: version });
      combined += page.text;
      next = page.next_offset;
      version = page.version;
    }
    assert.match(combined, /Thành phố Hồ Chí Minh/);
    assert.match(combined, /Việt-Anh/);
    assert.match(combined, /50 năm/);
    assert.equal(next, null);
  } finally {
    if (previousRoot === undefined) delete process.env.MCP_ROOT;
    else process.env.MCP_ROOT = previousRoot;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Office fs_read compatibility rejects paths outside MCP_ROOT", { skip: process.platform !== "win32" }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-office-root-"));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-office-outside-"));
  const previousRoot = process.env.MCP_ROOT;
  process.env.MCP_ROOT = root;
  try {
    const target = path.join(outside, "outside.docx");
    await fs.writeFile(target, zip({ "word/document.xml": "<document><t>outside</t></document>" }));
    await assert.rejects(resolveOfficeReadPath(target), /outside the configured allowed root/i);
  } finally {
    if (previousRoot === undefined) delete process.env.MCP_ROOT;
    else process.env.MCP_ROOT = previousRoot;
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});
