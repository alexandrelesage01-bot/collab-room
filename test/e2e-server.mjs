// Test de bout en bout contre un vrai serveur (wrangler dev, ou le serveur déployé) :
//   cd server && npx wrangler dev        puis, dans un autre terminal :
//   node test/e2e-server.mjs http://localhost:8787
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { FakeLive } = require("./fake-live.js");
const { fakeSdk } = require("./fake-sdk.js");
const { Session, Samples, HttpStore, wsTransport, makeCode } = require("../extension/src/extension.js")._test;

// COLLAB_NO_GLOBAL_WS=1 : comme dans Live, pas de WebSocket global → l'Extension prend ws.
if (process.env.COLLAB_NO_GLOBAL_WS) delete globalThis.WebSocket;
const server = process.argv[2] || "http://localhost:8787";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "collab-e2e-"));
const room = makeCode();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function session(fake, name, mode, dir) {
  const f = fakeSdk(fake);
  return new Session({
    ctx: f.context(),
    sdk: f.classes,
    transport: wsTransport(server),
    samples: new Samples(new HttpStore(server), path.join(tmp, dir)),
    room,
    mode,
    name,
    pollMs: 200,
  });
}

const A = new FakeLive();
A.S.tempo = 126;
const drums = A.addTrack("midi", "Drums");
const beat = A.newMidiClip(0, 4, 4, true);
A.o(A.o(drums).slots[0]).clip = beat;
A.setNotes(beat, [{ pitch: 36, startTime: 0, duration: 0.25 }]);
const vox = A.addTrack("audio", "Vox");
const wav = path.join(tmp, "vox.wav");
fs.writeFileSync(wav, crypto.randomBytes(300_000));
A.o(vox).arr.push(A.newAudioClip(0, 8, wav, true));

const B = new FakeLive();
B.addTrack("midi");

const a = session(A, "Alex", "create", "a");
await a.start();
await wait(800);
const b = session(B, "Victor", "join", "b");
await b.start();
await wait(800);

const names = (L) => L.S.tracks.map((t) => L.o(t).name).sort();
assert.deepEqual(names(B), ["Drums", "Vox"]);
assert.equal(B.S.tempo, 126);
const bVox = B.o(B.trackByName("Vox")).arr[0];
assert.equal(
  crypto.createHash("sha256").update(fs.readFileSync(B.o(bVox).filePath)).digest("hex"),
  crypto.createHash("sha256").update(fs.readFileSync(wav)).digest("hex")
);
console.log("✓ rejoindre : pistes, tempo et audio (300 Ko via le serveur) reçus");

const t0 = Date.now();
A.setNotes(beat, [...A.o(beat).notes, { pitch: 38, startTime: 1, duration: 0.25 }]);
const bBeat = () => B.o(B.o(B.o(B.trackByName("Drums")).slots[0]).clip);
while (bBeat().notes.length !== 2 && Date.now() - t0 < 5000) await wait(20);
assert.equal(bBeat().notes.length, 2);
console.log(`✓ note ajoutée chez Alex → chez Victor en ${Date.now() - t0} ms`);

B.S.tempo = 140;
await wait(1000);
assert.equal(A.S.tempo, 140);
console.log("✓ tempo changé chez Victor → chez Alex");

a.stop();
b.stop();
console.log(`✓ tout bon (salle ${room})`);
process.exit(0);
