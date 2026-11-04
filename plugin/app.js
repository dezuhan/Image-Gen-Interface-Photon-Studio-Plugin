"use strict";

/*
 * Image Gen panel — UI layer.
 *
 * All document work lives in pipeline.js (capture → generate → apply), provider knowledge in
 * providers.js. This file wires the controls, the saved-model library, the preview and the logs.
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
  sourceTag: document.getElementById("sourceTag"),
  sourceLabel: document.getElementById("sourceLabel"),
  prompt: document.getElementById("prompt"),
  model: document.getElementById("model"),
  size: document.getElementById("size"),
  aspect: document.getElementById("aspect"),
  temperature: document.getElementById("temperature"),
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
  modelInput: document.getElementById("modelInput"),
  addModel: document.getElementById("addModel"),
  modelList: document.getElementById("modelList"),
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
  logsBox: document.getElementById("logsBox"),
  log: document.getElementById("log"),
  status: document.getElementById("status"),
  meta: document.getElementById("meta"),
};

const SETTINGS_KEY = "imagegen";
const MODEL_SEPARATOR = "|";

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

function fail(error) {
  const message = Core.describeError(error);
  el.reason.textContent = message;
  el.logsBox.open = true;
  setState("Error");
  badge("Failed", "danger");
  log("error: " + message);
  return message;
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
    model: Core.DEFAULTS.model,
    baseUrl: "",
    size: "auto",
    aspect: "auto",
    temperature: 1,
    steps: Core.DEFAULTS.steps,
    guidance: Core.DEFAULTS.guidance,
    strength: Core.DEFAULTS.strength,
    margin: 0,
    models: [{ provider: "replicate", model: Core.DEFAULTS.model }],
    custom: { ...Providers.CUSTOM_DEFAULTS },
    history: [],
  };
}

function uniqueModels(list) {
  const seen = new Set();
  const out = [];
  for (const entry of Array.isArray(list) ? list : []) {
    const provider = entry && entry.provider === "custom" ? "custom" : "replicate";
    const model = String((entry && entry.model) || "").trim();
    if (!model) continue;
    const key = provider + MODEL_SEPARATOR + model;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ provider, model });
  }
  return out;
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
  settings.models = uniqueModels(settings.models);
  if (!settings.models.length) {
    settings.models = [{ provider: settings.provider || "replicate", model: settings.model || Core.DEFAULTS.model }];
  }
  settings.model = String(settings.model || Core.DEFAULTS.model);
  settings.provider = settings.models.some((entry) => entry.model === settings.model && entry.provider === settings.provider)
    ? settings.provider
    : settings.models[0].provider;
  if (!settings.models.some((entry) => entry.model === settings.model)) settings.model = settings.models[0].model;
  settings.temperature = Core.clamp(settings.temperature === undefined || settings.temperature === "" ? 1 : settings.temperature, 0, 2);
  settings.size = ["auto", "1K", "2K", "4K"].includes(settings.size) ? settings.size : "auto";
  settings.aspect = ["auto"].concat(Providers.ASPECT_RATIOS).includes(settings.aspect) ? settings.aspect : "auto";
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

function selectedEntry() {
  return { provider: settings.provider === "custom" ? "custom" : "replicate", model: settings.model };
}

function readUiIntoSettings() {
  settings.provider = el.provider.value === "custom" ? "custom" : "replicate";
  settings.model = el.model.value || settings.model;
  settings.baseUrl = el.baseUrl.value.trim();
  settings.size = el.size.value || "auto";
  settings.aspect = el.aspect.value || "auto";
  settings.temperature = Core.clamp(el.temperature.value, 0, 2);
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

function rebuildModelSelect() {
  el.model.textContent = "";
  const entries = settings.models.length ? settings.models : [{ provider: "replicate", model: Core.DEFAULTS.model }];
  for (const entry of entries) {
    const option = document.createElement("option");
    option.value = entry.provider + MODEL_SEPARATOR + entry.model;
    option.textContent = entry.model + (entry.provider === "custom" ? " · custom" : "");
    el.model.append(option);
  }
  const current = settings.provider + MODEL_SEPARATOR + settings.model;
  el.model.value = entries.some((entry) => entry.provider + MODEL_SEPARATOR + entry.model === current)
    ? current
    : entries[0].provider + MODEL_SEPARATOR + entries[0].model;
  syncSelects();
}

function rebuildAspectSelect() {
  el.aspect.textContent = "";
  const options = ["auto"].concat(Providers.ASPECT_RATIOS);
  for (const value of options) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = value === "auto" ? "Auto (match input)" : value;
    el.aspect.append(option);
  }
  el.aspect.value = settings.aspect || "auto";
}

function renderModelList() {
  el.modelList.textContent = "";
  for (const entry of settings.models) {
    const row = document.createElement("div");
    row.className = "model-row";
    const label = document.createElement("span");
    label.className = "model-name";
    label.textContent = entry.model;
    label.title = entry.model;
    const provider = document.createElement("span");
    provider.className = "tag";
    provider.textContent = entry.provider === "custom" ? "CUSTOM" : "REPLICATE";
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "button tiny";
    remove.textContent = "×";
    remove.title = "Remove this model";
    remove.addEventListener("click", () => {
      settings.models = settings.models.filter((item) => !(item.model === entry.model && item.provider === entry.provider));
      if (!settings.models.length) settings.models = [{ provider: "replicate", model: Core.DEFAULTS.model }];
      if (settings.model === entry.model && settings.provider === entry.provider) {
        settings.model = settings.models[0].model;
        settings.provider = settings.models[0].provider;
      }
      rebuildModelSelect();
      renderModelList();
      void persist();
    });
    row.append(label, provider, remove);
    el.modelList.append(row);
  }
}

function writeSettingsToUi() {
  el.provider.value = settings.provider;
  rebuildModelSelect();
  rebuildAspectSelect();
  el.size.value = settings.size || "auto";
  el.temperature.value = String(settings.temperature);
  el.steps.value = String(settings.steps);
  el.guidance.value = String(settings.guidance);
  el.strength.value = String(settings.strength);
  el.margin.value = String(settings.margin);
  el.seed.value = "";
  el.baseUrl.value = settings.baseUrl || "";
  el.submitUrl.value = settings.custom.submitUrl;
  el.method.value = settings.custom.method || "POST";
  el.mode.value = settings.custom.mode || "immediate";
  el.headersTemplate.value = settings.custom.headersTemplate || "{}";
  el.bodyTemplate.value = settings.custom.bodyTemplate || Providers.CUSTOM_DEFAULTS.bodyTemplate;
  el.imageSource.value = settings.custom.imageSource || "data_uri";
  el.pollUrl.value = settings.custom.pollUrl || "";
  el.outputPath.value = settings.custom.outputPath || "output";
  el.statusPath.value = settings.custom.statusPath || "status";
  el.successValues.value = settings.custom.successValues || Providers.CUSTOM_DEFAULTS.successValues;
  renderModelList();
  applyProviderUi();
  syncSelects();
}

function applyProviderUi() {
  const custom = settings.provider === "custom";
  el.customFields.hidden = !custom;
  el.baseUrlField.hidden = custom;
  el.providerHint.textContent = Providers.providerInfo(settings.provider).hint;
  syncSelects();
}

async function refreshCredential() {
  const id = settings.provider === "custom" ? "custom" : "replicate";
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
  readUiIntoSettings();
  const prompt = Core.truncate(el.prompt.value.trim(), 2000);
  if (!prompt) {
    el.reason.textContent = "Type a prompt first.";
    return;
  }
  if (!settings.model) {
    el.reason.textContent = "Add a model in Settings first.";
    return;
  }
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
    const generated = await Pipeline.generate({ api, settings, source, prompt, seed, progress, isCancelled: () => cancelled, log });

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
      (generated.twoReferences ? " from 2 references (layer + selection)" : "") +
      " · " + settings.size + " · " + settings.aspect + ". Apply writes it back.";
    el.apply.hidden = false;
    el.discard.hidden = false;
    el.meta.textContent = source.width + "×" + source.height + (source.hasSelection ? " selection" : " layer");
    void persist();
  } catch (error) {
    fail(error);
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
    fail(error);
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

/* ---------- saved models ---------- */

