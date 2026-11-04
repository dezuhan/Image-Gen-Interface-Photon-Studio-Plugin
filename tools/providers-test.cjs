#!/usr/bin/env node
/*
 * Image Gen — provider adapter tests:  node tools/providers-test.cjs
 */
"use strict";

const assert = require("node:assert");
const path = require("node:path");
const Providers = require(path.join(__dirname, "..", "plugin", "providers.js"));

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test("parseModelSpec accepts owner/name and owner/name:version", () => {
  assert.deepEqual(Providers.parseModelSpec("black-forest-labs/flux-fill-dev"), {
    owner: "black-forest-labs",
    name: "flux-fill-dev",
    version: null,
    spec: "black-forest-labs/flux-fill-dev",
  });
  const pinned = Providers.parseModelSpec("stability-ai/sdxl:abc123def456");
  assert.equal(pinned.version, "abc123def456");
  assert.equal(pinned.owner, "stability-ai");
  assert.throws(() => Providers.parseModelSpec("flux"), /owner\/name/);
  assert.throws(() => Providers.parseModelSpec(""), /Set a model/);
});

test("replicateInput only includes the fields that are set", () => {
  const input = Providers.replicateInput({ prompt: "a cat", image: "data:1", mask: "data:2", seed: 7, steps: 20 });
  assert.equal(input.prompt, "a cat");
  assert.equal(input.image, "data:1");
  assert.equal(input.mask, "data:2");
  assert.equal(input.seed, 7);
  assert.equal(input.num_inference_steps, 20);
  assert.equal(input.output_format, "png");
  const bare = Providers.replicateInput({ prompt: "x" });
  assert.equal(bare.image, undefined);
  assert.equal(bare.mask, undefined);
  assert.equal(bare.seed, undefined);
});

test("buildReplicateRequest uses the official model endpoint and the credential", () => {
  const request = Providers.buildReplicateRequest({
    model: "black-forest-labs/flux-fill-dev",
    prompt: "a cat",
    image: "data:image/png;base64,AAA",
  });
  assert.equal(request.url, "https://api.replicate.com/v1/models/black-forest-labs/flux-fill-dev/predictions");
  assert.equal(request.options.method, "POST");
  assert.equal(request.options.headers.Prefer, "wait=60");
  assert.equal(request.options.credential.id, "replicate");
  assert.equal(request.options.credential.header, "Authorization");
  assert.equal(request.options.credential.prefix, "Bearer ");
  assert.equal(request.options.json.input.prompt, "a cat");
});

test("buildReplicateRequest uses the version endpoint for pinned versions and a custom base", () => {
  const request = Providers.buildReplicateRequest({
    base: "https://api.replicate.com/",
    model: "owner/name:abc123def",
    prompt: "x",
  });
  assert.equal(request.url, "https://api.replicate.com/v1/predictions");
  assert.equal(request.options.json.version, "abc123def");
});

test("buildReplicatePoll targets the prediction URL", () => {
  const poll = Providers.buildReplicatePoll({ id: "p1" });
  assert.equal(poll.url, "https://api.replicate.com/v1/predictions/p1");
  assert.equal(poll.options.method, "GET");
});

test("parsePrediction normalises the states and keeps the error", () => {
  assert.equal(Providers.parsePrediction({ status: "succeeded", output: ["u"] }).status, "succeeded");
  assert.equal(Providers.parsePrediction({ status: "starting" }).status, "pending");
  const failed = Providers.parsePrediction({ status: "failed", error: "boom" });
  assert.equal(failed.status, "failed");
  assert.equal(failed.error, "boom");
  assert.equal(Providers.parsePrediction({}).status, "pending");
});

test("replicateImageCandidates handles the output shapes Replicate returns", () => {
  assert.deepEqual(Providers.replicateImageCandidates("https://x/1.png"), ["https://x/1.png"]);
  assert.deepEqual(Providers.replicateImageCandidates(["https://x/1.png", "https://x/2.png"]), [
    "https://x/1.png",
    "https://x/2.png",
  ]);
  assert.deepEqual(Providers.replicateImageCandidates([{ url: "https://x/3.png" }]), ["https://x/3.png"]);
  assert.deepEqual(Providers.replicateImageCandidates(null), []);
});

