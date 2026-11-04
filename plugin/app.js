"use strict";

/*
 * Image Gen panel — UI layer.
 *
 * All document work lives in pipeline.js (capture → generate → apply) and all provider knowledge in
 * providers.js; this file only reads the controls, draws the preview and keeps settings/history.
 */

const SDK = globalThis.__photonSdk;
const Core = globalThis.PhotonImageGen;
const Providers = globalThis.PhotonProviders;
const Pipeline = globalThis.PhotonPipeline;

const el = {
  state: document.getElementById("state"),
  sep: document.getElementById("sep"),
  badge: document.getElementById("badge"),
  tabGenerate: document.getElementById("tabGenerate"),
  tabSettings: document.getElementById("tabSettings"),
  viewGenerate: document.getElementById("viewGenerate"),
  viewSettings: document.getElementById("viewSettings"),
  source: document.getElementById("source"),
  sourceTag: document.getElementById("sourceTag"),
  sourceLabel: document.getElementById("sourceLabel"),
  prompt: document.getElementById("prompt"),
  model: document.getElementById("model"),
  size: document.getElementById("size"),
  steps: document.getElementById("steps"),
  guidance: document.getElementById("guidance"),
  seed: document.getElementById("seed"),
  margin: document.getElementById("margin"),
  strength: document.getElementById("strength"),
  generate: document.getElementById("generate"),
  cancel: document.getElementById("cancel"),
  progress: document.getElementById("progress"),
  progressFill: document.getElementById("progressFill"),
  reason: document.getElementById("reason"),
  preview: document.getElementById("preview"),
  previewEmpty: document.getElementById("previewEmpty"),
  previewCanvas: document.getElementById("previewCanvas"),
  apply: document.getElementById("apply"),
  discard: document.getElementById("discard"),
  historyBox: document.getElementById("historyBox"),
  history: document.getElementById("history"),
  provider: document.getElementById("provider"),
  providerHint: document.getElementById("providerHint"),
  baseUrlField: document.getElementById("baseUrlField"),
  baseUrl: document.getElementById("baseUrl"),
  keyState: document.getElementById("keyState"),
  setKey: document.getElementById("setKey"),
  forgetKey: document.getElementById("forgetKey"),
  customFields: document.getElementById("customFields"),
  submitUrl: document.getElementById("submitUrl"),
  method: document.getElementById("method"),
  mode: document.getElementById("mode"),
  headersTemplate: document.getElementById("headersTemplate"),
  bodyTemplate: document.getElementById("bodyTemplate"),
  imageSource: document.getElementById("imageSource"),
  pollUrl: document.getElementById("pollUrl"),
  outputPath: document.getElementById("outputPath"),
  statusPath: document.getElementById("statusPath"),
  successValues: document.getElementById("successValues"),
  save: document.getElementById("save"),
  test: document.getElementById("test"),
  testResult: document.getElementById("testResult"),
  log: document.getElementById("log"),
  status: document.getElementById("status"),
  meta: document.getElementById("meta"),
};

const SETTINGS_KEY = "imagegen";

let api = null;
let settings = null;
let credential = null;
let busy = false;
let cancelled = false;
let result = null;

/* ---------- UI helpers ---------- */

function log(line) {
  const stamp = new Date().toLocaleTimeString();
  el.log.textContent = ("[" + stamp + "] " + line + "\n" + el.log.textContent).slice(0, 8000);
}

function setStatus(text) {
  el.status.textContent = text;
}

function setState(text) {
  el.state.textContent = text;
  el.state.hidden = !text;
  el.sep.hidden = !text;
}

function badge(text, kind) {
  el.badge.textContent = text;
  el.badge.className = "badge " + (kind || "ok");
}

function setBusy(value) {
  busy = value;
  el.generate.disabled = value;
  el.cancel.hidden = !value;
  el.save.disabled = value;
  el.test.disabled = value;
  el.setKey.disabled = value;
}

function progress(value, text) {
  el.progress.hidden = value <= 0 || value >= 1;
  el.progressFill.style.width = Math.round(Math.max(0, Math.min(1, value)) * 100) + "%";
  if (text) setStatus(text);
}

function errText(error) {
  return String((error && error.message) || error || "unknown error");
}

