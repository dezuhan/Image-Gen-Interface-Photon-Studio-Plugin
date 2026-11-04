#!/usr/bin/env node
/*
 * Image Gen — end-to-end pipeline tests with a fake Photon SDK:
 *   node tools/pipeline-test.cjs
 */
"use strict";

const assert = require("node:assert");
const path = require("node:path");
const Core = require(path.join(__dirname, "..", "plugin", "core.js"));
const Providers = require(path.join(__dirname, "..", "plugin", "providers.js"));
const Pipeline = require(path.join(__dirname, "..", "plugin", "pipeline.js"));

/* ------------------------------------------------------------------ fake Photon */

function fillLayer(width, height, value, alphaValue) {
  const pixels = new Uint8Array(width * height * 4);
  for (let index = 0; index < width * height; index += 1) {
    pixels[index * 4] = value;
    pixels[index * 4 + 1] = value;
    pixels[index * 4 + 2] = value;
    pixels[index * 4 + 3] = alphaValue === undefined ? 255 : alphaValue;
  }
  return pixels;
}

function fakeApi(options) {
  const config = options || {};
  const width = 400;
  const height = 300;
  const calls = [];
  const selected = ["L1"];
  const doc = {
    id: "doc1",
    title: "Test",
    width,
    height,
    revision: 3,
    colorMode: "RGB",
    depth: 8,
    hasSelection: !config.noSelection,
    selectedLayerIds: selected,
    layers: [{ id: "L1", name: "Background", kind: "pixel" }],
  };
  const bounds = config.bounds || { x: 50, y: 40, width: 64, height: 48 };
  const coverage = new Uint8Array(bounds.width * bounds.height);
  for (let index = 0; index < coverage.length; index += 1) {
    coverage[index] = config.halfMask && index > coverage.length / 2 ? 0 : 255;
  }
  const generated = config.generated || { width: 128, height: 96 };
  const state = { polls: 0, selected };

  const api = {
    calls,
    documents: {
      active: async () => ({ ...doc, selectedLayerIds: [...state.selected] }),
      pixels: async () => ({
        options: { width, height, components: 4, componentSize: 8 },
        pixels: fillLayer(width, height, 180),
        sourceBounds: { left: 0, top: 0 },
      }),
      capture: async () => {
        calls.push("capture");
        if (config.captureFails) throw new Error("capture unavailable");
        return config.noMask || config.noSelection ? { bounds, token: "cap1" } : { bounds, mask: coverage, token: "cap1" };
      },
      applyImage: async (params) => {
        calls.push("applyImage");
        if (config.applyFails) throw new Error("applyImage failed");
        api.lastApply = params;
        return { layerId: "R1" };
      },
      writePixels: async (docId, layerId, transfer, label) => {
        calls.push("writePixels");
        api.lastWrite = { docId, layerId, transfer, label };
      },
      execute: async (operation, params) => {
        calls.push("execute:" + operation);
        if (operation === "layer.new") state.selected = ["R1"];
        return { ok: true };
      },
      release: async (token) => {
        calls.push("release:" + token);
      },
    },
    images: {
      encode: async (image) => {
        calls.push("encode:" + image.width + "x" + image.height);
        return { width: image.width, height: image.height, bytes: new Uint8Array([1, 2, 3]) };
      },
      decode: async () => {
        calls.push("decode");
        return { width: generated.width, height: generated.height, pixels: fillLayer(generated.width, generated.height, 240) };
      },
    },
    network: {
      allowEndpoint: async () => {},
      request: async (request) => {
        calls.push("request:" + request.url);
        if (request.json && request.json.input) api.lastSubmit = request.json;
        // Photon parses JSON responses unless response:"bytes" is requested, so `body` is an object.
        // The config flags keep the other build shapes covered too.
        const jsonReply = (status, payload) => ({
          status,
          body: config.stringBody
            ? JSON.stringify(payload)
            : config.byteBody
              ? new TextEncoder().encode(JSON.stringify(payload))
              : payload,
          headers: { "content-type": "application/json" },
        });
        if (request.url.includes("/v1/models/") && request.url.endsWith("/predictions")) {
          if (config.noId) return jsonReply(201, { status: "starting" });
          return jsonReply(201, { id: "p1", status: "starting" });
        }
        if (request.url.includes("/v1/models/") && !request.url.endsWith("/predictions")) {
          return jsonReply(200, {
            latest_version: {
              openapi_schema: {
                components: {
                  schemas: {
                    Input: {
                      properties: {
                        prompt: {},
                        image_input: {},
                        match_input_image: {},
                        aspect_ratio: {},
                        resolution: {},
                        temperature: {},
                        output_format: {},
                        seed: {},
                      },
                    },
                  },
                },
              },
            },
          });
        }
        if (request.url.includes("/v1/predictions/p1")) {
          state.polls += 1;
          if (config.failPrediction) return jsonReply(200, { id: "p1", status: "failed", error: "model exploded" });
          if (state.polls < (config.pollsUntilDone || 2)) return jsonReply(200, { id: "p1", status: "processing" });
          return jsonReply(200, { id: "p1", status: "succeeded", output: ["https://replicate.delivery/out.png"] });
        }
        if (request.url.startsWith("https://replicate.delivery/")) {
          return { status: 200, body: new Uint8Array([9, 9, 9]) };
        }
        if (request.url.includes("example.com")) {
          return jsonReply(200, { output: ["https://example.com/out.png"] });
        }
        throw new Error("unexpected request " + request.url);
      },
    },
  };
  return api;
}

