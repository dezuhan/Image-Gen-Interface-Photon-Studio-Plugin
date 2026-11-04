/*
 * Image Gen — provider adapters.
 *
 * Two providers, one interface: build the submit request, build the poll request (when the provider
 * is asynchronous), parse a response into { id, status, output, error }, and turn the output into an
 * image URL or data URI.
 *
 * Replicate: POST /v1/models/{owner}/{name}/predictions (official models) or POST /v1/predictions
 * with a version hash (community models), then GET /v1/predictions/{id}. The API key never touches
 * plugin settings: it is referenced through Photon's credential vault.
 *
 * Custom endpoint: user-supplied JSON body template, polling template and JSON paths.
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
    { id: "black-forest-labs/flux-fill-dev", label: "FLUX Fill Dev — inpainting" },
    { id: "black-forest-labs/flux-dev", label: "FLUX Dev — image to image" },
    { id: "black-forest-labs/flux-schnell", label: "FLUX Schnell — fast text to image" },
    { id: "stability-ai/stable-diffusion-inpainting", label: "Stable Diffusion inpainting" },
  ];

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
    return { owner, name, version: null, spec: text };
  }

  /** Replicate input object; key names follow the common image-model schemas. */
  function replicateInput(request) {
    const input = { prompt: request.prompt };
    if (request.image) input.image = request.image;
    if (request.mask) input.mask = request.mask;
    if (request.seed !== null && request.seed !== undefined && request.seed !== "") input.seed = Number(request.seed);
    if (Number.isFinite(request.steps)) input.num_inference_steps = Math.round(request.steps);
    if (Number.isFinite(request.guidance)) input.guidance = request.guidance;
    if (Number.isFinite(request.strength)) input.strength = request.strength;
    if (request.aspectRatio) input.aspect_ratio = request.aspectRatio;
    input.output_format = "png";
    return input;
  }

  function buildReplicateRequest(options) {
    const base = String(options.base || PROVIDERS.replicate.base).replace(/\/+$/, "");
    const spec = parseModelSpec(options.model);
    const input = replicateInput(options);
    const headers = { Prefer: "wait=60" };
    if (spec.version) {
      return {
        provider: "replicate",
        mode: "prediction",
        url: base + "/v1/predictions",
        options: { method: "POST", json: { version: spec.version, input }, headers, credential: PROVIDERS.replicate.credential },
      };
    }
    return {
      provider: "replicate",
      mode: "prediction",
      url: base + "/v1/models/" + spec.owner + "/" + spec.name + "/predictions",
      options: { method: "POST", json: { input }, headers, credential: PROVIDERS.replicate.credential },
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
      return output.filter((item) => typeof item === "string" || (item && typeof item.url === "string")).map((item) => (typeof item === "string" ? item : item.url));
    }
    if (typeof output === "object" && typeof output.url === "string") return [output.url];
    return [];
  }

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
    } catch (error) {
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
    let headers = {};
    try {
      headers = config.headersTemplate ? JSON.parse(Core.renderTemplate(config.headersTemplate, { id: options.id })) : {};
    } catch {
      headers = {};
    }
    return {
      url,
      options: { method: "GET", headers, ...(config.useCredential ? { credential: PROVIDERS.custom.credential } : {}) },
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
    const direct = Core.firstImageCandidate(body, ["output", "image", "url", "images[0].url", "data[0].url", "data[0].b64_json", "result.url"]);
    if (direct) {
      // A bare base64 string from OpenAI-style payloads still needs the data URI wrapper.
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
    if (imageSource === "base64" || !/^[A-Za-z0-9+/=\s]+$/.test(value) === false) {
      return { kind: "data", value: Core.dataUri("image/png", value) };
    }
    return { kind: "data", value: Core.dataUri("image/png", value) };
  }

  function downloadRequest(url) {
    return { url, options: { method: "GET", response: "bytes", headers: {} } };
  }

  return {
    PROVIDERS,
    MODEL_PRESETS,
    CUSTOM_DEFAULTS,
    providerInfo,
    credentialRef,
    parseModelSpec,
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
