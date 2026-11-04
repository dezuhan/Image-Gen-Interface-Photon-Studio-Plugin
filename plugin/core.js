/*
 * Image Gen — pure helpers.
 *
 * Everything in this file is deterministic and side-effect free, so it runs under Node in the test
 * suite without Photon: mask construction, bounding boxes, size planning, template rendering,
 * response parsing and small formatting helpers.
 */
(function (root, factory) {
  const mod = factory();
  if (typeof module === "object" && module.exports) module.exports = mod;
  else root.PhotonImageGen = mod;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const DEFAULTS = {
    provider: "replicate",
    source: "selection",
    model: "google/nano-banana-2",
    size: "auto",
    steps: 28,
    guidance: 3.5,
    strength: 0.9,
    margin: 0,
    seed: null,
  };

  const SOURCES = ["selection", "layer"];
  const WORK_SIZES = [512, 768, 1024, 1536];
  const MAX_EDGE = 8192;
  const MAX_PIXELS = 16 * 1024 * 1024;

  function clamp(value, low, high) {
    const number = Number(value);
    if (!Number.isFinite(number)) return low;
    return Math.min(high, Math.max(low, number));
  }

  function round(value) {
    return Math.round(value);
  }

  function formatBytes(bytes) {
    const value = Number(bytes) || 0;
    if (value < 1024) return value + " B";
    if (value < 1024 * 1024) return (value / 1024).toFixed(1) + " KB";
    return (value / 1048576).toFixed(2) + " MB";
  }

  function formatDuration(ms) {
    const value = Math.max(0, Math.round(Number(ms) || 0));
    if (value < 1000) return value + " ms";
    if (value < 60000) return (value / 1000).toFixed(1) + " s";
    return Math.floor(value / 60000) + "m " + Math.round((value % 60000) / 1000) + "s";
  }

  function dataUri(mime, base64) {
    return "data:" + (mime || "image/png") + ";base64," + base64;
  }

  function bytesToBase64(bytes) {
    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (typeof Buffer !== "undefined") return Buffer.from(data).toString("base64");
    let binary = "";
    const chunk = 0x8000;
    for (let index = 0; index < data.length; index += chunk) {
      binary += String.fromCharCode.apply(null, data.subarray(index, index + chunk));
    }
    return btoa(binary);
  }

  function base64ToBytes(value) {
    if (typeof Buffer !== "undefined") return new Uint8Array(Buffer.from(value, "base64"));
    const binary = atob(value);
    const out = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) out[index] = binary.charCodeAt(index);
    return out;
  }

  /** White (editable) where the selection coverage is above the threshold, transparent elsewhere. */
  function maskFromCoverage(coverage, width, height, threshold) {
    const limit = threshold === undefined ? 8 : threshold;
    const out = new Uint8Array(width * height * 4);
    for (let index = 0; index < width * height; index += 1) {
      const value = coverage[index] > limit ? 255 : 0;
      out[index * 4] = 255;
      out[index * 4 + 1] = 255;
      out[index * 4 + 2] = 255;
      out[index * 4 + 3] = value;
    }
    return out;
  }

  /** Mask from a layer's alpha channel, used when the host gives no selection coverage. */
  function maskFromAlpha(pixels, components, width, height, threshold) {
    const limit = threshold === undefined ? 8 : threshold;
    const out = new Uint8Array(width * height * 4);
    const alphaOffset = components - 1;
    for (let index = 0; index < width * height; index += 1) {
      const value = pixels[index * components + alphaOffset] > limit ? 255 : 0;
      out[index * 4] = 255;
      out[index * 4 + 1] = 255;
      out[index * 4 + 2] = 255;
      out[index * 4 + 3] = value;
    }
    return out;
  }

  function solidMask(width, height) {
    const out = new Uint8Array(width * height * 4);
    out.fill(255);
    return out;
  }

  /** Bounding box of the non-transparent mask pixels, or null when the mask is empty. */
  function bbox(mask, width, height) {
    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        if (mask[(y * width + x) * 4 + 3] > 0) {
          if (x < minX) minX = x;
          if (y < minY) minY = y;
          if (x > maxX) maxX = x;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX < 0) return null;
    return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
  }

  function expandBounds(bounds, margin, maxWidth, maxHeight) {
    const pad = Math.max(0, round(margin || 0));
    const left = Math.max(0, bounds.x - pad);
    const top = Math.max(0, bounds.y - pad);
    const right = Math.min(maxWidth || Infinity, bounds.x + bounds.width + pad);
    const bottom = Math.min(maxHeight || Infinity, bounds.y + bounds.height + pad);
    return { x: left, y: top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) };
  }

  /** Crop a mask to a rectangle, returning a new width×height mask. */
  function cropMask(mask, fullWidth, fullHeight, bounds) {
    const out = new Uint8Array(bounds.width * bounds.height * 4);
    for (let y = 0; y < bounds.height; y += 1) {
      for (let x = 0; x < bounds.width; x += 1) {
        const sourceX = bounds.x + x;
        const sourceY = bounds.y + y;
        if (sourceX < 0 || sourceY < 0 || sourceX >= fullWidth || sourceY >= fullHeight) continue;
        const from = (sourceY * fullWidth + sourceX) * 4;
        const to = (y * bounds.width + x) * 4;
        out[to] = mask[from];
        out[to + 1] = mask[from + 1];
        out[to + 2] = mask[from + 2];
        out[to + 3] = mask[from + 3];
      }
    }
    return out;
  }

  /** Nearest-neighbour mask resize — coverage only, so quality is irrelevant. */
  function scaleMask(mask, width, height, nextWidth, nextHeight) {
    const out = new Uint8Array(nextWidth * nextHeight * 4);
    for (let y = 0; y < nextHeight; y += 1) {
      const sourceY = Math.min(height - 1, Math.floor((y * height) / nextHeight));
      for (let x = 0; x < nextWidth; x += 1) {
        const sourceX = Math.min(width - 1, Math.floor((x * width) / nextWidth));
        const from = (sourceY * width + sourceX) * 4;
        const to = (y * nextWidth + x) * 4;
        out[to] = mask[from];
        out[to + 1] = mask[from + 1];
        out[to + 2] = mask[from + 2];
        out[to + 3] = mask[from + 3];
      }
    }
    return out;
  }

  /** Multiply a generated RGBA image by a mask so only the editable area survives. */
  function composeAlpha(pixels, width, height, mask, maskWidth, maskHeight) {
    const out = new Uint8Array(pixels.length);
    out.set(pixels);
    for (let y = 0; y < height; y += 1) {
      const maskY = Math.min(maskHeight - 1, Math.floor((y * maskHeight) / height));
      for (let x = 0; x < width; x += 1) {
        const maskX = Math.min(maskWidth - 1, Math.floor((x * maskWidth) / width));
        const coverage = mask[(maskY * maskWidth + maskX) * 4 + 3] / 255;
        const index = (y * width + x) * 4 + 3;
        out[index] = Math.round(out[index] * coverage);
      }
    }
    return out;
  }

  /**
   * Fit width×height into the work box (edge and pixel budget) while keeping the aspect ratio.
   * `scale` is the factor applied to the source.
   */
  function planSize(width, height, maxEdge, maxPixels) {
    const edge = maxEdge || 1024;
    const budget = maxPixels || MAX_PIXELS;
    if (!width || !height) return { width: 1, height: 1, scale: 1 };
    let scale = 1;
    if (Math.max(width, height) > edge) scale = edge / Math.max(width, height);
    if (width * scale * height * scale > budget) scale = Math.sqrt(budget / (width * height));
    return {
      width: Math.max(1, round(width * scale)),
      height: Math.max(1, round(height * scale)),
      scale,
    };
  }

  function roundTo(value, step) {
    const size = step || 64;
    return Math.max(size, Math.round(value / size) * size);
  }

  /** Replace {{key}} placeholders with JSON-escaped values (safe inside a JSON string literal). */
  function renderTemplate(template, vars) {
    return String(template || "").replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (match, key) => {
      if (!(key in (vars || {}))) return match;
      const value = vars[key];
      const text = value === undefined || value === null ? "" : String(value);
      return JSON.stringify(text).slice(1, -1);
    });
  }

  function parseJsonTemplate(template, vars) {
    const rendered = renderTemplate(template, vars);
    return JSON.parse(rendered);
  }

  /** Dot/bracket path lookup: "a.b[0].url". */
  function getPath(value, path) {
    if (!path) return value;
    const parts = String(path)
      .replace(/\[(\d+)\]/g, ".$1")
      .split(".")
      .filter(Boolean);
    let current = value;
    for (const part of parts) {
      if (current === null || current === undefined) return undefined;
      current = current[part];
    }
    return current;
  }

  /** The first usable image from a provider response: URL string or data URI. */
  function firstImageCandidate(payload, paths) {
    const list = [];
    for (const path of paths || []) {
      const value = getPath(payload, path);
      if (typeof value === "string" && value) list.push(value);
      if (Array.isArray(value)) {
        for (const item of value) {
          if (typeof item === "string" && item) list.push(item);
          else if (item && typeof item === "object" && typeof item.url === "string") list.push(item.url);
        }
      }
    }
    return list[0] || null;
  }

  function statusOf(value) {
    const text = String(value || "").toLowerCase();
    if (!text) return "pending";
    if (["succeeded", "success", "succeed", "completed", "complete", "done", "ok"].includes(text)) return "succeeded";
    if (["failed", "error", "canceled", "cancelled", "cancelled_by_user", "timeout"].includes(text)) return "failed";
    return "pending";
  }

  function describeError(error) {
    const text = String((error && error.message) || error || "unknown error");
    if (/401|unauthorized|invalid api key|authentication/i.test(text)) {
      return "The API key was rejected — open Settings and set a valid key.";
    }
    if (/402|payment|credit|quota/i.test(text)) {
      return "The provider reports no credits or quota — check the account billing.";
    }
    if (/429|rate limit|too many requests/i.test(text)) {
      return "Rate limited by the provider — wait a moment and try again.";
    }
    if (/fetch failed|enotfound|econnrefused|network|offline/i.test(text)) {
      return "Cannot reach the provider — check the network and the endpoint in Settings.";
    }
    return text;
  }

  function truncate(text, limit) {
    const value = String(text || "");
    const max = limit || 2000;
    return value.length > max ? value.slice(0, max - 1) + "…" : value;
  }

  return {
    DEFAULTS,
    SOURCES,
    WORK_SIZES,
    MAX_EDGE,
    MAX_PIXELS,
    clamp,
    round,
    formatBytes,
    formatDuration,
    dataUri,
    bytesToBase64,
    base64ToBytes,
    maskFromCoverage,
    maskFromAlpha,
    solidMask,
    bbox,
    expandBounds,
    cropMask,
    scaleMask,
    composeAlpha,
    planSize,
    roundTo,
    renderTemplate,
    parseJsonTemplate,
    getPath,
    firstImageCandidate,
    statusOf,
    describeError,
    truncate,
  };
});