function replicateSettings(overrides) {
  return {
    provider: "replicate",
    model: "black-forest-labs/flux-fill-dev",
    baseUrl: "",
    size: "64",
    steps: 20,
    guidance: 3.5,
    strength: 0.9,
    margin: 0,
    custom: { ...Providers.CUSTOM_DEFAULTS },
    ...(overrides || {}),
  };
}

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test("readJson decodes the SDK byte body", () => {
  const reply = { status: 200, body: new TextEncoder().encode('{"id":"p1","status":"starting"}') };
  assert.deepEqual(Pipeline.readJson(reply), { id: "p1", status: "starting" });
  assert.equal(Pipeline.readJson({ status: 200, body: new Uint8Array() }), null);
  assert.equal(Pipeline.readJson({ status: 200, body: new TextEncoder().encode("not json") }), null);
  assert.equal(Pipeline.readJson({ status: 200, json: { id: "x" } }).id, "x");
});

/* ------------------------------------------------------------------ capture */

test("captureSource reads the selection bounds and coverage mask", async () => {
  const api = fakeApi({});
  const source = await Pipeline.captureSource({ api, settings: replicateSettings() });
  assert.equal(source.hasSelection, true);
  assert.deepEqual(source.bounds, { x: 50, y: 40, width: 64, height: 48 });
  assert.equal(source.width, 64);
  assert.equal(source.height, 48);
  assert.equal(source.captureToken, "cap1");
  assert.equal(source.mask.length, 64 * 48 * 4);
  assert.equal(source.mask[3], 255);
  assert.equal(api.calls.includes("capture"), true);
});

test("without a selection the whole layer is the source", async () => {
  const api = fakeApi({ noSelection: true });
  const source = await Pipeline.captureSource({ api, settings: replicateSettings() });
  assert.equal(source.hasSelection, false);
  assert.equal(source.captureToken, null);
  assert.deepEqual(source.bounds, { x: 0, y: 0, width: 400, height: 300 });
  assert.equal(source.mask.length, 400 * 300 * 4);
  assert.equal(api.calls.includes("capture"), false);
});

test("with a selection the layer is kept as full context", async () => {
  const api = fakeApi({});
  const source = await Pipeline.captureSource({ api, settings: replicateSettings() });
  assert.equal(source.layerWidth, 400);
  assert.equal(source.layerHeight, 300);
  assert.equal(source.layerPixels.length, 400 * 300 * 4);
  assert.deepEqual(source.bounds, { x: 50, y: 40, width: 64, height: 48 });
});