function syncSelects() {
  if (typeof window !== "undefined" && typeof window.syncCustomSelects === "function") {
    window.syncCustomSelects();
  }
}

/* ---------- settings ---------- */

function defaultSettings() {
  return {
    provider: Core.DEFAULTS.provider,
    source: Core.DEFAULTS.source,
    model: Core.DEFAULTS.model,
    baseUrl: "",
    size: "auto",
    steps: Core.DEFAULTS.steps,
    guidance: Core.DEFAULTS.guidance,
    strength: Core.DEFAULTS.strength,
    margin: 0,
    custom: { ...Providers.CUSTOM_DEFAULTS },
    history: [],
  };
}

async function loadSettings() {
  let stored = null;
  try {
    const all = await api.settings.get();
    stored = all && all[SETTINGS_KEY] ? all[SETTINGS_KEY] : null;
  } catch {
    stored = null;
  }
  settings = { ...defaultSettings(), ...(stored || {}) };
  settings.custom = { ...Providers.CUSTOM_DEFAULTS, ...((stored && stored.custom) || {}) };
  settings.history = Array.isArray(settings.history) ? settings.history.slice(0, 6) : [];
}

async function persist() {
  try {
    const all = (await api.settings.get()) || {};
    all[SETTINGS_KEY] = settings;
    await api.settings.set(all);
  } catch (error) {
    log("settings save failed: " + errText(error));
  }
}

function readUiIntoSettings() {
  settings.source = el.source.value === "layer" ? "layer" : "selection";
  settings.provider = el.provider.value === "custom" ? "custom" : "replicate";
  settings.model = el.model.value.trim() || Core.DEFAULTS.model;
  settings.baseUrl = el.baseUrl.value.trim();
  settings.size = el.size.value || "auto";
  settings.steps = Core.clamp(el.steps.value, 1, 100);
  settings.guidance = Core.clamp(el.guidance.value, 0, 20);
  settings.strength = Core.clamp(el.strength.value, 0.1, 1);
  settings.margin = Core.clamp(el.margin.value, 0, 256);
  settings.custom = {
    ...settings.custom,
    submitUrl: el.submitUrl.value.trim(),
    method: el.method.value,
    mode: el.mode.value,
    headersTemplate: el.headersTemplate.value,
    bodyTemplate: el.bodyTemplate.value,
    imageSource: el.imageSource.value,
    pollUrl: el.pollUrl.value.trim(),
    outputPath: el.outputPath.value.trim() || "output",
    statusPath: el.statusPath.value.trim() || "status",
    successValues: el.successValues.value.trim() || Providers.CUSTOM_DEFAULTS.successValues,
  };
}

function writeSettingsToUi() {
  el.source.value = settings.source === "layer" ? "layer" : "selection";
  el.provider.value = settings.provider;
  el.model.value = settings.model;
  el.baseUrl.value = settings.baseUrl || "";
  el.size.value = settings.size || "auto";
  el.steps.value = String(settings.steps);
  el.guidance.value = String(settings.guidance);
  el.strength.value = String(settings.strength);
  el.margin.value = String(settings.margin);
  el.seed.value = "";
  el.submitUrl.value = settings.custom.submitUrl || "";
  el.method.value = settings.custom.method || "POST";
  el.mode.value = settings.custom.mode || "immediate";
  el.headersTemplate.value = settings.custom.headersTemplate || "{}";
  el.bodyTemplate.value = settings.custom.bodyTemplate || Providers.CUSTOM_DEFAULTS.bodyTemplate;
  el.imageSource.value = settings.custom.imageSource || "data_uri";
  el.pollUrl.value = settings.custom.pollUrl || "";
  el.outputPath.value = settings.custom.outputPath || "output";
  el.statusPath.value = settings.custom.statusPath || "status";
  el.successValues.value = settings.custom.successValues || Providers.CUSTOM_DEFAULTS.successValues;
  applyProviderUi();
  syncSelects();
}

function applyProviderUi() {
  const custom = el.provider.value === "custom";
  el.customFields.hidden = !custom;
  el.baseUrlField.hidden = custom;
  el.providerHint.textContent = Providers.providerInfo(el.provider.value).hint;
  el.model.placeholder = Providers.providerInfo(el.provider.value).modelHint;
  renderHistory();
  syncSelects();
}

