#!/usr/bin/env node
/*
 * Image Gen — pure helper tests:  node tools/core-test.cjs
 */
"use strict";

const assert = require("node:assert");
const path = require("node:path");
const Core = require(path.join(__dirname, "..", "plugin", "core.js"));

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test("clamp and formatting helpers", () => {
  assert.equal(Core.clamp("5", 1, 3), 3);
  assert.equal(Core.clamp(undefined, 1, 3), 1);
  assert.equal(Core.formatBytes(512), "512 B");
  assert.equal(Core.formatBytes(2048), "2.0 KB");
  assert.equal(Core.formatDuration(950), "950 ms");
  assert.equal(Core.formatDuration(2500), "2.5 s");
  assert.equal(Core.formatDuration(65000), "1m 5s");
});

test("base64 round-trips", () => {
  const bytes = new Uint8Array([0, 1, 2, 250, 255]);
  assert.deepEqual(Array.from(Core.base64ToBytes(Core.bytesToBase64(bytes))), Array.from(bytes));
  assert.equal(Core.dataUri("image/png", "AAA"), "data:image/png;base64,AAA");
});

test("maskFromCoverage thresholds the coverage", () => {
  const coverage = new Uint8Array([0, 5, 8, 200]);
  const mask = Core.maskFromCoverage(coverage, 4, 1);
  assert.equal(mask[3], 0);
  assert.equal(mask[7], 0);
  assert.equal(mask[11], 0, "value equal to the threshold stays out");
  assert.equal(mask[15], 255);
});

test("maskFromAlpha respects the alpha offset for 3 and 4 components", () => {
  const rgba = new Uint8Array([10, 20, 30, 255, 10, 20, 30, 0]);
  assert.equal(Core.maskFromAlpha(rgba, 4, 2, 1)[3], 255);
  assert.equal(Core.maskFromAlpha(rgba, 4, 2, 1)[7], 0);
  const rgb = new Uint8Array([10, 20, 30, 10, 20, 0]);
  assert.equal(Core.maskFromAlpha(rgb, 3, 2, 1)[3], 255);
});

test("bbox finds the inked rectangle and null for an empty mask", () => {
  const mask = new Uint8Array(5 * 4 * 4);
  mask[(1 * 5 + 2) * 4 + 3] = 255;
  mask[(2 * 5 + 3) * 4 + 3] = 255;
  assert.deepEqual(Core.bbox(mask, 5, 4), { x: 2, y: 1, width: 2, height: 2 });
  assert.equal(Core.bbox(new Uint8Array(5 * 4 * 4), 5, 4), null);
});

test("expandBounds clamps to the document", () => {
  assert.deepEqual(Core.expandBounds({ x: 10, y: 10, width: 20, height: 20 }, 5, 400, 300), {
    x: 5,
    y: 5,
    width: 30,
    height: 30,
  });
  assert.deepEqual(Core.expandBounds({ x: 0, y: 0, width: 20, height: 20 }, 10, 400, 300), {
    x: 0,
    y: 0,
    width: 30,
    height: 30,
  });
  assert.deepEqual(Core.expandBounds({ x: 390, y: 290, width: 10, height: 10 }, 20, 400, 300), {
    x: 370,
    y: 270,
    width: 30,
    height: 30,
  });
});

test("cropMask and scaleMask move coverage correctly", () => {
  const mask = Core.solidMask(4, 4);
  const cropped = Core.cropMask(mask, 4, 4, { x: 1, y: 1, width: 2, height: 2 });
  assert.equal(cropped.length, 2 * 2 * 4);
  assert.equal(cropped[3], 255);
  const scaled = Core.scaleMask(cropped, 2, 2, 4, 4);
  assert.equal(scaled.length, 4 * 4 * 4);
  assert.equal(scaled[0], 255);
});

test("composeAlpha multiplies alpha by coverage", () => {
  const pixels = new Uint8Array(2 * 1 * 4).fill(255);
  const mask = new Uint8Array(2 * 1 * 4);
  mask[3] = 255;
  mask[7] = 0;
  const out = Core.composeAlpha(pixels, 2, 1, mask, 2, 1);
  assert.equal(out[3], 255);
  assert.equal(out[7], 0);
  assert.equal(out[0], 255, "colour channels are untouched");
});