test("captureSource expands the bounds by the margin", async () => {
  const api = fakeApi({});
  const source = await Pipeline.captureSource({ api, settings: replicateSettings({ margin: 10 }) });
  assert.deepEqual(source.bounds, { x: 40, y: 30, width: 84, height: 68 });
  assert.equal(source.width, 84);
  assert.equal(source.mask.length, 84 * 68 * 4);
});

test("captureSource still works when capture returns no mask", async () => {
  const api = fakeApi({ noMask: true });
  const source = await Pipeline.captureSource({ api, settings: replicateSettings() });
  assert.equal(source.captureToken, "cap1");
  assert.equal(source.mask.length, 64 * 48 * 4, "solid rectangle mask");
});

test("captureSource reports an empty layer clearly", async () => {
  const api = fakeApi({});
  api.documents.pixels = async () => {
    throw new Error("no allocated pixels");
  };
  await assert.rejects(
    () => Pipeline.captureSource({ api, settings: replicateSettings() }),
    /no pixel data/,
  );
});

/* ------------------------------------------------------------------ generate */

test("generate follows the Replicate submit → poll → download path", async () => {
  const api = fakeApi({});
  const source = await Pipeline.captureSource({ api, settings: replicateSettings() });
  const progress = [];
  const generated = await Pipeline.generate({
    api,
    settings: replicateSettings(),
    source,
    prompt: "a red bicycle",
    seed: 42,
    pollMs: 1,
    progress: (value, text) => progress.push({ value, text }),
    isCancelled: () => false,
  });
  assert.equal(generated.image.width, 64);
  assert.equal(generated.image.height, 48);
  assert.equal(generated.providerImage.width, 128);
  assert.equal(generated.plan.width, 64);
  assert.ok(api.calls.some((call) => call.startsWith("request:https://api.replicate.com/v1/models/")));
  assert.ok(api.calls.filter((call) => call.includes("/v1/predictions/p1")).length >= 2, "polls until done");
  assert.ok(api.calls.some((call) => call.startsWith("request:https://replicate.delivery/")));
  assert.ok(api.calls.some((call) => call.startsWith("encode:")));
  assert.equal(generated.providerImage.width, 128);
  assert.ok(progress.length >= 3);
});

test("generate surfaces a failed prediction", async () => {
  const api = fakeApi({ failPrediction: true });
  const source = await Pipeline.captureSource({ api, settings: replicateSettings() });
  await assert.rejects(
    () => Pipeline.generate({ api, settings: replicateSettings(), source, prompt: "x", seed: 1, pollMs: 1 }),
    /model exploded/,
  );
});

test("generate stops when cancelled", async () => {
  const api = fakeApi({ pollsUntilDone: 50 });
  const source = await Pipeline.captureSource({ api, settings: replicateSettings() });
  await assert.rejects(
    () => Pipeline.generate({ api, settings: replicateSettings(), source, prompt: "x", seed: 1, pollMs: 1, isCancelled: () => true }),
    /cancelled/,
  );
});

test("generate drives the custom endpoint template", async () => {
  const api = fakeApi({});
  const settings = replicateSettings({
    provider: "custom",
    custom: { ...Providers.CUSTOM_DEFAULTS, submitUrl: "https://example.com/generate" },
  });
  const source = await Pipeline.captureSource({ api, settings });
  const generated = await Pipeline.generate({ api, settings, source, prompt: "a cat", seed: 7, pollMs: 1 });
  assert.equal(generated.image.width, 64);
  const submit = api.calls.find((call) => call.startsWith("request:https://example.com/generate"));
  assert.ok(submit, "posted to the custom endpoint");
  assert.ok(api.calls.some((call) => call.startsWith("request:https://example.com/out.png")));
});

/* ------------------------------------------------------------------ apply */

