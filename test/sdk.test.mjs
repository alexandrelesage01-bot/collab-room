// Les mêmes scénarios, mais avec le VRAI SDK d'Ableton branché sur le faux Live.
// Ils sont sautés tant que le SDK n'est pas installé (voir le README : vendor/ + npm run setup).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { FakeLive, settle, view, pair } from "./helpers.mjs";

const require = createRequire(import.meta.url);
const { fakeActivation } = require("./fake-sdk.js");

let sdk = null;
try {
  sdk = require("@ableton-extensions/sdk");
} catch {}
const skip = sdk ? false : "SDK absent : dépose le .tgz d'Ableton dans vendor/ puis lance npm run setup";

function realBind(fake) {
  if (!fake._real) fake._real = { ctx: sdk.initialize(fakeActivation(fake), "1.0.0"), sdk };
  return fake._real;
}

test("vrai SDK : rejoindre, modifs croisées, devices", { skip }, async () => {
  const { A, B, a, b } = await pair(realBind);
  assert.deepEqual(view(B), view(A));
  const beat = A.o(A.o(A.trackByName("Drums")).slots[0]).clip;
  A.setNotes(beat, [...A.o(beat).notes, { pitch: 39, startTime: 3, duration: 0.25 }]);
  B.o(B.trackByName("Bass")).name = "Sub";
  const drums = A.o(A.trackByName("Drums"));
  drums.devices.unshift(A.make(["Device"], { name: "Utility", params: [A.param("Device On", 1), A.param("Gain", 0.7)] }));
  await settle([a, b]);
  assert.deepEqual(view(A), view(B));
  assert.deepEqual(view(B).tracks.find((t) => t.name === "Drums").devices.map((d) => d.name), ["Utility", "EQ Eight"]);
  a.stop();
  b.stop();
});

test("vrai SDK : coupure réseau puis reconnexion", { skip }, async () => {
  const { A, B, a, b } = await pair(realBind);
  b.conn.drop();
  A.o(A.trackByName("Drums")).name = "Drums 2";
  B.S.tempo = 133;
  await settle([a, b]);
  b.conn.restore();
  await settle([a, b]);
  assert.deepEqual(view(A), view(B));
  assert.equal(A.S.tempo, 133);
  a.stop();
  b.stop();
});

test("vrai SDK : activate() enregistre les menus", { skip }, async () => {
  const { activate } = require("../extension/src/extension.js");
  const fake = new FakeLive();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "collab-sdk-"));
  const activation = fakeActivation(fake, { storageDirectory: dir });
  const host = activation.initializeExtensionHost();
  const menus = [];
  const commands = [];
  host.ui.registerContextMenuAction = (scope, title, id, done) => {
    menus.push(`${scope}:${title}`);
    if (done) done(() => {});
  };
  host.commands.registerCommand = (id) => commands.push(id);
  activate({ initializeExtensionHost: () => host });
  assert.deepEqual(commands, ["collab.window", "collab.sync"]);
  assert.ok(menus.includes("MidiTrack:Collab Room…") && menus.includes("AudioTrack:Synchroniser maintenant"));
  assert.ok(fs.existsSync(path.join(dir, "config.json")));
});
