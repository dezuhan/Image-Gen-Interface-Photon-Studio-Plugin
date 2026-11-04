#!/usr/bin/env node
/*
 * Image Gen — static UI check:  node tools/ui-check.cjs
 *
 * Guards the two mistakes that broke the panel before:
 *   - getElementById("id") for an id that index.html does not define
 *   - el.<key> for a key missing from the el lookup table
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const plugin = path.join(__dirname, "..", "plugin");
const html = fs.readFileSync(path.join(plugin, "index.html"), "utf8");
const app = fs.readFileSync(path.join(plugin, "app.js"), "utf8");

const ids = new Set([...html.matchAll(/id="([a-zA-Z0-9_-]+)"/g)].map((match) => match[1]));
const requested = [...app.matchAll(/getElementById\("([^"]+)"\)/g)].map((match) => match[1]);
const missingIds = [...new Set(requested.filter((id) => !ids.has(id)))];

const table = app.slice(app.indexOf("const el = {"), app.indexOf("};", app.indexOf("const el = {")));
const keys = new Set([...table.matchAll(/^\s{2}([a-zA-Z0-9_]+):/gm)].map((match) => match[1]));
const used = [...new Set([...app.matchAll(/\bel\.([a-zA-Z0-9_]+)/g)].map((match) => match[1]))];
const unknownKeys = used.filter((key) => !keys.has(key));

console.log("ids used by app.js : " + new Set(requested).size);
console.log("el keys declared   : " + keys.size);
console.log("el keys used       : " + used.length);

let failed = false;
if (missingIds.length) {
  failed = true;
  console.log("FAIL missing ids: " + missingIds.join(", "));
}
if (unknownKeys.length) {
  failed = true;
  console.log("FAIL unknown el keys: " + unknownKeys.join(", "));
}
if (!failed) console.log("\nUI references are consistent.");
process.exit(failed ? 1 : 0);