async function refreshCredential() {
  const id = el.provider.value === "custom" ? "custom" : "replicate";
  try {
    credential = await api.credentials.status(id);
  } catch {
    credential = { configured: false };
  }
  const configured = Boolean(credential && credential.configured);
  el.keyState.textContent = configured
    ? "Configured · stored in the vault" + (credential.persistent === false ? " (this session)" : "")
    : "Not configured";
  el.forgetKey.hidden = !configured;
}

/* ---------- preview & history ---------- */

function showPreview(current) {
  const canvas = el.previewCanvas;
  canvas.width = current.image.width;
  canvas.height = current.image.height;
  const ctx = canvas.getContext("2d");
  const data = ctx.createImageData(current.image.width, current.image.height);
  const pixels = current.hasSelection
    ? current.image.pixels
    : Core.composeAlpha(current.image.pixels, current.image.width, current.image.height, current.mask, current.maskWidth, current.maskHeight);
  data.data.set(pixels);
  ctx.putImageData(data, 0, 0);
  canvas.hidden = false;
  el.previewEmpty.hidden = true;
}

function thumbnail(image) {
  const canvas = document.createElement("canvas");
  canvas.width = 32;
  canvas.height = 32;
  const ctx = canvas.getContext("2d");
  const source = document.createElement("canvas");
  source.width = image.width;
  source.height = image.height;
  const sourceCtx = source.getContext("2d");
  const data = sourceCtx.createImageData(image.width, image.height);
  data.data.set(image.pixels);
  sourceCtx.putImageData(data, 0, 0);
  ctx.drawImage(source, 0, 0, 32, 32);
  return canvas.toDataURL("image/png");
}

function renderHistory() {
  const items = settings && Array.isArray(settings.history) ? settings.history : [];
  el.historyBox.hidden = items.length === 0;
  if (items.length && !el.historyBox.open) el.historyBox.open = true;
  el.history.textContent = "";
  for (const item of items) {
    const row = document.createElement("div");
    row.className = "history-item";
    const img = document.createElement("img");
    img.alt = "";
    img.src = item.thumb || "";
    const label = document.createElement("span");
    label.textContent = (item.prompt || "image") + " · " + item.width + "×" + item.height;
    label.title = label.textContent;
    row.append(img, label);
    row.addEventListener("click", () => {
      el.prompt.value = item.prompt || "";
      el.reason.textContent = "History: " + label.textContent;
    });
    el.history.append(row);
  }
}

function addHistory(current) {
  try {
    const item = {
      prompt: current.prompt.slice(0, 80),
      model: current.model,
      width: current.image.width,
      height: current.image.height,
      at: new Date().toISOString(),
      thumb: thumbnail(current.image),
    };
    settings.history = [item, ...(settings.history || [])].slice(0, 6);
    renderHistory();
    void persist();
  } catch {
    /* thumbnails are cosmetic */
  }
}

/* ---------- actions ---------- */

async function runGenerate() {
  if (busy || !settings) return;
  const prompt = Core.truncate(el.prompt.value.trim(), 2000);
  if (!prompt) {
    el.reason.textContent = "Type a prompt first.";
    return;
  }
  readUiIntoSettings();
  cancelled = false;
  setBusy(true);
  badge("Working…", "busy");
  setState("Preparing");
  el.apply.hidden = true;
  el.discard.hidden = true;
  el.previewCanvas.hidden = true;
  el.previewEmpty.hidden = false;
  result = null;

  try {
    progress(0.08, "Capturing the source…");
    const source = await Pipeline.captureSource({ api, settings });
    const seed = el.seed.value === "" ? Math.floor(Math.random() * 1e9) : Number(el.seed.value);
    const generated = await Pipeline.generate({
      api,
      settings,
      source,
      prompt,
      seed,
      progress,
      isCancelled: () => cancelled,
      log,
    });

    result = {
      image: generated.image,
      bounds: source.bounds,
      originX: source.originX,
      originY: source.originY,
      captureToken: source.captureToken,
      mask: source.mask,
      maskWidth: source.maskWidth,
      maskHeight: source.maskHeight,
      hasSelection: source.hasSelection,
      prompt,
      model: settings.model,
      docId: source.doc.id,
    };
    showPreview(result);
    progress(1, "Ready to apply");
    setState("Done");
    badge("Ready", "ok");
    el.reason.textContent =
      "Generated " + generated.providerImage.width + "×" + generated.providerImage.height +
      " for a " + source.width + "×" + source.height + " area. Apply writes it back.";
    el.apply.hidden = false;
    el.discard.hidden = false;
    el.meta.textContent = source.width + "×" + source.height + (source.hasSelection ? " selection" : " layer");
  } catch (error) {
    const message = Core.describeError(error);
    el.reason.textContent = message;
    setState("Error");
    badge("Failed", "danger");
    log("error: " + message);
  } finally {
    setBusy(false);
    progress(0);
  }
}