function addModelEntry() {
  const model = el.modelInput.value.trim();
  if (!model) {
    el.testResult.textContent = "Type a model name first.";
    return;
  }
  const provider = el.provider.value === "custom" ? "custom" : "replicate";
  const key = provider + MODEL_SEPARATOR + model;
  if (!settings.models.some((entry) => entry.provider + MODEL_SEPARATOR + entry.model === key)) {
    settings.models.push({ provider, model });
  }
  settings.provider = provider;
  settings.model = model;
  rebuildModelSelect();
  renderModelList();
  el.modelInput.value = "";
  el.testResult.textContent = "Model saved. Pick it in the Generate tab.";
  void persist();
}

/* ---------- credentials & test ---------- */

async function setKey() {
  const provider = el.provider.value === "custom" ? "custom" : "replicate";
  const origin = provider === "custom"
    ? new URL(el.submitUrl.value.trim() || "https://example.com").origin
    : "https://api.replicate.com";
  try {
    await api.network.allowEndpoint(origin).catch(() => {});
    await api.credentials.configure(provider, provider === "custom" ? "Custom endpoint API key" : "Replicate API token", origin);
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
    const request = Providers.schemaRequest({ base: settings.baseUrl, model: settings.model });
    await api.network.allowEndpoint(new URL(request.url).origin).catch(() => {});
    const reply = await api.network.request({ url: request.url, ...request.options });
    const props = reply.status === 200 ? Providers.parseInputSchema(Pipeline.readJson(reply)) : null;
    el.testResult.textContent = reply.status === 200
      ? "Connected. " + settings.model + (props ? " · " + props.size + " inputs" : " · schema not readable") + "."
      : "Replicate answered HTTP " + reply.status + " (check the token and model).";
    log("test: " + el.testResult.textContent);
  } catch (error) {
    el.testResult.textContent = Core.describeError(error);
    log("test failed: " + el.testResult.textContent);
  }
}