test("apply uses applyImage with the capture token", async () => {
  const api = fakeApi({});
  const source = await Pipeline.captureSource({ api, settings: replicateSettings() });
  const outcome = await Pipeline.apply({
    api,
    result: {
      image: { width: 64, height: 48, pixels: fillLayer(64, 48, 200) },
      bounds: source.bounds,
      originX: 0,
      originY: 0,
      captureToken: "cap1",
      mask: source.mask,
      maskWidth: 64,
      maskHeight: 48,
      hasSelection: true,
      prompt: "x",
      model: "m",
      docId: "doc1",
    },
    name: "Image Gen test",
  });
  assert.equal(outcome.method, "applyImage");
  assert.equal(api.lastApply.captureToken, "cap1");
  assert.equal(api.lastApply.image.width, 64);
  assert.ok(api.calls.includes("release:cap1"));
});

test("apply falls back to a masked layer when applyImage fails", async () => {
  const api = fakeApi({ applyFails: true, halfMask: true });
  const source = await Pipeline.captureSource({ api, settings: replicateSettings() });
  const outcome = await Pipeline.apply({
    api,
    result: {
      image: { width: 64, height: 48, pixels: fillLayer(64, 48, 200) },
      bounds: source.bounds,
      originX: 5,
      originY: 7,
      captureToken: "cap1",
      mask: source.mask,
      maskWidth: 64,
      maskHeight: 48,
      hasSelection: true,
      prompt: "x",
      model: "m",
      docId: "doc1",
    },
    name: "fallback",
  });
  assert.equal(outcome.method, "writePixels");
  assert.equal(api.lastWrite.transfer.options.width, 64);
  assert.equal(api.lastWrite.transfer.sourceBounds.left, 5 + 50);
  assert.equal(api.lastWrite.transfer.pixels[3], 255, "masked-in pixel keeps its alpha");
  const lastPixel = (48 * 64 - 1) * 4 + 3;
  assert.equal(api.lastWrite.transfer.pixels[lastPixel], 0, "masked-out pixel becomes transparent");
});

test("apply refuses when the document changed", async () => {
  const api = fakeApi({});
  await assert.rejects(
    () => Pipeline.apply({
      api,
      result: {
        image: { width: 4, height: 4, pixels: fillLayer(4, 4, 1) },
        bounds: { x: 0, y: 0, width: 4, height: 4 },
        originX: 0,
        originY: 0,
        captureToken: null,
        mask: Core.solidMask(4, 4),
        maskWidth: 4,
        maskHeight: 4,
        hasSelection: false,
        prompt: "x",
        model: "m",
        docId: "other-doc",
      },
      name: "x",
    }),
    /document changed/i,
  );
});


test("readJson accepts strings, ArrayBuffers and typed views", () => {
  const text = '{"id":"p1","status":"starting"}';
  assert.deepEqual(Pipeline.readJson({ status: 200, body: text }), { id: "p1", status: "starting" });
  assert.deepEqual(
    Pipeline.readJson({ status: 200, body: new TextEncoder().encode(text).buffer }),
    { id: "p1", status: "starting" },
  );
  const bytes = new TextEncoder().encode(text);
  assert.deepEqual(Pipeline.readJson({ status: 200, body: new DataView(bytes.buffer) }), {
    id: "p1",
    status: "starting",
  });
  assert.deepEqual(Pipeline.readJson({ status: 200, body: new Uint8Array(bytes) }), {
    id: "p1",
    status: "starting",
  });
});

test("generate works when the host returns JSON as a string body", async () => {
  const api = fakeApi({ stringBody: true });
  const source = await Pipeline.captureSource({ api, settings: replicateSettings() });
  const generated = await Pipeline.generate({
    api,
    settings: replicateSettings(),
    source,
    prompt: "a red bicycle",
    seed: 1,
    pollMs: 1,
  });
  assert.equal(generated.image.width, 64);
});

test("a submit without an id fails with the body in the message and logs the response", async () => {
  const api = fakeApi({ noId: true });
  const source = await Pipeline.captureSource({ api, settings: replicateSettings() });
  const lines = [];
  await assert.rejects(
    () =>
      Pipeline.generate({
        api,
        settings: replicateSettings(),
        source,
        prompt: "x",
        seed: 1,
        pollMs: 1,
        log: (line) => lines.push(line),
      }),
    /no prediction id .*Submit body/i,
  );
  assert.ok(lines.some((line) => line.startsWith("submit HTTP 201")), "the submit response is logged");
});