async function applyResult() {
  if (!result || busy) return;
  setBusy(true);
  badge("Working…", "busy");
  setState("Applying");
  try {
    const name = ("Image Gen — " + result.prompt).slice(0, 120);
    const outcome = await Pipeline.apply({ api, result, name });
    addHistory(result);
    setState("Applied");
    badge("Ready", "ok");
    el.reason.textContent = "Applied to the document (" + outcome.method + ").";
    el.apply.hidden = true;
    el.discard.hidden = true;
    el.previewCanvas.hidden = true;
    el.previewEmpty.hidden = false;
    log("applied via " + outcome.method);
    result = null;
  } catch (error) {
    const message = Core.describeError(error);
    el.reason.textContent = message;
    setState("Error");
    badge("Failed", "danger");
    log("apply failed: " + message);
  } finally {
    setBusy(false);
    progress(0);
  }
}

function discardResult() {
  if (result && result.captureToken) api.documents.release(result.captureToken).catch(() => {});
  result = null;
  el.apply.hidden = true;
  el.discard.hidden = true;
  el.previewCanvas.hidden = true;
  el.previewEmpty.hidden = false;
  el.reason.textContent = "Discarded.";
  setState("Idle");
  badge("Ready", "ok");
}

async function cancelRun() {
  cancelled = true;
  setState("Cancelling…");
  log("cancel requested");
}

/* ---------- credentials & test ---------- */

async function setKey() {
  const provider = el.provider.value === "custom" ? "custom" : "replicate";
  const origin = provider === "custom"
    ? new URL(el.submitUrl.value.trim() || "https://example.com").origin
    : "https://api.replicate.com";
  try {
    await api.network.allowEndpoint(origin).catch(() => {});
    await api.credentials.configure(
      provider,
      provider === "custom" ? "Custom endpoint API key" : "Replicate API token",
      origin,
    );
    await refreshCredential();
    el.testResult.textContent = "Key stored in the vault.";
  } catch (error) {
    el.testResult.textContent = "Could not store the key: " + errText(error);
  }
}

async function forgetKey() {
  const provider = el.provider.value === "custom" ? "custom" : "replicate";
  try {
    await api.credentials.delete(provider);
    await refreshCredential();
    el.testResult.textContent = "Key removed.";
  } catch (error) {
    el.testResult.textContent = "Could not remove the key: " + errText(error);
  }
}

async function testConnection() {
  readUiIntoSettings();
  el.testResult.textContent = "Testing…";
  try {
    if (settings.provider === "custom") {
      const url = settings.custom.submitUrl || settings.baseUrl;
      if (!url) throw new Error("Set the Submit URL first.");
      await api.network.allowEndpoint(new URL(url).origin).catch(() => {});
      const reply = await api.network.request({
        url,
        method: "GET",
        ...(credential && credential.configured ? { credential: Providers.PROVIDERS.custom.credential } : {}),
      });
      el.testResult.textContent = "Endpoint reachable (HTTP " + reply.status + ").";
      return;
    }
    const spec = Providers.parseModelSpec(settings.model);
    const base = (settings.baseUrl || Providers.PROVIDERS.replicate.base).replace(/\/+$/, "");
    const url = base + "/v1/models/" + spec.owner + "/" + spec.name;
    await api.network.allowEndpoint(new URL(url).origin).catch(() => {});
    const reply = await api.network.request({
      url,
      method: "GET",
      ...(credential && credential.configured ? { credential: Providers.PROVIDERS.replicate.credential } : {}),
    });
    el.testResult.textContent = reply.status === 200
      ? "Replicate reachable; " + spec.owner + "/" + spec.name + " is available."
      : "Replicate answered HTTP " + reply.status + " (check the token and model).";
  } catch (error) {
    el.testResult.textContent = Core.describeError(error);
  }
}

