/*
 * Image Gen — generation pipeline.
 *
 * The document work behind the panel, kept free of DOM access so it can be tested headless with a
 * fake Photon SDK:
 *
 *   captureSource  → read the selected layer (+ selection coverage when Photon exposes it)
 *   generate       → encode base image + mask, call the provider, decode the returned image
 *   apply          → write the result back with applyImage(captureToken) or a masked layer fallback
 *
 * The api object is exactly the plugin SDK (`api.documents.*`, `api.images.*`, `api.network.*`).
 */
(function (root, factory) {
  const core = typeof module === "object" && module.exports ? require("./core.js") : root.PhotonImageGen;
  const providers = typeof module === "object" && module.exports ? require("./providers.js") : root.PhotonProviders;
  const mod = factory(core, providers);
  if (typeof module === "object" && module.exports) module.exports = mod;
  else root.PhotonPipeline = mod;
})(typeof globalThis !== "undefined" ? globalThis : this, function (Core, Providers) {
  "use strict";

  const POLL_MS = 1500;
  const POLL_LIMIT_MS = 180000;

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function errText(error) {
    return String((error && error.message) || error || "unknown error");
  }

  function toRgba(pixels, components, width, height) {
    if (components === 4) return pixels instanceof Uint8Array ? pixels : new Uint8Array(pixels);
    const out = new Uint8Array(width * height * 4);
    for (let index = 0; index < width * height; index += 1) {
      const from = index * components;
      if (components === 1) {
        const value = pixels[from];
        out[index * 4] = value;
        out[index * 4 + 1] = value;
        out[index * 4 + 2] = value;
        out[index * 4 + 3] = 255;
      } else {
        out[index * 4] = pixels[from];
        out[index * 4 + 1] = pixels[from + 1];
        out[index * 4 + 2] = pixels[from + 2];
        out[index * 4 + 3] = 255;
      }
    }
    return out;
  }

  function cropRgba(pixels, width, height, bounds) {
    const out = new Uint8Array(bounds.width * bounds.height * 4);
    for (let y = 0; y < bounds.height; y += 1) {
      const sourceY = bounds.y + y;
      if (sourceY < 0 || sourceY >= height) continue;
      for (let x = 0; x < bounds.width; x += 1) {
        const sourceX = bounds.x + x;
        if (sourceX < 0 || sourceX >= width) continue;
        const from = (sourceY * width + sourceX) * 4;
        const to = (y * bounds.width + x) * 4;
        out[to] = pixels[from];
        out[to + 1] = pixels[from + 1];
        out[to + 2] = pixels[from + 2];
        out[to + 3] = pixels[from + 3];
      }
    }
    return out;
  }

  function resizeNearest(source, sourceWidth, sourceHeight, width, height) {
    const out = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y += 1) {
      const sourceY = Math.min(sourceHeight - 1, Math.floor((y * sourceHeight) / height));
      for (let x = 0; x < width; x += 1) {
        const sourceX = Math.min(sourceWidth - 1, Math.floor((x * sourceWidth) / width));
        const from = (sourceY * sourceWidth + sourceX) * 4;
        const to = (y * width + x) * 4;
        out[to] = source[from];
        out[to + 1] = source[from + 1];
        out[to + 2] = source[from + 2];
        out[to + 3] = source[from + 3];
      }
    }
    return out;
  }

  /** High-quality resize through a canvas; nearest-neighbour when there is no DOM (tests). */
  function resizeRgba(source, sourceWidth, sourceHeight, width, height) {
    if (sourceWidth === width && sourceHeight === height) return source;
    if (typeof document === "undefined") return resizeNearest(source, sourceWidth, sourceHeight, width, height);
    const canvas = document.createElement("canvas");
    canvas.width = sourceWidth;
    canvas.height = sourceHeight;
    const sourceCtx = canvas.getContext("2d");
    sourceCtx.putImageData(new ImageData(new Uint8ClampedArray(source), sourceWidth, sourceHeight), 0, 0);
    const target = document.createElement("canvas");
    target.width = width;
    target.height = height;
    const targetCtx = target.getContext("2d");
    targetCtx.imageSmoothingEnabled = true;
    targetCtx.imageSmoothingQuality = "high";
    targetCtx.drawImage(canvas, 0, 0, width, height);
    const data = targetCtx.getImageData(0, 0, width, height);
    return new Uint8Array(data.data.buffer.slice(0));
  }

  /**
   * Photon's network.request already JSON-parses the body unless `response: "bytes"` was asked for:
   *
   *   body = a.response === "bytes" ? bytes : JSON.parse(bytes)
   *
   * So a JSON reply arrives as a plain object. The helpers below accept the object as-is and still
   * tolerate the other shapes a build might hand back (string, ArrayBuffer, typed view).
   */
  function isBinary(body) {
    return body instanceof ArrayBuffer || ArrayBuffer.isView(body);
  }

  function bodyToText(body) {
    if (body === null || body === undefined) return "";
    if (typeof body === "string") return body;
    if (isBinary(body)) {
      if (body instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(body));
      return new TextDecoder().decode(new Uint8Array(body.buffer, body.byteOffset, body.byteLength));
    }
    if (typeof body === "object") {
      try {
        return JSON.stringify(body);
      } catch {
        return "";
      }
    }
    return String(body);
  }

  function readJson(reply) {
    if (!reply) return null;
    if (reply.json !== undefined && reply.json !== null) return reply.json;
    const body = reply.body;
    if (body === null || body === undefined) return null;
    // The common case: the SDK already parsed the JSON and put the object in `body`.
    if (typeof body === "object" && !isBinary(body)) return body;
    const text = bodyToText(body).trim();
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  function readText(reply) {
    return bodyToText(reply && reply.body).slice(0, 400);
  }

  function preview(reply) {
    const body = reply && reply.body;
    const shape = body === null || body === undefined
      ? "no body"
      : isBinary(body)
        ? body.byteLength + " bytes"
        : typeof body === "object"
          ? "parsed JSON"
          : typeof body;
    const type = (reply && reply.headers && (reply.headers["content-type"] || reply.headers["Content-Type"])) || "";
    const text = readText(reply);
    return "HTTP " + (reply && reply.status) + (type ? " " + type : "") + " · " + shape + (text ? " · " + text.slice(0, 200) : "");
  }

  async function ensureOrigin(api, url) {
    try {
      await api.network.allowEndpoint(new URL(url).origin);
    } catch {
      /* static origins are already declared in the manifest */
    }
  }

  async function encodeDataUri(api, width, height, pixels) {
    const encoded = await api.images.encode({ width, height, pixels }, { maxEdge: Core.MAX_EDGE });
    return Core.dataUri("image/png", Core.bytesToBase64(encoded.bytes));
  }

  /* ---------- source ---------- */

  async function captureSource(options) {
    const api = options.api;
    const settings = options.settings || {};
    const doc = await api.documents.active();
    if (!doc) throw new Error("No active document. Open an image in Photon first.");
    const selected = Array.isArray(doc.selectedLayerIds) ? doc.selectedLayerIds : [];
    const layerId = selected[selected.length - 1];
    if (!layerId) throw new Error("Select a layer in the Layers panel first.");

    let capture = null;
    if (doc.hasSelection) {
      try {
        capture = await api.documents.capture({});
      } catch {
        capture = null;
      }
    }

    let read;
    try {
      read = await api.documents.pixels({ layerId });
    } catch (error) {
      throw new Error(
        /no allocated pixels|oversized/i.test(errText(error))
          ? "This layer has no pixel data. Rasterize it or pick the original layer."
          : errText(error),
      );
    }

    const info = read.options || {};
    const layerWidth = info.width || 0;
    const layerHeight = info.height || 0;
    if (!layerWidth || !layerHeight) throw new Error("This layer has no pixels to generate from.");
    if ((info.componentSize || 8) !== 8) throw new Error("Convert the layer to 8-bit before generating.");
    const layerPixels = toRgba(read.pixels, info.components || 4, layerWidth, layerHeight);
    const originX = (read.sourceBounds && read.sourceBounds.left) || 0;
    const originY = (read.sourceBounds && read.sourceBounds.top) || 0;

    // Selection rectangle in layer pixels; captured pixels are used for the crop and the mask.
    let bounds = null;
    if (capture && capture.bounds) {
      const left = Math.round(capture.bounds.x - originX);
      const top = Math.round(capture.bounds.y - originY);
      bounds = {
        x: Math.max(0, Math.min(layerWidth - 1, left)),
        y: Math.max(0, Math.min(layerHeight - 1, top)),
        width: Math.max(1, Math.round(capture.bounds.width)),
        height: Math.max(1, Math.round(capture.bounds.height)),
      };
      bounds.width = Math.min(bounds.width, layerWidth - bounds.x);
      bounds.height = Math.min(bounds.height, layerHeight - bounds.y);
    }
    if (!bounds) bounds = { x: 0, y: 0, width: layerWidth, height: layerHeight };

    let mask;
    if (capture && capture.mask && capture.mask.length >= bounds.width * bounds.height) {
      mask = capture.mask.length >= bounds.width * bounds.height * 4
        ? Core.maskFromAlpha(capture.mask, 4, bounds.width, bounds.height)
        : Core.maskFromCoverage(capture.mask, bounds.width, bounds.height);
    } else {
      mask = Core.solidMask(bounds.width, bounds.height);
    }

    const margin = Core.clamp(settings.margin, 0, 256);
    if (margin > 0) {
      const expanded = Core.expandBounds(bounds, margin, layerWidth, layerHeight);
      const expandedMask = new Uint8Array(expanded.width * expanded.height * 4);
      for (let y = 0; y < bounds.height; y += 1) {
        for (let x = 0; x < bounds.width; x += 1) {
          const targetX = bounds.x + x - expanded.x;
          const targetY = bounds.y + y - expanded.y;
          if (targetX < 0 || targetY < 0 || targetX >= expanded.width || targetY >= expanded.height) continue;
          const from = (y * bounds.width + x) * 4;
          const to = (targetY * expanded.width + targetX) * 4;
          expandedMask[to] = mask[from];
          expandedMask[to + 1] = mask[from + 1];
          expandedMask[to + 2] = mask[from + 2];
          expandedMask[to + 3] = mask[from + 3];
        }
      }
      bounds = expanded;
      mask = expandedMask;
    }

    return {
      doc,
      layerId,
      originX,
      originY,
      layerWidth,
      layerHeight,
      layerPixels,
      bounds,
      pixels: cropRgba(layerPixels, layerWidth, layerHeight, bounds),
      width: bounds.width,
      height: bounds.height,
      mask,
      maskWidth: bounds.width,
      maskHeight: bounds.height,
      captureToken: capture && capture.token ? capture.token : null,
      hasSelection: Boolean(doc.hasSelection),

    };
  }

  /* ---------- provider calls ---------- */

  async function downloadImage(api, url) {
    await ensureOrigin(api, url);
    const reply = await api.network.request({ url, method: "GET", response: "bytes" });
    if (reply.status !== 200) throw new Error("Downloading the result failed with HTTP " + reply.status);
    return reply.body instanceof Uint8Array ? reply.body : new Uint8Array(reply.body);
  }

  async function requestReplicate(context) {
    const { api, settings, payload, progress, isCancelled } = context;
    const pollMs = context.pollMs || POLL_MS;
    const pollLimit = context.pollLimitMs || POLL_LIMIT_MS;
    const log = context.log || (() => {});
    const base = settings.baseUrl || Providers.PROVIDERS.replicate.base;
    const submit = Providers.buildReplicateRequest({ base, ...payload, properties: context.properties || null });
    await ensureOrigin(api, submit.url);
    progress(0.45, "Submitting to Replicate…");
    const response = await api.network.request({ url: submit.url, ...submit.options });
    context.log("submit " + preview(response));
    if (response.status < 200 || response.status >= 300) {
      const detail = readText(response);
      throw new Error("Replicate rejected the request (HTTP " + response.status + ")" + (detail ? ": " + detail : ""));
    }
    const submitted = readJson(response);
    let prediction = Providers.parsePrediction(submitted);
    if (!prediction.id) {
      throw new Error(
        "Replicate accepted the request but returned no prediction id (" +
          preview(response) + "). Submit body: " + JSON.stringify(submitted || null).slice(0, 300),
      );
    }
    const started = Date.now();
    while (prediction.status === "pending") {
      if (isCancelled()) throw new Error("cancelled by the user");
      if (Date.now() - started > pollLimit) throw new Error("The prediction did not finish in time.");
      await sleep(pollMs);
      if (isCancelled()) throw new Error("cancelled by the user");
      const poll = Providers.buildReplicatePoll({ base, id: prediction.id });
      const next = await api.network.request({ url: poll.url, ...poll.options });
      if (next.status < 200 || next.status >= 300) {
        const detail = readText(next);
        throw new Error("Polling failed (HTTP " + next.status + ")" + (detail ? ": " + detail : ""));
      }
      prediction = Providers.parsePrediction(readJson(next));
      progress(0.5 + Math.min(0.35, ((Date.now() - started) / pollLimit) * 0.35), "Generating… " + (prediction.rawStatus || ""));
    }
    if (prediction.status === "failed") throw new Error(prediction.error || "The prediction failed.");
    const candidates = Providers.replicateImageCandidates(prediction.output);
    if (!candidates.length) throw new Error("The provider returned no image.");
    return candidates[0];
  }

  async function requestCustom(context) {
    const { api, settings, payload, progress, isCancelled } = context;
    const pollMs = context.pollMs || POLL_MS;
    const pollLimit = context.pollLimitMs || POLL_LIMIT_MS;
    const log = context.log || (() => {});
    const config = settings.custom;
    const submit = Providers.buildCustomRequest({ config, base: settings.baseUrl, ...payload });
    await ensureOrigin(api, submit.url);
    progress(0.45, "Submitting to the endpoint…");
    const response = await api.network.request({ url: submit.url, ...submit.options });
    context.log("submit " + preview(response));
    if (response.status < 200 || response.status >= 300) {
      const detail = readText(response);
      throw new Error("The endpoint rejected the request (HTTP " + response.status + ")" + (detail ? ": " + detail : ""));
    }
    let body = readJson(response);
    let parsed = Providers.parseCustomResponse(body, config);
    const started = Date.now();
    while (parsed.status === "pending") {
      if (isCancelled()) throw new Error("cancelled by the user");
      if (Date.now() - started > pollLimit) throw new Error("The endpoint did not finish in time.");
      await sleep(pollMs);
      if (isCancelled()) throw new Error("cancelled by the user");
      const poll = Providers.buildCustomPoll({ config, id: parsed.id });
      if (!poll) throw new Error("The endpoint is asynchronous but no Poll URL is configured.");
      const next = await api.network.request({ url: poll.url, ...poll.options });
      if (next.status < 200 || next.status >= 300) {
        const detail = readText(next);
        throw new Error("Polling failed (HTTP " + next.status + ")" + (detail ? ": " + detail : ""));
      }
      body = readJson(next);
      parsed = Providers.parseCustomResponse(body, config);
      progress(0.5 + Math.min(0.35, ((Date.now() - started) / pollLimit) * 0.35), "Waiting for the endpoint…");
    }
    if (parsed.status === "failed") throw new Error(parsed.error || "The endpoint reported a failure.");
    const image = Providers.extractImage(body, config) ||
      (parsed.output && typeof parsed.output === "string" ? parsed.output : null);
    if (!image) throw new Error("The endpoint response contains no image (check Output path).");
    return image;
  }

  const schemaCache = new Map();

  function clearSchemaCache() {
    schemaCache.clear();
  }

  /** Read the model's declared input names once; fall back to null (family defaults) on failure. */
  async function loadSchema(context) {
    const settings = context.settings;
    if (settings.provider !== "replicate") return null;
    const key = settings.model;
    if (schemaCache.has(key)) return schemaCache.get(key);
    try {
      const request = Providers.schemaRequest({ base: settings.baseUrl, model: settings.model });
      const reply = await context.api.network.request({ url: request.url, ...request.options });
      const properties = reply.status === 200 ? Providers.parseInputSchema(readJson(reply)) : null;
      schemaCache.set(key, properties);
      context.log("schema " + (properties ? [...properties].join(", ") : "unavailable"));
      return properties;
    } catch (error) {
      schemaCache.set(key, null);
      context.log("schema unavailable: " + errText(error));
      return null;
    }
  }

  async function decodeImageValue(api, value, imageSource) {
    const normalized = Providers.normaliseImage(value, imageSource);
    if (!normalized) throw new Error("The provider returned no image.");
    const bytes = normalized.kind === "url"
      ? await downloadImage(api, normalized.value)
      : Core.base64ToBytes(normalized.value.split(",").pop());
    const decoded = await api.images.decode(bytes);
    return { width: decoded.width, height: decoded.height, pixels: decoded.pixels };
  }

  /* ---------- generate / apply ---------- */

  async function generate(options) {
    const api = options.api;
    const settings = options.settings;
    const progress = options.progress || (() => {});
    const isCancelled = options.isCancelled || (() => false);
    const source = options.source || (await captureSource({ api, settings }));
    const log = options.log || (() => {});
    const schema = await loadSchema({ api, settings, log });
    const family = settings.provider === "replicate" ? Providers.modelFamily(settings.model) : "standard";
    const referenceModel = schema ? schema.has("image_input") : family === "nano-banana";
    const twoReferences = settings.provider === "replicate" && referenceModel && source.hasSelection && Boolean(source.captureToken);
    const SIZE_PIXELS = { "1K": 1024, "2K": 2048, "4K": 4096 };
    const sizeKey = settings.size || "auto";
    const numericSize = Number(sizeKey);
    const targetSize = SIZE_PIXELS[sizeKey] || (Number.isFinite(numericSize) && numericSize > 0
      ? numericSize
      : Math.min(Core.WORK_SIZES[2], Math.max(512, Core.roundTo(Math.max(source.width, source.height), 64))));
    const resolution = SIZE_PIXELS[sizeKey] ? sizeKey : null;

    progress(0.14, "Encoding…");
    let imageUri;
    let image2Uri = null;
    let maskUri = null;
    let plan;
    let outputPlan;

    if (twoReferences) {
      // Reference 1 = full selected layer (context), reference 2 = the selected crop (target area).
      plan = Core.planSize(source.layerWidth, source.layerHeight, targetSize, Core.MAX_PIXELS);
      const fullImage = resizeRgba(source.layerPixels, source.layerWidth, source.layerHeight, plan.width, plan.height);
      imageUri = await encodeDataUri(api, plan.width, plan.height, fullImage);
      const cropPlan = Core.planSize(source.width, source.height, targetSize, Core.MAX_PIXELS);
      const cropImage = resizeRgba(source.pixels, source.width, source.height, cropPlan.width, cropPlan.height);
      image2Uri = await encodeDataUri(api, cropPlan.width, cropPlan.height, cropImage);
      outputPlan = { width: plan.width, height: plan.height };
      progress(0.2, "Encoded the layer and the selection…");
    } else {
      plan = Core.planSize(source.width, source.height, targetSize, Core.MAX_PIXELS);
      const baseImage = resizeRgba(source.pixels, source.width, source.height, plan.width, plan.height);
      const sendMask = settings.provider === "custom" || (schema ? schema.has("mask") : Providers.supportsMask(settings.model));
      const maskImage = sendMask
        ? Core.scaleMask(source.mask, source.maskWidth, source.maskHeight, plan.width, plan.height)
        : null;
      imageUri = await encodeDataUri(api, plan.width, plan.height, baseImage);
      maskUri = maskImage ? await encodeDataUri(api, plan.width, plan.height, maskImage) : null;
      outputPlan = { width: plan.width, height: plan.height };
    }

    const bare = imageUri.split(",").pop();
    const bareMask = maskUri ? maskUri.split(",").pop() : null;
    const useBare = settings.custom && settings.custom.imageSource === "base64";
    const contextPrefix = twoReferences
      ? "Image 1 is the full image for context. Image 2 is the selected area that must be regenerated. "
      : "";
    const payload = {
      model: settings.model,
      prompt: contextPrefix + options.prompt,
      image: useBare ? bare : imageUri,
      image2: image2Uri ? (useBare ? image2Uri.split(",").pop() : image2Uri) : null,
      mask: maskUri ? (useBare ? bareMask : maskUri) : null,
      width: outputPlan.width,
      height: outputPlan.height,
      seed: options.seed,
      steps: settings.steps,
      guidance: settings.guidance,
      strength: settings.strength,
      temperature: settings.temperature,
      aspectRatio: settings.aspect,
      resolution,
    };

    const timing = { pollMs: options.pollMs, pollLimitMs: options.pollLimitMs };
    const imageValue = settings.provider === "custom"
      ? await requestCustom({ api, settings, payload, progress, isCancelled, log, ...timing })
      : await requestReplicate({ api, settings, payload, progress, isCancelled, log, properties: schema, ...timing });

    progress(0.88, "Downloading the result…");
    const generated = await decodeImageValue(api, imageValue, settings.custom && settings.custom.imageSource);
    let fitted;
    if (twoReferences) {
      // The model returns the edited full image: cut the selection region back out before applying.
      const layerAspect = source.layerWidth / source.layerHeight;
      const cropAspect = source.width / source.height;
      const outputAspect = generated.width / generated.height;
      const treatAsLayer = Math.abs(outputAspect - layerAspect) <= Math.abs(outputAspect - cropAspect);
      if (treatAsLayer) {
        const scaleX = generated.width / source.layerWidth;
        const scaleY = generated.height / source.layerHeight;
        const region = {
          x: Math.max(0, Math.round(source.bounds.x * scaleX)),
          y: Math.max(0, Math.round(source.bounds.y * scaleY)),
          width: Math.max(1, Math.round(source.width * scaleX)),
          height: Math.max(1, Math.round(source.height * scaleY)),
        };
        region.width = Math.min(region.width, generated.width - region.x);
        region.height = Math.min(region.height, generated.height - region.y);
        const crop = cropRgba(generated.pixels, generated.width, generated.height, region);
        fitted = resizeRgba(crop, region.width, region.height, source.width, source.height);
      } else {
        fitted = resizeRgba(generated.pixels, generated.width, generated.height, source.width, source.height);
      }
    } else {
      fitted = resizeRgba(generated.pixels, generated.width, generated.height, source.width, source.height);
    }

    // Whole-layer generation keeps the provider's native size instead of stretching it onto the
    // layer's rectangle; selection edits must map back onto the capture bounds.
    const native = !twoReferences && !source.hasSelection;
    if (native) {
      return {
        source,
        image: { width: generated.width, height: generated.height, pixels: generated.pixels },
        plan,
        providerImage: generated,
        twoReferences,
        placement: {
          bounds: { x: source.bounds.x, y: source.bounds.y, width: generated.width, height: generated.height },
          originX: source.originX,
          originY: source.originY,
          hasSelection: false,
          captureToken: null,
          mask: Core.solidMask(generated.width, generated.height),
          maskWidth: generated.width,
          maskHeight: generated.height,
        },
      };
    }

    return {
      source,
      image: { width: source.width, height: source.height, pixels: fitted },
      plan,
      providerImage: generated,
      twoReferences,
      placement: {
        bounds: source.bounds,
        originX: source.originX,
        originY: source.originY,
        hasSelection: source.hasSelection,
        captureToken: source.captureToken,
        mask: source.mask,
        maskWidth: source.maskWidth,
        maskHeight: source.maskHeight,
      },
    };
  }

  async function apply(options) {
    const api = options.api;
    const result = options.result;
    const name = options.name || "Image Gen";
    const doc = await api.documents.active();
    if (!doc || doc.id !== result.docId) throw new Error("The document changed — generate again.");
    let method = "";

    if (result.captureToken) {
      try {
        await api.documents.applyImage({ documentId: doc.id, image: result.image, name, captureToken: result.captureToken });
        method = "applyImage";
      } catch {
        method = "";
      }
    }

    if (!method) {
      const pixels = result.hasSelection
        ? Core.composeAlpha(result.image.pixels, result.image.width, result.image.height, result.mask, result.maskWidth, result.maskHeight)
        : result.image.pixels;
      await api.documents.execute("layer.new", { name }, doc.id);
      const after = await api.documents.active();
      const selected = after && Array.isArray(after.selectedLayerIds) ? after.selectedLayerIds : [];
      const layerId = selected[selected.length - 1];
      if (!layerId) throw new Error("The host did not create a layer for the result.");
      await api.documents.writePixels(
        doc.id,
        layerId,
        {
          pixels,
          sourceBounds: {
            left: result.originX + result.bounds.x,
            top: result.originY + result.bounds.y,
            right: result.originX + result.bounds.x + result.image.width,
            bottom: result.originY + result.bounds.y + result.image.height,
          },
          options: {
            width: result.image.width,
            height: result.image.height,
            components: 4,
            componentSize: 8,
            fullRange: true,
            colorSpace: "RGB",
          },
        },
        name,
      );
      await api.documents.execute("layer.rename", { layerId, name }, doc.id).catch(() => {});
      method = "writePixels";
    }

    if (result.captureToken) {
      await api.documents.release(result.captureToken).catch(() => {});
    }
    return { method };
  }

  return {
    toRgba,
    cropRgba,
    resizeRgba,
    encodeDataUri,
    downloadImage,
    readJson,
    readText,
    bodyToText,
    isBinary,
    clearSchemaCache,
    captureSource,
    generate,
    apply,
    decodeImageValue,
  };
});