test("buildCustomRequest renders the default template", () => {
  const request = Providers.buildCustomRequest({
    config: {
      submitUrl: "https://example.com/gen",
      bodyTemplate:
        '{"prompt":"{{prompt}}","image":"{{image}}","mask":"{{mask}}","width":{{width}},"seed":{{seed}}}',
    },
    prompt: 'a "cat"',
    image: "data:image/png;base64,AAA",
    mask: "data:image/png;base64,BBB",
    width: 512,
    height: 512,
    seed: 3,
    model: "m1",
  });
  assert.equal(request.url, "https://example.com/gen");
  assert.equal(request.mode, "immediate");
  assert.equal(request.options.method, "POST");
  assert.equal(request.options.json.prompt, 'a "cat"');
  assert.equal(request.options.json.image, "data:image/png;base64,AAA");
  assert.equal(request.options.json.mask, "data:image/png;base64,BBB");
  assert.equal(request.options.json.width, 512);
  assert.equal(request.options.json.seed, 3);
});

test("buildCustomRequest rejects broken templates and missing URLs", () => {
  assert.throws(
    () => Providers.buildCustomRequest({ config: { submitUrl: "https://x", bodyTemplate: "{nope" }, prompt: "x" }),
    /Body template/,
  );
  assert.throws(
    () => Providers.buildCustomRequest({ config: { submitUrl: "https://x", headersTemplate: "{nope" }, prompt: "x" }),
    /Headers template/,
  );
  assert.throws(() => Providers.buildCustomRequest({ config: { submitUrl: "" }, prompt: "x" }), /custom endpoint URL/);
});

test("buildCustomPoll renders {{id}} and returns null without a poll URL", () => {
  assert.equal(Providers.buildCustomPoll({ config: { pollUrl: "https://x/jobs/{{id}}" }, id: "job1" }).url, "https://x/jobs/job1");
  assert.equal(Providers.buildCustomPoll({ config: {}, id: "job1" }), null);
  assert.throws(
    () => Providers.buildCustomPoll({ config: { pollUrl: "jobs/{{id}}" }, id: "1" }),
    /absolute http/,
  );
});

test("parseCustomResponse handles immediate and polled responses", () => {
  const immediate = Providers.parseCustomResponse({ output: ["https://x/1.png"] }, { mode: "immediate" });
  assert.equal(immediate.status, "succeeded");
  assert.deepEqual(immediate.output, ["https://x/1.png"]);

  const pending = Providers.parseCustomResponse({ id: "j1", status: "running" }, { mode: "poll" });
  assert.equal(pending.status, "pending");
  assert.equal(pending.id, "j1");

  const done = Providers.parseCustomResponse(
    { id: "j1", state: "completed", result: { image: "https://x/2.png" } },
    { mode: "poll", statusPath: "state", successValues: "completed", outputPath: "result.image" },
  );
  assert.equal(done.status, "succeeded");
  assert.equal(done.output, "https://x/2.png");

  const failed = Providers.parseCustomResponse({ status: "failed", error: "bad" }, { mode: "poll" });
  assert.equal(failed.status, "failed");
  assert.equal(failed.error, "bad");
});

test("extractImage finds the image in common payload shapes", () => {
  assert.equal(Providers.extractImage({ output: "https://x/1.png" }), "https://x/1.png");
  assert.equal(Providers.extractImage({ data: [{ b64_json: "QUJD" }] }), "data:image/png;base64,QUJD");
  assert.equal(Providers.extractImage({ images: ["https://x/2.png"] }), "https://x/2.png");
  assert.equal(
    Providers.extractImage({ result: { image: "https://x/3.png" } }, { outputPath: "result.image" }),
    "https://x/3.png",
  );
  assert.equal(Providers.extractImage({}), null);
});

test("normaliseImage distinguishes URLs and data URIs", () => {
  assert.deepEqual(Providers.normaliseImage("https://x/1.png"), { kind: "url", value: "https://x/1.png" });
  assert.equal(Providers.normaliseImage("data:image/png;base64,AAA").kind, "data");
  assert.equal(Providers.normaliseImage("QUJD").value, "data:image/png;base64,QUJD");
  assert.equal(Providers.normaliseImage(""), null);
});