/* ---------- source chip & wiring ---------- */

async function refreshSourceChip() {
  try {
    const doc = await api.documents.active();
    const mode = el.source.value === "layer" ? "layer" : "selection";
    if (!doc) {
      el.sourceTag.textContent = "No document";
      el.sourceLabel.textContent = "Open a document";
      return;
    }
    const selected = Array.isArray(doc.selectedLayerIds) ? doc.selectedLayerIds : [];
    const layer = (doc.layers || []).find((item) => item.id === selected[selected.length - 1]);
    if (mode === "layer") {
      el.sourceTag.textContent = "LAYER";
      el.sourceLabel.textContent = layer
        ? "Generates the whole layer “" + layer.name + "” (the result becomes a new layer)"
        : "Select a layer in the Layers panel";
      return;
    }
    if (!doc.hasSelection) {
      el.sourceTag.textContent = "SELECTION";
      el.sourceLabel.textContent = "Nothing selected — make a selection, or switch Source to “Selected layer”";
      return;
    }
    el.sourceTag.textContent = "SELECTION";
    el.sourceLabel.textContent = "Generates only the selected area" + (layer ? " of “" + layer.name + "”" : "");
  } catch {
    el.sourceTag.textContent = "—";
    el.sourceLabel.textContent = "Document unavailable";
  }
}

function showView(name) {
  const settingsView = name === "settings";
  el.viewGenerate.hidden = settingsView;
  el.viewSettings.hidden = !settingsView;
  el.tabGenerate.classList.toggle("active", !settingsView);
  el.tabSettings.classList.toggle("active", settingsView);
}

function wire() {
  el.tabGenerate.addEventListener("click", () => showView("generate"));
  el.tabSettings.addEventListener("click", () => showView("settings"));
  el.generate.addEventListener("click", () => void runGenerate());
  el.cancel.addEventListener("click", () => void cancelRun());
  el.apply.addEventListener("click", () => void applyResult());
  el.discard.addEventListener("click", discardResult);
  el.setKey.addEventListener("click", () => void setKey());
  el.forgetKey.addEventListener("click", () => void forgetKey());
  el.test.addEventListener("click", () => void testConnection());
  el.save.addEventListener("click", () => {
    readUiIntoSettings();
    writeSettingsToUi();
    void persist();
    el.testResult.textContent = "Settings saved.";
    setState("Idle");
    badge("Ready", "ok");
  });
  el.provider.addEventListener("change", () => {
    applyProviderUi();
    void refreshCredential();
  });
  el.source.addEventListener("change", () => {
    readUiIntoSettings();
    void refreshSourceChip();
    void persist();
  });
  el.prompt.addEventListener("input", () => {
    el.reason.textContent = el.prompt.value.trim()
      ? "Ready to generate inside " + (el.sourceTag.textContent === "Selection" ? "the selection" : "the layer") + "."
      : "Describe what to generate inside the selection.";
  });
}

async function init() {
  await loadSettings();
  writeSettingsToUi();
  await refreshCredential();
  await refreshSourceChip();
  setState("Idle");
  badge("Ready", "ok");
  setStatus("ready");
  el.meta.textContent = Providers.providerInfo(settings.provider).label;
  log("Image Gen ready · provider " + settings.provider);
}

if (!SDK) {
  badge("Failed", "danger");
  setState("Offline");
  setStatus("Photon SDK unavailable — open this panel inside Photon Studio.");
} else if (!Core || !Providers || !Pipeline) {
  badge("Failed", "danger");
  setState("Error");
  setStatus("Plugin scripts failed to load.");
} else {
  wire();
  SDK.activate((sdk) => {
    api = sdk;
    void init().catch((error) => {
      badge("Failed", "danger");
      setState("Error");
      setStatus("init failed: " + errText(error));
      log("init failed: " + errText(error));
    });
    return {
      dispose() {
        cancelled = true;
        api = null;
      },
    };
  });
}
