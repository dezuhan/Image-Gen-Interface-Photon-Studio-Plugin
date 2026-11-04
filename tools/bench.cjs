#!/usr/bin/env node
/*
 * Image Gen — performance check:  node tools/bench.cjs
 *
 * The panel does three measurable things before a network round trip: build the mask, plan the work
 * size and fill the request template. This prints those numbers plus the payload sizes providers
 * receive for a typical 1024 px edit.
 */
"use strict";

const path = require("node:path");
const Core = require(path.join(__dirname, "..", "plugin", "core.js"));
const Providers = require(path.join(__dirname, "..", "plugin", "providers.js"));

function time(label, iterations, fn) {
  fn();
  const started = process.hrtime.bigint();
  for (let index = 0; index < iterations; index += 1) fn();
  const us = Number(process.hrtime.bigint() - started) / 1e3 / iterations;
  console.log(label.padEnd(46) + us.toFixed(1).padStart(9) + " us/call");
  return us;
}

console.log("=== pure work ===");
const coverage = new Uint8Array(1024 * 1024);
for (let index = 0; index < coverage.length; index += 1) coverage[index] = index % 255;
time("maskFromCoverage 1024²", 20, () => Core.maskFromCoverage(coverage, 1024, 1024));
const solid = Core.solidMask(1024, 1024);
time("bbox 1024²", 20, () => Core.bbox(solid, 1024, 1024));
time("scaleMask 1024² → 768²", 10, () => Core.scaleMask(solid, 1024, 1024, 768, 768));
time("composeAlpha 1024²", 20, () => Core.composeAlpha(solid, 1024, 1024, solid, 1024, 1024));
time("planSize", 10000, () => Core.planSize(3000, 2000, 1024, Core.MAX_PIXELS));

console.log("\n=== provider payloads ===");
const fakeUri = "data:image/png;base64," + "A".repeat(350000);
const replicate = Providers.buildReplicateRequest({
  model: "black-forest-labs/flux-fill-dev",
  prompt: "a calm studio background, soft light",
  image: fakeUri,
  mask: (fakeUri + fakeUri).slice(0, 450000),
  width: 1024,
  height: 1024,
  steps: 28,
  guidance: 3.5,
  seed: 1234,
});
const body = JSON.stringify(replicate.options.json);
console.log("replicate submit URL      " + replicate.url);
console.log("replicate body            " + Core.formatBytes(Buffer.byteLength(body)));
console.log("input keys                " + Object.keys(replicate.options.json.input).join(", "));

const custom = Providers.buildCustomRequest({
  config: { ...Providers.CUSTOM_DEFAULTS, submitUrl: "https://example.com/generate" },
  prompt: "a calm studio background",
  image: fakeUri,
  mask: fakeUri,
  width: 1024,
  height: 1024,
  seed: 1234,
  model: "custom-model",
});
console.log("custom body               " + Core.formatBytes(Buffer.byteLength(JSON.stringify(custom.options.json))));

console.log("\n=== template rendering ===");
time("renderTemplate", 20000, () =>
  Core.renderTemplate(Providers.CUSTOM_DEFAULTS.bodyTemplate, { prompt: "x", image: "data:1", mask: "data:2", width: 512, height: 512, seed: 1, model: "m" }),
);