test("readJson returns the already-parsed object Photon puts in body", () => {
  assert.deepEqual(Pipeline.readJson({ status: 200, body: { id: "p1", status: "starting" } }), {
    id: "p1",
    status: "starting",
  });
  assert.deepEqual(Pipeline.readJson({ status: 200, body: { id: "p2" } }).id, "p2");
  assert.equal(Pipeline.readJson({ status: 200, body: null }), null);
  assert.equal(Pipeline.readJson({ status: 200 }), null);
});

test("generate also works when the host hands back the JSON as bytes", async () => {
  const api = fakeApi({ byteBody: true });
  const source = await Pipeline.captureSource({ api, settings: replicateSettings() });
  const generated = await Pipeline.generate({
    api,
    settings: replicateSettings(),
    source,
    prompt: "a harbour at dawn",
    seed: 2,
    pollMs: 1,
  });
  assert.equal(generated.image.width, 64);
});


test("generate sends two references to nano-banana and crops the result back", async () => {
  const api = fakeApi({});
  const settings = replicateSettings({ model: "google/nano-banana-2" });
  const source = await Pipeline.captureSource({ api, settings });
  const generated = await Pipeline.generate({ api, settings, source, prompt: "put a lamp here", seed: 5, pollMs: 1 });
  const submit = api.lastSubmit;
  assert.ok(submit, "submit request captured");
  assert.equal(submit.input.image_input.length, 2, "full layer + selection crop");
  assert.ok(submit.input.image_input[0].startsWith("data:image/png;base64,"));
  assert.ok(submit.input.image_input[1].startsWith("data:image/png;base64,"));
  assert.match(submit.input.prompt, /^Image 1 is the full image for context\. Image 2 is the selected area/);
  assert.equal(submit.input.mask, undefined);
  assert.equal(generated.twoReferences, true);
  assert.equal(generated.image.width, 64, "the result is cropped back to the selection");
  assert.equal(generated.image.height, 48);
});


test("schema-driven payload sends resolution, aspect ratio and temperature", async () => {
  Pipeline.clearSchemaCache();
  const api = fakeApi({});
  const settings = replicateSettings({
    model: "google/nano-banana-2",
    size: "2K",
    aspect: "16:9",
    temperature: 0.6,
  });
  const source = await Pipeline.captureSource({ api, settings });
  await Pipeline.generate({ api, settings, source, prompt: "a rooftop pool", seed: 3, pollMs: 1 });
  const submit = api.lastSubmit;
  assert.equal(submit.input.resolution, "2K");
  assert.equal(submit.input.aspect_ratio, "16:9");
  assert.equal(submit.input.temperature, 0.6);
  assert.equal(submit.input.match_input_image, false);
  assert.equal(submit.input.image_input.length, 2);
});


test("whole-layer generation keeps the provider's native size when applied", async () => {
  const api = fakeApi({ noSelection: true });
  const settings = replicateSettings({ model: "google/nano-banana-2", size: "1K" });
  const source = await Pipeline.captureSource({ api, settings });
  const generated = await Pipeline.generate({ api, settings, source, prompt: "a harbour", seed: 2, pollMs: 1 });
  assert.equal(generated.placement.hasSelection, false);
  assert.equal(generated.image.width, 128);
  assert.equal(generated.image.height, 96);
  assert.equal(generated.placement.bounds.width, 128);
  const outcome = await Pipeline.apply({
    api,
    result: {
      image: generated.image,
      bounds: generated.placement.bounds,
      originX: generated.placement.originX,
      originY: generated.placement.originY,
      captureToken: generated.placement.captureToken,
      mask: generated.placement.mask,
      maskWidth: generated.placement.maskWidth,
      maskHeight: generated.placement.maskHeight,
      hasSelection: false,
      prompt: "x",
      model: "m",
      docId: "doc1",
    },
    name: "native",
  });
  assert.equal(outcome.method, "writePixels");
  assert.equal(api.lastWrite.transfer.options.width, 128);
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