test("planSize keeps the aspect and respects the edge budget", () => {
  assert.deepEqual(Core.planSize(2000, 1000, 1024), { width: 1024, height: 512, scale: 0.512 });
  assert.deepEqual(Core.planSize(400, 300, 1024), { width: 400, height: 300, scale: 1 });
  const capped = Core.planSize(9000, 9000, 8192, 16 * 1024 * 1024);
  assert.ok(capped.width <= 4096 && capped.height <= 4096, "pixel budget wins over the edge budget");
});

test("roundTo snaps to the step", () => {
  assert.equal(Core.roundTo(1000, 64), 1024);
  assert.equal(Core.roundTo(513, 64), 512);
});

test("template rendering escapes quotes and keeps JSON valid", () => {
  const vars = { prompt: 'a "quoted" prompt', width: 512, seed: 0 };
  const rendered = Core.renderTemplate('{"p":"{{prompt}}"}', vars);
  assert.equal(JSON.parse(rendered).p, 'a "quoted" prompt');
  const parsed = Core.parseJsonTemplate('{"p":"{{prompt}}","w":{{width}},"s":{{seed}}}', vars);
  assert.equal(parsed.p, 'a "quoted" prompt');
  assert.equal(parsed.w, 512);
  assert.equal(parsed.s, 0);
  assert.equal(Core.renderTemplate("x {{missing}} y", vars), "x {{missing}} y");
  assert.throws(() => Core.parseJsonTemplate("{oh no", vars), /JSON/);
  assert.throws(() => Core.parseJsonTemplate('{"s":{{seed}}}', { seed: "" }), /JSON/);
});

test("getPath supports dots, brackets and missing keys", () => {
  const value = { a: { b: [{ url: "u" }] }, list: [1, 2] };
  assert.equal(Core.getPath(value, "a.b[0].url"), "u");
  assert.equal(Core.getPath(value, "list[1]"), 2);
  assert.equal(Core.getPath(value, "a.missing.deep"), undefined);
  assert.equal(Core.getPath(value, ""), value);
});

test("firstImageCandidate understands strings, arrays and url objects", () => {
  assert.equal(Core.firstImageCandidate({ output: "https://x/1.png" }, ["output"]), "https://x/1.png");
  assert.equal(Core.firstImageCandidate({ data: [{ url: "https://x/2.png" }] }, ["data"]), "https://x/2.png");
  assert.equal(Core.firstImageCandidate({ a: 1 }, ["output"]), null);
});

test("statusOf normalises provider states", () => {
  assert.equal(Core.statusOf("succeeded"), "succeeded");
  assert.equal(Core.statusOf("COMPLETED"), "succeeded");
  assert.equal(Core.statusOf("failed"), "failed");
  assert.equal(Core.statusOf("canceled"), "failed");
  assert.equal(Core.statusOf("starting"), "pending");
  assert.equal(Core.statusOf(""), "pending");
});

test("describeError turns provider text into advice", () => {
  assert.match(Core.describeError(new Error("401 Unauthorized")), /API key was rejected/);
  assert.match(Core.describeError(new Error("429 rate limit")), /Rate limited/);
  assert.match(Core.describeError(new Error("fetch failed")), /Cannot reach/);
  assert.equal(Core.describeError(new Error("weird")), "weird");
});

test("truncate caps long prompts", () => {
  assert.equal(Core.truncate("abc", 10), "abc");
  assert.equal(Core.truncate("a".repeat(20), 10).length, 10);
  assert.ok(Core.truncate("a".repeat(20), 10).endsWith("…"));
});

(async () => {
  let failed = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log("  ok   " + name);
    } catch (error) {
      failed += 1;
      console.log("  FAIL " + name + "\n       " + (error && error.message));
    }
  }
  console.log("\n" + (tests.length - failed) + "/" + tests.length + " tests passed");
  process.exit(failed ? 1 : 0);
})();
