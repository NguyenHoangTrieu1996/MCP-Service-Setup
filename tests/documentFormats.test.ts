import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { officeTextPage, archiveInfoPage, archiveTextPage, archiveImage } from "../src/index.js";

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
async function fixture(ext: string, entries: Record<string, string | Buffer>, fn: (target: string) => Promise<void>) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gateway-document-test-"));
  try {
    const target = path.join(dir, "Tài liệu & 'sample'" + ext);
    await fs.writeFile(target, zip(entries));
    await fn(target);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("DOCX pages preserve Vietnamese, text, and notes with exact resume offsets", { skip: process.platform !== "win32" }, async () => {
  await fixture(".docx", {
    "word/document.xml": '<w:document xmlns:w="word"><w:body><w:p><w:r><w:t>Xin chào Việt Nam. Văn bản đầy đủ.</w:t></w:r></w:p></w:body></w:document>',
    "word/header1.xml": '<w:hdr xmlns:w="word"><w:p><w:r><w:t>Tiêu đề</w:t></w:r></w:p></w:hdr>',
  }, async target => {
    const all = await officeTextPage(target, 0, 128000);
    assert.match(all.text, /Xin chào Việt Nam/);
    assert.match(all.text, /Tiêu đề/);
    assert.equal(all.eof, true);
    let offset = 0;
    let joined = "";
    for (let i = 0; i < 10; i++) {
      const page = await officeTextPage(target, offset, 64);
      assert.ok(page.text.length <= 64);
      joined += page.text;
      if (page.eof) { assert.equal(page.next_offset, null); break; }
      assert.equal(page.next_offset, offset + page.text.length);
      offset = page.next_offset!;
    }
    assert.equal(joined, all.text);
  });
});

test("XLSX exposes string dictionary, cell references and formulas", { skip: process.platform !== "win32" }, async () => {
  await fixture(".xlsx", {
    "xl/workbook.xml": '<workbook><sheets><sheet name="Doanh thu" sheetId="1"/></sheets></workbook>',
    "xl/sharedStrings.xml": '<sst><si><t>Giá trị</t></si></sst>',
    "xl/worksheets/sheet1.xml": '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1"><f>1+2</f><v>3</v></c></row></sheetData></worksheet>',
  }, async target => {
    const page = await officeTextPage(target);
    assert.match(page.text, /Doanh thu/);
    assert.match(page.text, /\[shared-string:0\] Giá trị/);
    assert.match(page.text, /\[cell:A1 type=s\] \[shared-string:0\]/);
    assert.match(page.text, /\[formula\] 1\+2/);
  });
});

test("OpenDocument text and PPTX notes are included", { skip: process.platform !== "win32" }, async () => {
  await fixture(".odt", { "content.xml": '<office xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"><text:p>Nội dung<text:span> đầy đủ</text:span></text:p></office>' }, async target => {
    assert.match((await officeTextPage(target)).text, /Nội dung đầy đủ/);
  });
  await fixture(".pptx", {
    "ppt/slides/slide1.xml": '<slide><p><r><t>Trang trình chiếu</t></r></p></slide>',
    "ppt/notesSlides/notesSlide1.xml": '<notes><p><r><t>Ghi chú diễn giả</t></r></p></notes>',
  }, async target => {
    const page = await officeTextPage(target);
    assert.match(page.text, /Trang trình chiếu/);
    assert.match(page.text, /Ghi chú diễn giả/);
  });
});

test("ZIP pagination flags traversal names; reads bounded JSON and PNG without extraction", { skip: process.platform !== "win32" }, async () => {
  const json = JSON.stringify({ title: "Thiết kế", layers: ["Nền", "Chữ"] });
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=", "base64");
  await fixture(".sketch", { "pages/one.json": json, "../unsafe.txt": "text", "preview.png": png }, async target => {
    const first = await archiveInfoPage(target, 0, 1);
    assert.equal(first.total_entries, 3);
    assert.equal(first.next_offset, 1);
    const rest = await archiveInfoPage(target, 1, 10);
    assert.equal(rest.entries[0].unsafe_path, true);
    assert.equal(rest.eof, true);
    const page = await archiveTextPage(target, "pages/one.json", 3, 10);
    assert.equal(page.entry, "pages/one.json");
    assert.equal(page.text, json.slice(3, 13));
    assert.equal(page.next_offset, 13);
    const image = await archiveImage(target, "preview.png");
    assert.equal(image.mimeType, "image/png");
    assert.equal(image.data, png.toString("base64"));
  });
});

test("Office DTDs and invalid page arguments are rejected", { skip: process.platform !== "win32" }, async () => {
  await fixture(".docx", { "word/document.xml": '<!DOCTYPE document [<!ENTITY bad "expanded">]><document><p><t>&bad;</t></p></document>' }, async target => {
    await assert.rejects(officeTextPage(target), /DTD|Dtd|prohibited/);
    await assert.rejects(officeTextPage(target, -1, 100), /offset/);
    await assert.rejects(officeTextPage(target, 0, 128001), /limit/);
  });
});