/* ---------- source chip & wiring ---------- */

async function refreshSourceChip() {
  try {
    const doc = await api.documents.active();
    if (!doc) {
      el.sourceTag.textContent = "NO DOCUMENT";
      el.sourceLabel.textContent = "Open an image to start";
      return;
    }
    const selected = Array.isArray(doc.selectedLayerIds) ? doc.selectedLayerIds : [];
    const layer = (doc.layers || []).find((item) => item.id === selected[selected.length - 1]);
    const layerName = layer ? "“" + layer.name + "”" : "the selected layer";
    if (doc.hasSelection) {
      el.sourceTag.textContent = "2 REFERENCES";
      el.sourceLabel.textContent = "Full layer " + layerName + " + the selected area as context";
    } else {
      el.sourceTag.textContent = "LAYER";
      el.sourceLabel.textContent = "No selection — sends the whole layer " + layerName;
    }
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
  el.addModel.addEventListener("click", addModelEntry);
  el.modelInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      addModelEntry();
    }
  });
  el.model.addEventListener("change", () => {
    const [provider, ...rest] = el.model.value.split(MODEL_SEPARATOR);
    settings.provider = provider === "custom" ? "custom" : "replicate";
    settings.model = rest.join(MODEL_SEPARATOR);
    applyProviderUi();
    void refreshCredential();
    void persist();
  });
  el.provider.addEventListener("change", () => {
    settings.provider = el.provider.value === "custom" ? "custom" : "replicate";
    applyProviderUi();
    void refreshCredential();
  });
  el.setKey.addEventListener("click", () => void setKey());
  el.forgetKey.addEventListener("click", () => void forgetKey());
  el.test.addEventListener("click", () => void testConnection());
  el.save.addEventListener("click", () => {
    readUiIntoSettings();
    writeSettingsToUi();
    if (Pipeline.clearSchemaCache) Pipeline.clearSchemaCache();
    void persist();
    el.testResult.textContent = "Settings saved.";
    setState("Idle");
    badge("Ready", "ok");
  });
  el.prompt.addEventListener("input", () => {
    el.reason.textContent = el.prompt.value.trim()
      ? "Ready to generate " + (el.sourceTag.textContent === "2 REFERENCES" ? "with the layer + selection references." : "from the whole layer.")
      : "Describe what to generate.";
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
  log("Image Gen ready · " + settings.models.length + " saved model(s)");
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