test("downloadRequest asks for bytes", () => {
  const request = Providers.downloadRequest("https://x/1.png");
  assert.equal(request.options.response, "bytes");
  assert.equal(request.options.method, "GET");
});

test("provider registry exposes the two providers and presets", () => {
  assert.equal(Providers.providerInfo("replicate").label, "Replicate");
  assert.equal(Providers.providerInfo("custom").label, "Custom endpoint");
  assert.ok(Providers.MODEL_PRESETS.length >= 3);
  assert.equal(Providers.credentialRef("replicate").id, "replicate");
  assert.equal(Providers.credentialRef("custom"), null);
});


test("nano-banana input uses image_input and never sends a mask", () => {
  const input = Providers.replicateInput({
    model: "google/nano-banana-2",
    prompt: "replace the sky with sunrise",
    image: "data:image/png;base64,AAA",
    image2: "data:image/png;base64,CCC",
    mask: "data:image/png;base64,BBB",
    steps: 40,
    guidance: 7,
    strength: 0.5,
    seed: 12,
  });
  assert.deepEqual(input.image_input, [
    "data:image/png;base64,AAA",
    "data:image/png;base64,CCC",
  ]);
  assert.equal(input.mask, undefined);
  assert.equal(input.num_inference_steps, undefined);
  assert.equal(input.guidance, undefined);
  assert.equal(input.strength, undefined);
  assert.equal(input.match_input_image, true);
  assert.equal(input.output_format, "png");
  assert.equal(input.seed, 12);
});

test("nano-banana text to image omits image_input", () => {
  const input = Providers.replicateInput({ model: "google/nano-banana-2", prompt: "a red fox" });
  assert.deepEqual(input, { prompt: "a red fox", output_format: "png" });
});

test("model families expose mask support", () => {
  assert.equal(Providers.modelFamily("google/nano-banana-2"), "nano-banana");
  assert.equal(Providers.modelFamily("google/nano-banana-pro"), "nano-banana");
  assert.equal(Providers.modelFamily("black-forest-labs/flux-fill-dev"), "standard");
  assert.equal(Providers.supportsMask("google/nano-banana-2"), false);
  assert.equal(Providers.supportsMask("black-forest-labs/flux-fill-dev"), true);
});


test("schema properties decide which optional fields are sent", () => {
  const schema = new Set(["prompt", "image_input", "match_input_image", "aspect_ratio", "resolution", "temperature", "output_format", "seed"]);
  const input = Providers.replicateInput(
    {
      model: "google/nano-banana-2",
      prompt: "x",
      image: "data:1",
      image2: "data:2",
      steps: 30,
      guidance: 5,
      strength: 0.4,
      temperature: 0.7,
      aspectRatio: "16:9",
      resolution: "2K",
      seed: 9,
    },
    schema,
  );
  assert.equal(input.temperature, 0.7);
  assert.equal(input.aspect_ratio, "16:9");
  assert.equal(input.resolution, "2K");
  assert.equal(input.match_input_image, false, "an explicit aspect ratio disables matching");
  assert.equal(input.num_inference_steps, undefined, "the model does not declare steps");
  assert.equal(input.guidance, undefined);
  assert.equal(input.strength, undefined);
  assert.equal(input.mask, undefined);
});

test("parseInputSchema reads the nested Replicate openapi document", () => {
  const payload = {
    latest_version: {
      openapi_schema: {
        components: {
          schemas: {
            Input: { properties: { prompt: {}, image_input: {}, aspect_ratio: {}, resolution: {}, temperature: {} } },
          },
        },
      },
    },
  };
  const props = Providers.parseInputSchema(payload);
  assert.ok(props instanceof Set);
  assert.deepEqual([...props].sort(), ["aspect_ratio", "image_input", "prompt", "resolution", "temperature"]);
  assert.equal(Providers.parseInputSchema({}), null);
});

test("schemaRequest targets the model endpoint", () => {
  const request = Providers.schemaRequest({ model: "google/nano-banana-2" });
  assert.equal(request.url, "https://api.replicate.com/v1/models/google/nano-banana-2");
  assert.equal(request.options.method, "GET");
  assert.equal(request.options.credential.id, "replicate");
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
