// Outils communs aux tests : salle en mémoire (vrai cœur du serveur), faux Live,
// Sets de départ et vue comparable d'un Set.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { RoomCore } from "../server/src/room-core.js";

const require = createRequire(import.meta.url);
export const { FakeLive } = require("./fake-live.js");
const { fakeSdk } = require("./fake-sdk.js");
const { Session, Samples } = require("../extension/src/extension.js")._test;

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "collab-test-"));

// ------------------------------------------------------------ salle en mémoire

export function memoryNet() {
  const core = new RoomCore();
  const clients = new Set();
  const deliver = (c, m) => {
    const data = JSON.stringify(m);
    setImmediate(() => c.up && c.onMessage(JSON.parse(data)));
  };
  const peers = () => {
    const list = [...clients].filter((c) => c.up).map((c) => c.name);
    for (const c of clients) deliver(c, { t: "peers", peers: list });
  };
  const store = new Map();
  return {
    core,
    samples: {
      has: async (h) => store.has(h),
      put: async (h, b) => void store.set(h, Buffer.from(b)),
      get: async (h) => {
        if (!store.has(h)) throw new Error("absent");
        return store.get(h);
      },
    },
    transport: ({ name, clientId, onOpen, onClose, onMessage }) => {
      const c = { name, onMessage, up: true };
      clients.add(c);
      setImmediate(onOpen);
      return {
        send(m) {
          if (!c.up) return;
          const data = JSON.stringify(m);
          setImmediate(() => {
            if (!c.up) return;
            const msg = JSON.parse(data);
            if (msg.t === "hello") {
              for (const w of core.welcome(1500)) deliver(c, w); // petits morceaux : teste le découpage
              peers();
            } else if (msg.t === "ops") {
              const out = core.apply(clientId, msg.ops);
              for (const x of clients) deliver(x, { t: "ops", from: name, ops: out });
            }
          });
        },
        close() {
          c.up = false;
          clients.delete(c);
          onClose();
          peers();
        },
        drop() {
          c.up = false;
          onClose();
        },
        restore() {
          c.up = true;
          setImmediate(onOpen);
        },
      };
    },
  };
}

// Branche un faux Live sur le faux SDK (par défaut) ou sur le vrai (test/sdk.test.mjs).
export function fakeBind(fake) {
  if (!fake._bound) {
    const f = fakeSdk(fake);
    fake._bound = { ctx: f.context(), sdk: f.classes };
  }
  return fake._bound;
}

let clientN = 0;
export function client(net, fake, name, mode, room = "ROOM01", bind = fakeBind) {
  const events = [];
  const { ctx, sdk } = bind(fake);
  const s = new Session({
    ctx,
    sdk,
    transport: net.transport,
    samples: new Samples(net.samples, path.join(TMP, `c${++clientN}`, "samples")),
    room,
    mode,
    name,
    pollMs: 0, // les tests font tourner la boucle eux-mêmes
    onEvent: (e) => events.push(e),
  });
  s.events = events;
  return s;
}

export const wait = (ms = 3) => new Promise((r) => setTimeout(r, ms));
export async function settle(sessions, rounds = 8) {
  for (let i = 0; i < rounds; i++) {
    await wait();
    for (const s of sessions) await s.loop();
  }
  await wait();
}

// ------------------------------------------------------------ vue comparable d'un Set

const rr = (x) => Math.round(x * 1e4) / 1e4;
const fileHash = (p) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");

export function view(L) {
  const clip = (h) => {
    const c = L.o(h);
    const v = { kind: c.classes[0], name: c.name, muted: c.muted, looping: c.looping, len: rr(c.loopEnd - c.loopStart) };
    if (c.notes) v.notes = c.notes.map((n) => [n.pitch, rr(n.startTime), rr(n.duration), n.velocity]).sort();
    if (c.filePath) v.audio = fileHash(c.filePath);
    return v;
  };
  return {
    tempo: rr(L.S.tempo),
    tracks: L.S.tracks
      .map((t) => {
        const x = L.o(t);
        const mixer = L.o(x.mixer);
        const slots = {};
        x.slots.forEach((s, i) => {
          if (L.o(s).clip) slots[i] = clip(L.o(s).clip);
        });
        return {
          kind: x.classes[0],
          name: x.name,
          mute: x.mute,
          vol: rr(L.o(mixer.vol).value),
          slots,
          arr: x.arr
            .map((c) => ({ start: rr(L.o(c).start), end: rr(L.o(c).end), ...clip(c) }))
            .sort((a, b) => a.start - b.start),
          devices: x.devices.map((d) => ({ name: L.o(d).name, params: L.o(d).params.map((p) => rr(L.o(p).value)) })),
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}

// Le Set d'Alex : une batterie en session, une basse en arrangement, une voix audio.
export function alexSet() {
  const A = new FakeLive();
  A.S.tempo = 128;
  const drums = A.addTrack("midi", "Drums");
  const loop = A.newMidiClip(0, 4, 4, true);
  A.o(A.o(drums).slots[0]).clip = loop;
  A.o(loop).name = "Beat";
  A.setNotes(loop, [
    { pitch: 36, startTime: 0, duration: 0.25 },
    { pitch: 38, startTime: 1, duration: 0.25, velocity: 90 },
    { pitch: 42, startTime: 0.5, duration: 0.1 },
  ]);
  const eq = A.addDevice(drums, "EQ Eight");
  A.o(A.o(eq).params[2]).value = Math.fround(0.25);
  const bass = A.addTrack("midi", "Bass");
  const line = A.newMidiClip(8, 16, 8, false);
  A.o(bass).arr.push(line);
  A.setNotes(line, [{ pitch: 33, startTime: 0, duration: 2 }]);
  const vox = A.addTrack("audio", "Vox");
  const wav = path.join(TMP, "vox.wav");
  fs.writeFileSync(wav, crypto.randomBytes(5000));
  A.o(vox).arr.push(A.newAudioClip(4, 12, wav, true));
  return A;
}

export function liveSet() {
  // Set vide par défaut de Live : 2 pistes MIDI, 2 pistes audio.
  const B = new FakeLive();
  B.addTrack("midi");
  B.addTrack("midi");
  B.addTrack("audio");
  B.addTrack("audio");
  return B;
}

export async function pair(bind = fakeBind) {
  const net = memoryNet();
  const A = alexSet();
  const B = liveSet();
  const a = client(net, A, "Alex", "create", "ROOM01", bind);
  await a.start();
  await settle([a]);
  const b = client(net, B, "Victor", "join", "ROOM01", bind);
  await b.start();
  await settle([a, b]);
  return { net, A, B, a, b };
}

