import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { assertEditableText, directoryPage, MAX_FILE_PAGE_BYTES, readBinaryPage, readTextPage } from "../src/index.js";

async function fixture(run: (root: string) => Promise<void>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gateway-file-io-"));
  try { await run(root); }
  finally { await fs.rm(root, { recursive: true, force: true }); }
}
function secureFor(root: string) {
  return async (input = "") => {
    const target = path.resolve(root, input);
    const relative = path.relative(root, target);
    assert.ok(relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative), "inside root");
    const realRoot = await fs.realpath(root);
    const real = await fs.realpath(target);
    const realRelative = path.relative(realRoot, real);
    assert.ok(realRelative !== ".." && !realRelative.startsWith(".." + path.sep) && !path.isAbsolute(realRelative), "real path inside root");
    return target;
  };
}

test("UTF-8 byte pages reconstruct all text, including BOM and split multibyte characters", async () => fixture(async root => {
  const target = path.join(root, "unicode.txt");
  const source = "\ufeffA tiếng Việt 😀漢字\n".repeat(200);
  await fs.writeFile(target, source);
  for (const length of [1, 2, 3, 4, 7, 255]) {
    let offset = 0;
    let restored = "";
    let version: string | undefined;
    while (true) {
      const page = await readTextPage(target, offset, length, version);
      assert.equal(page.offset, offset);
      assert.ok(page.next_offset - offset <= length + 3);
      assert.equal(Buffer.byteLength(page.text), page.next_offset - offset);
      restored += page.text;
      version = page.version;
      if (page.eof) break;
      assert.ok(page.next_offset > offset);
      offset = page.next_offset;
    }
    assert.equal(restored, source);
  }
}));

test("empty files and EOF return complete empty pages; unsafe UTF-8 offsets fail", async () => fixture(async root => {
  const target = path.join(root, "empty.txt");
  await fs.writeFile(target, "");
  const empty = await readTextPage(target, 0, 1);
  assert.equal(empty.text, "");
  assert.equal(empty.eof, true);
  await fs.writeFile(target, "😀");
  await assert.rejects(readTextPage(target, 1, 1), /splits a UTF-8/);
  const eof = await readTextPage(target, 4, 1);
  assert.equal(eof.eof, true);
  assert.equal(eof.text, "");
  await assert.rejects(readTextPage(target, 5, 1), /beyond/);
  await assert.rejects(readTextPage(target, -1, 1), /offset/);
  await assert.rejects(readTextPage(target, 0, MAX_FILE_PAGE_BYTES + 1), /length/);
}));

test("invalid UTF-8, control bytes, and disguised format signatures are rejected", async () => fixture(async root => {
  const target = path.join(root, "binary.txt");
  for (const payload of [Buffer.from([0xc3, 0x28]), Buffer.from([0x41, 0]), Buffer.from("%PDF-1.7 rest")]) {
    await fs.writeFile(target, payload);
    await assert.rejects(readTextPage(target, 0, 20), /UTF-8|Binary/);
    await assert.rejects(assertEditableText(target), /UTF-8|Binary|binary/);
  }
  await fs.writeFile(target, "%PDF-1.7 rest");
  await assert.rejects(readTextPage(target, 0, 1), /Binary/);
  await fs.writeFile(target, Buffer.from([0xf0, 0x9f]));
  await assert.rejects(readTextPage(target, 0, 1), /UTF-8/);
  const docx = path.join(root, "protected.docx");
  await fs.writeFile(docx, "Even a text-looking payload must not be edited as a document.");
  await assert.rejects(assertEditableText(docx), /format/);
}));

test("expected version rejects changed content between pages", async () => fixture(async root => {
  const target = path.join(root, "version.txt");
  await fs.writeFile(target, "first version");
  const first = await readTextPage(target, 0, 2);
  await fs.writeFile(target, "a different version now");
  await assert.rejects(readTextPage(target, first.next_offset, 2, first.version), /changed/);
  await assert.rejects(readBinaryPage(target, first.next_offset, 2, first.version), /changed/);
}));

