/*
 * Image Gen — provider adapters.
 *
 * Replicate requests are shaped from the model's own input schema (fetched with the stored token), so
 * the panel only sends fields that model declares: image_input vs image+mask, steps/guidance names,
 * temperature, aspect_ratio, resolution, output_format, seed. When the schema cannot be read the
 * builder falls back to the model family defaults (Nano Banana references vs mask inpainting).
 *
 * Custom endpoints keep the user-authored JSON template.
 */
(function (root, factory) {
  const core = typeof module === "object" && module.exports ? require("./core.js") : root.PhotonImageGen;
  const mod = factory(core);
  if (typeof module === "object" && module.exports) module.exports = mod;
  else root.PhotonProviders = mod;
})(typeof globalThis !== "undefined" ? globalThis : this, function (Core) {
  "use strict";

  const PROVIDERS = {
    replicate: {
      id: "replicate",
      label: "Replicate",
      base: "https://api.replicate.com",
      credential: { id: "replicate", header: "Authorization", prefix: "Bearer " },
      hint: "Paste a token from replicate.com/account/api-tokens",
      modelHint: "owner/name for official models, or owner/name:version for a pinned version",
    },
    custom: {
      id: "custom",
      label: "Custom endpoint",
      base: "",
      credential: { id: "custom", header: "Authorization", prefix: "Bearer " },
      hint: "Any HTTP endpoint that returns an image URL or base64 payload",
      modelHint: "Free text, exposed to the body template as {{model}}",
    },
  };

  const MODEL_PRESETS = [
    { id: "google/nano-banana-2", label: "Nano Banana 2 — edit & generate" },
    { id: "black-forest-labs/flux-fill-dev", label: "FLUX Fill Dev — inpainting" },
    { id: "black-forest-labs/flux-dev", label: "FLUX Dev — image to image" },
    { id: "black-forest-labs/flux-schnell", label: "FLUX Schnell — fast text to image" },
    { id: "stability-ai/stable-diffusion-inpainting", label: "Stable Diffusion inpainting" },
  ];

  const ASPECT_RATIOS = ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9", "1:4", "4:1", "1:8", "8:1"];

  const CUSTOM_DEFAULTS = {
    submitUrl: "",
    method: "POST",
    bodyTemplate:
      '{\n  "prompt": "{{prompt}}",\n  "image": "{{image}}",\n  "mask": "{{mask}}",\n  "width": {{width}},\n  "height": {{height}},\n  "model": "{{model}}"\n}',
    headersTemplate: "{}",
    mode: "immediate",
    pollUrl: "",
    statusPath: "status",
    successValues: "succeeded,success,completed",
    outputPath: "output",
    idPath: "id",
    errorPath: "error",
    imageSource: "data_uri",
  };

  function providerInfo(id) {
    return PROVIDERS[id] || PROVIDERS.custom;
  }

  function credentialRef(providerId) {
    const provider = providerInfo(providerId);
    return provider.id === "custom" ? null : provider.credential;
  }

  function parseModelSpec(spec) {
    const text = String(spec || "").trim();
    if (!text) throw new Error("Set a model first (owner/name, or owner/name:version).");
    const versionMatch = text.match(/^([^:\s]+):([A-Za-z0-9]{6,})$/) || text.match(/^([^:\s]+)\s+@\s*([A-Za-z0-9]{6,})$/);
    if (versionMatch) {
      const [owner, name] = versionMatch[1].split("/");
      if (!owner || !name) throw new Error("Model must look like owner/name or owner/name:version.");
      return { owner, name, version: versionMatch[2], spec: versionMatch[1] + ":" + versionMatch[2] };
    }
    const [owner, name] = text.split("/");
    if (!owner || !name) throw new Error("Model must look like owner/name or owner/name:version.");
    if (/[|\s]/.test(owner) || /[|\s]/.test(name)) {
      throw new Error("Model contains invalid characters — use a plain owner/name or owner/name:version.");
    }
    return { owner, name, version: null, spec: text };
  }

  /** Nano Banana models take reference images instead of a masked inpainting input. */
  function modelFamily(model) {
    const spec = String(model || "");
    if (/nano-?banana/i.test(spec)) return "nano-banana";
    return "standard";
  }

  function supportsMask(model) {
    return modelFamily(model) === "standard";
  }

  /* ---------- model input schema ---------- */

  function schemaRequest(options) {
    const base = String(options.base || PROVIDERS.replicate.base).replace(/\/+$/, "");
    const spec = parseModelSpec(options.model);
    return {
      url: base + "/v1/models/" + spec.owner + "/" + spec.name,
      options: { method: "GET", headers: {}, credential: PROVIDERS.replicate.credential },
    };
  }

  /** Pull the input property names out of a /v1/models/{owner}/{name} response. */
  function parseInputSchema(payload) {
    const version = payload && payload.latest_version ? payload.latest_version : null;
    const openapi = (version && version.openapi_schema) || (payload && payload.openapi_schema) || null;
    if (!openapi) return null;
    const schemas = openapi.components && openapi.components.schemas ? openapi.components.schemas : null;
    if (!schemas) return null;
    const names = Object.keys(schemas);
    const inputName = names.find((name) => /^input$/i.test(name)) || names.find((name) => /input/i.test(name)) || names[0];
    const properties = schemas[inputName] && schemas[inputName].properties;
    if (!properties || typeof properties !== "object") return null;
    const set = new Set(Object.keys(properties));
    // Replicate commonly wraps the real inputs in a single "input" property.
    const nested = properties.input && properties.input.properties;
    if (nested && typeof nested === "object") return new Set(Object.keys(nested));
    return set;
  }

  /**
   * Build the Replicate `input` object.
   * `properties` is the model's declared input set (null when unknown → family fallback).
   */
  function replicateInput(request, properties) {
    const declared = properties instanceof Set ? properties : null;
    const family = modelFamily(request.model);
    const familyFallback = family === "nano-banana"
      ? new Set(["prompt", "image_input", "match_input_image", "output_format", "seed", "aspect_ratio"])
      : null;
    const can = (name) => (declared ? declared.has(name) : familyFallback ? familyFallback.has(name) : true);

    const references = [request.image, request.image2].filter(Boolean);
    const wantsReferences = declared ? declared.has("image_input") : family === "nano-banana";
    const input = { prompt: request.prompt };

    if (wantsReferences) {
      if (can("image_input") && references.length) input.image_input = references;
      if (can("match_input_image") && references.length) {
        input.match_input_image = !request.aspectRatio || request.aspectRatio === "auto";
      }
    } else {
      if (request.image && can("image")) input.image = request.image;
      if (request.mask && can("mask")) input.mask = request.mask;
    }

    if (request.seed !== null && request.seed !== undefined && request.seed !== "" && can("seed")) {
      input.seed = Number(request.seed);
    }

    const stepsKey = declared
      ? declared.has("num_inference_steps") ? "num_inference_steps" : declared.has("steps") ? "steps" : null
      : can("num_inference_steps") ? "num_inference_steps" : can("steps") ? "steps" : null;
    if (stepsKey && Number.isFinite(request.steps)) input[stepsKey] = Math.round(request.steps);

    const guidanceKey = declared
      ? declared.has("guidance") ? "guidance" : declared.has("guidance_scale") ? "guidance_scale" : declared.has("cfg_scale") ? "cfg_scale" : null
      : can("guidance") ? "guidance" : can("guidance_scale") ? "guidance_scale" : null;
    if (guidanceKey && Number.isFinite(request.guidance)) input[guidanceKey] = request.guidance;

    if (Number.isFinite(request.strength) && can("strength")) input.strength = request.strength;
    if (Number.isFinite(request.temperature) && can("temperature")) input.temperature = request.temperature;

    if (request.aspectRatio && request.aspectRatio !== "auto" && can("aspect_ratio")) {
      input.aspect_ratio = request.aspectRatio;
    }
    if (request.resolution && can("resolution")) input.resolution = request.resolution;

    if (can("output_format")) input.output_format = "png";
    return input;
  }

  function buildReplicateRequest(options) {
    const base = String(options.base || PROVIDERS.replicate.base).replace(/\/+$/, "");
    const spec = parseModelSpec(options.model);
    const input = replicateInput(options, options.properties);
    const headers = { Prefer: "wait=60" };
    if (spec.version) {
      return {
        provider: "replicate",
        mode: "prediction",
        url: base + "/v1/predictions",
        options: {
          method: "POST",
          json: { version: spec.version, input },
          headers,
          credential: PROVIDERS.replicate.credential,
        },
      };
    }
    return {
      provider: "replicate",
      mode: "prediction",
      url: base + "/v1/models/" + spec.owner + "/" + spec.name + "/predictions",
      options: {
        method: "POST",
        json: { input },
        headers,
        credential: PROVIDERS.replicate.credential,
      },
    };
  }

  function buildReplicatePoll(options) {
    const base = String(options.base || PROVIDERS.replicate.base).replace(/\/+$/, "");
    return {
      url: base + "/v1/predictions/" + encodeURIComponent(options.id),
      options: { method: "GET", headers: {}, credential: PROVIDERS.replicate.credential },
    };
  }

  function parsePrediction(payload) {
    const body = payload || {};
    return {
      id: body.id || null,
      status: Core.statusOf(body.status),
      rawStatus: body.status || "",
      output: body.output,
      error: body.error || (body.status === "failed" ? "prediction failed" : null),
      pollUrl: body.urls && body.urls.get ? body.urls.get : null,
    };
  }

  function replicateImageCandidates(output) {
    if (!output) return [];
    if (typeof output === "string") return [output];
    if (Array.isArray(output)) {
      return output
        .filter((item) => typeof item === "string" || (item && typeof item.url === "string"))
        .map((item) => (typeof item === "string" ? item : item.url));
    }
    if (typeof output === "object" && typeof output.url === "string") return [output.url];
    return [];
  }

  /* ---------- custom endpoint ---------- */

  function buildCustomRequest(options) {
    const config = { ...CUSTOM_DEFAULTS, ...(options.config || {}) };
    const url = String(config.submitUrl || options.base || "").trim();
    if (!url) throw new Error("Set the custom endpoint URL in Settings.");
    const vars = {
      prompt: options.prompt,
      image: options.image,
      mask: options.mask,
      width: options.width,
      height: options.height,
      seed: options.seed === null || options.seed === undefined || options.seed === "" ? 0 : options.seed,
      model: options.model || "",
    };
    let headers = {};
    try {
      headers = config.headersTemplate ? Core.parseJsonTemplate(config.headersTemplate, vars) : {};
    } catch {
      throw new Error("Headers template is not valid JSON.");
    }
    let json;
    try {
      json = Core.parseJsonTemplate(config.bodyTemplate, vars);
    } catch {
      throw new Error("Body template is not valid JSON after the placeholders were filled in.");
    }
    return {
      provider: "custom",
      mode: config.mode === "poll" ? "poll" : "immediate",
      url,
      options: {
        method: String(config.method || "POST").toUpperCase(),
        json,
        headers,
        ...(config.useCredential ? { credential: PROVIDERS.custom.credential } : {}),
      },
      config,
    };
  }

  function buildCustomPoll(options) {
    const config = { ...CUSTOM_DEFAULTS, ...(options.config || {}) };
    if (!config.pollUrl || !options.id) return null;
    const url = Core.renderTemplate(config.pollUrl, { id: options.id });
    if (!/^https?:/i.test(url)) throw new Error("Poll URL must be an absolute http(s) URL.");
    return {
      url,
      options: { method: "GET", headers: {}, ...(config.useCredential ? { credential: PROVIDERS.custom.credential } : {}) },
    };
  }

  function parseCustomResponse(payload, configInput) {
    const config = { ...CUSTOM_DEFAULTS, ...(configInput || {}) };
    const body = payload || {};
    const rawStatus = Core.getPath(body, config.statusPath);
    const successValues = String(config.successValues || "")
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean);
    let status = "succeeded";
    if (config.mode === "poll") {
      const value = String(rawStatus === undefined ? "" : rawStatus).toLowerCase();
      if (successValues.length && successValues.includes(value)) status = "succeeded";
      else if (value && /fail|error|cancel/.test(value)) status = "failed";
      else status = "pending";
    }
    return {
      id: Core.getPath(body, config.idPath || "id") || null,
      status,
      rawStatus,
      output: Core.getPath(body, config.outputPath || "output"),
      error: Core.getPath(body, config.errorPath || "error") || null,
    };
  }

  function extractImage(payload, config) {
    const body = payload || {};
    const candidates = [];
    const configOutput = config ? Core.getPath(body, config.outputPath || "output") : undefined;
    if (configOutput !== undefined) candidates.push(configOutput);
    candidates.push(body.output, body.image, body.url, body.data, body.images, body.result);
    const direct = Core.firstImageCandidate(body, [
      "output",
      "image",
      "url",
      "images[0].url",
      "data[0].url",
      "data[0].b64_json",
      "result.url",
    ]);
    if (direct) {
      return /^https?:|^data:/i.test(direct) ? direct : Core.dataUri("image/png", direct);
    }
    for (const candidate of candidates) {
      if (typeof candidate === "string" && candidate) return candidate;
      if (Array.isArray(candidate)) {
        for (const item of candidate) {
          if (typeof item === "string" && item) return item;
          if (item && typeof item.url === "string") return item.url;
          if (item && typeof item.b64_json === "string") return Core.dataUri("image/png", item.b64_json);
        }
      }
      if (candidate && typeof candidate === "object" && typeof candidate.url === "string") return candidate.url;
    }
    return null;
  }

  /** Normalise a provider image value into something Photon/network can use. */
  function normaliseImage(value, imageSource) {
    if (!value) return null;
    if (/^https?:/i.test(value)) return { kind: "url", value };
    if (/^data:/i.test(value)) return { kind: "data", value };
    if (imageSource === "base64") return { kind: "data", value: Core.dataUri("image/png", value) };
    return { kind: "data", value: Core.dataUri("image/png", value) };
  }

  function downloadRequest(url) {
    return { url, options: { method: "GET", response: "bytes", headers: {} } };
  }

  return {
    PROVIDERS,
    MODEL_PRESETS,
    CUSTOM_DEFAULTS,
    ASPECT_RATIOS,
    providerInfo,
    credentialRef,
    parseModelSpec,
    modelFamily,
    supportsMask,
    schemaRequest,
    parseInputSchema,
    replicateInput,
    buildReplicateRequest,
    buildReplicatePoll,
    parsePrediction,
    replicateImageCandidates,
    buildCustomRequest,
    buildCustomPoll,
    parseCustomResponse,
    extractImage,
    normaliseImage,
    downloadRequest,
  };
});
