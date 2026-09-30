import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { modelInfo } from "../src/index.js";

async function fixture<T>(extension: string, content: string | Buffer, run: (target: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gateway-model-test-"));
  const target = path.join(dir, "drawing" + extension);
  try {
    await fs.writeFile(target, content);
    return await run(target);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("ASCII DXF reports entity types, layers, text, and coordinate bounds", async () => fixture(".dxf", [
  "0", "SECTION", "2", "ENTITIES", "0", "LINE", "8", "Walls", "10", "-2", "20", "3", "30", "0", "11", "8", "21", "9", "31", "0",
  "0", "TEXT", "8", "Labels", "1", "Front door", "10", "1", "20", "2", "30", "0", "0", "ENDSEC", "0", "EOF", ""
].join("\n"), async target => {
  const result = await modelInfo(target) as any;
  assert.equal(result.format, "DXF (ASCII)");
  assert.equal(result.details.total_entities, 2);
  assert.equal(result.details.entities.LINE, 1);
  assert.deepEqual(result.details.layers, ["Labels", "Walls"]);
  assert.deepEqual(result.details.text_values, ["Front door"]);
  assert.deepEqual(result.details.bounds, { min: [-2, 2, 0], max: [8, 9, 0] });
}));

test("binary DXF signature is recognized without claiming entity analysis", async () => fixture(".dxf", Buffer.from("AutoCAD Binary DXF\r\n\x1a\0", "binary"), async target => {
  const result = await modelInfo(target) as any;
  assert.equal(result.format, "DXF (binary)");
  assert.match(result.coverage, /entity geometry was not decoded/i);
  assert.match(result.limitations[0], /ASCII DXF/);
}));

test("OBJ streams all vertices and counts primitive records", async () => fixture(".obj", [
  "o Cube", "v -1 0 2", "v 3 4 5", "vt 0 1", "vn 0 0 1", "usemtl Painted", "f 1/1/1 2/1/1 1/1/1"
].join("\n"), async target => {
  const result = await modelInfo(target) as any;
  assert.equal(result.details.vertices, 2);
  assert.equal(result.details.faces, 1);
  assert.deepEqual(result.details.bounds, { min: [-1, 0, 2], max: [3, 4, 5] });
  assert.deepEqual(result.details.object_groups, ["Cube"]);
  assert.deepEqual(result.details.materials, ["Painted"]);
}));

test("binary STL validates triangle count and calculates vertex bounds", async () => {
  const stl = Buffer.alloc(84 + 50);
  stl.write("test binary STL");
  stl.writeUInt32LE(1, 80);
  stl.writeFloatLE(-1, 96);
  stl.writeFloatLE(0, 100);
  stl.writeFloatLE(1, 104);
  stl.writeFloatLE(2, 108);
  stl.writeFloatLE(3, 112);
  stl.writeFloatLE(4, 116);
  stl.writeFloatLE(0, 120);
  stl.writeFloatLE(-2, 124);
  stl.writeFloatLE(8, 128);
  const result = await fixture(".stl", stl, target => modelInfo(target)) as any;
  assert.equal(result.format, "STL (binary)");
  assert.equal(result.details.triangles, 1);
  assert.deepEqual(result.details.bounds, { min: [-1, -2, 1], max: [2, 3, 8] });
});

test("glTF JSON and GLB summarize mesh structure and report limits", async () => {
  const document = { asset: { version: "2.0", generator: "fixture" }, scenes: [{ nodes: [0] }], nodes: [{ name: "Cube", mesh: 0 }],
    meshes: [{ name: "Body", primitives: [{ attributes: { POSITION: 0 } }] }], accessors: [{ count: 24 }], materials: [{ name: "Steel" }] };
  const json = Buffer.from(JSON.stringify(document));
  const jsonResult = await fixture(".gltf", json, target => modelInfo(target)) as any;
  assert.equal(jsonResult.details.nodes, 1);
  assert.deepEqual(jsonResult.details.position_vertex_counts, [24]);
  assert.deepEqual(jsonResult.details.materials, ["Steel"]);

  const paddedJson = Buffer.concat([json, Buffer.alloc((4 - json.length % 4) % 4, 0x20)]);
  const glb = Buffer.alloc(20 + paddedJson.length);
  glb.write("glTF", 0, "ascii");
  glb.writeUInt32LE(2, 4);
  glb.writeUInt32LE(glb.length, 8);
  glb.writeUInt32LE(paddedJson.length, 12);
  glb.writeUInt32LE(0x4e4f534a, 16);
  paddedJson.copy(glb, 20);
  const binaryResult = await fixture(".glb", glb, target => modelInfo(target)) as any;
  assert.equal(binaryResult.format, "glTF Binary (GLB)");
  assert.equal(binaryResult.details.meshes, 1);
  });

test("DWG reports its version signature without claiming drawing analysis", async () => fixture(".dwg", Buffer.from("AC1032"), async target => {
  const result = await modelInfo(target) as any;
  assert.equal(result.details.version_signature, "AC1032");
  assert.match(result.coverage, /signature only/);
  assert.match(result.limitations[0], /ASCII DXF/);
}));

test("malformed DXF and model signatures are rejected", async () => {
  await fixture(".dxf", "not a group code\nVALUE\n", async target => {
    await assert.rejects(modelInfo(target), /group-code/);
  });
  await fixture(".dwg", "not DWG", async target => {
    await assert.rejects(modelInfo(target), /signature/);
  });
});