test("binary pages reconstruct large arbitrary bytes without a total file size limit", async () => fixture(async root => {
  const target = path.join(root, "large.bin");
  const source = Buffer.alloc(MAX_FILE_PAGE_BYTES * 2 + 71);
  for (let index = 0; index < source.length; index++) source[index] = index % 256;
  await fs.writeFile(target, source);
  const pieces: Buffer[] = [];
  let offset = 0;
  let version: string | undefined;
  while (true) {
    const page = await readBinaryPage(target, offset, MAX_FILE_PAGE_BYTES, version);
    pieces.push(Buffer.from(page.data_base64, "base64"));
    assert.equal(page.next_offset - page.offset, pieces[pieces.length - 1]!.length);
    version = page.version;
    if (page.eof) break;
    offset = page.next_offset;
  }
  assert.deepEqual(Buffer.concat(pieces), source);
}));

test("streaming edit validation handles UTF-8 across 64 KiB boundaries and rejects an invalid tail", async () => fixture(async root => {
  const target = path.join(root, "large.txt");
  await fs.writeFile(target, "x".repeat(65_535) + "😀" + "n".repeat(80_000));
  await assertEditableText(target);
  await fs.appendFile(target, Buffer.from([0xff]));
  await assert.rejects(assertEditableText(target), /UTF-8/);
  await assert.rejects(assertEditableText(root), /regular file|EISDIR/);
}));

test("list and recursive search cover more than 500 results with consumable cursors", async () => fixture(async root => {
  await fs.mkdir(path.join(root, "nested"));
  await Promise.all(Array.from({ length: 620 }, (_, index) =>
    fs.writeFile(path.join(root, "item-" + index + ".txt"), "")));
  await fs.writeFile(path.join(root, "nested", "item-child.txt"), "");
  const secure = secureFor(root);
  for (const query of [null, "item-"]) {
    const paths = new Set<string>();
    let cursor: string | undefined;
    let lastMatches = 0;
    do {
      const previous = cursor;
      const page = await directoryPage(root, root, query, cursor, 67, secure);
      for (const entry of page.entries) {
        assert.equal(paths.has(entry.path), false, "each path appears once in an unchanged directory");
        paths.add(entry.path);
      }
      assert.ok(page.total_matches >= lastMatches);
      lastMatches = page.total_matches;
      assert.equal(page.complete, page.next_cursor === null);
      if (previous) await assert.rejects(directoryPage(root, root, query, previous, 67, secure), /expired, consumed/);
      cursor = page.next_cursor ?? undefined;
    } while (cursor);
    assert.equal(paths.size, 621);
    if (query !== null) assert.ok(paths.has(path.join("nested", "item-child.txt")));
    else assert.ok(paths.has("nested"));
  }
  const empty = await directoryPage(root, root, "no-match", undefined, 20, secure);
  assert.equal(empty.complete, true);
  assert.equal(empty.entries.length, 0);
}));

test("cursor binding prevents query/path mixing and traversal errors are explicit", async () => fixture(async root => {
  await fs.writeFile(path.join(root, "one.txt"), "");
  await fs.writeFile(path.join(root, "two.txt"), "");
  const secure = secureFor(root);
  const first = await directoryPage(root, root, null, undefined, 1, secure);
  assert.ok(first.next_cursor);
  await assert.rejects(directoryPage(root, root, "changed", first.next_cursor!, 1, secure), /does not match/);
  let cursor: string | undefined = first.next_cursor!;
  while (cursor) cursor = (await directoryPage(root, root, null, cursor, 100, secure)).next_cursor ?? undefined;
  await assert.rejects(directoryPage(root, path.dirname(root), null, undefined, 10, secure), /escapes/);
  await assert.rejects(directoryPage(root, root, null, undefined, 0, secure), /limit/);
  await assert.rejects(directoryPage(root, root, null, undefined, 10, async () => { throw new Error("permission denied"); }), /Traversal incomplete.*permission denied/);
}));

test("directory traversal skips symlinks/junctions pointing outside the root", async t => fixture(async root => {
  const allowed = path.join(root, "allowed");
  const outside = path.join(root, "outside");
  await fs.mkdir(allowed);
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, "secret.txt"), "secret");
  try { await fs.symlink(outside, path.join(allowed, "escape"), process.platform === "win32" ? "junction" : "dir"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") { t.skip("OS does not allow test symlink creation"); return; }
    throw error;
  }
  const result = await directoryPage(allowed, allowed, "", undefined, 100, secureFor(allowed));
  assert.equal(result.complete, true);
  assert.equal(result.entries.length, 0);
  assert.equal(result.skipped_symlinks, 1);
}));
