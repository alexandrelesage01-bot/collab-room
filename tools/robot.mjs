// Un faux collaborateur, pour essayer Collab Room tout seul.
//
//   node tools/robot.mjs            → attend qu'un code de session soit copié
//                                     (clique « Créer une session » dans Live), puis rejoint
//   node tools/robot.mjs K7M-Q2P    → rejoint directement cette session
//   ROBOT_SCENARIO=audio …          → teste l'audio : envoie un accord en WAV sur une piste
//                                     « Robot Audio », et vérifie les rendus reçus de Live
//
// Le robot parle au serveur exactement comme l'Extension (mêmes clés, mêmes messages) :
// il crée sa piste « Robot » avec un Drift, y pose un clip, change d'accord, touche au
// tempo et à son volume, et raconte tout ce que les autres font dans la session.
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";

const SERVER = process.env.COLLAB_SERVER || "https://ableton-collab.alexlesage.workers.dev";
const NAME = "Robot";
const STAY_MINUTES = Number(process.env.ROBOT_MINUTES || 15);
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => new Date().toLocaleTimeString("fr-FR");
const say = (text) => console.log(`[${now()}] 🤖 ${text}`);

function parseCode(text) {
  const s = String(text || "").toUpperCase();
  for (const m of s.matchAll(/\b([A-Z0-9]{3})-?([A-Z0-9]{3})\b/g)) {
    const c = m[1] + m[2];
    if ([...c].every((ch) => ALPHABET.includes(ch))) return c;
  }
  return null;
}
const clipboard = () => {
  try {
    return execFileSync("pbpaste", { encoding: "utf8" });
  } catch {
    return "";
  }
};

// --- le code de la session
let room = parseCode(process.argv[2]);
if (!room) {
  const before = parseCode(clipboard());
  say("J'attends un code de session : dans Live, clique « Créer une session » (le code sera copié).");
  for (let i = 0; i < Number(process.env.ROBOT_WAIT_MINUTES || 20) * 30 && !room; i++) {
    const c = parseCode(clipboard());
    if (c && c !== before) room = c;
    else await sleep(2000);
  }
  if (!room) {
    say("Pas de code reçu, j'abandonne.");
    process.exit(1);
  }
}
const code = room.slice(0, 3) + "-" + room.slice(3);

// --- connexion
const clientId = "robot" + crypto.randomBytes(4).toString("hex");
const ws = new WebSocket(`${SERVER.replace(/^http/, "ws")}/r/${room}/ws?name=${NAME}&id=${clientId}`);
const state = {};
let buf = {};
let ready;
const welcomed = new Promise((r) => (ready = r));
let counter = 0;

function send(pairs) {
  const ops = pairs.map(([k, v]) => {
    if (v === null) delete state[k];
    else state[k] = v;
    return { k, v, id: `${clientId}.${++counter}` };
  });
  ws.send(JSON.stringify({ t: "ops", ops }));
}

const trackName = (tid) => state[`t/${tid}/name`] || "une piste";
function describe(k, v) {
  const p = k.split("/");
  if (k === "song/tempo") return `tempo → ${v}`;
  if (p[0] !== "t") return null;
  const t = `« ${trackName(p[1])} »`;
  if (p.length === 2) return v ? `a créé une piste ${v.kind === "audio" ? "audio" : "MIDI"}` : "a supprimé une piste";
  switch (p[2]) {
    case "name": return `a renommé une piste en « ${v} »`;
    case "mute": return `${v ? "a coupé" : "a réactivé"} ${t}`;
    case "solo": return `${v ? "a mis en solo" : "a retiré le solo de"} ${t}`;
    case "vol": return `volume de ${t} → ${Math.round(v * 100)} %`;
    case "pan": return `panoramique de ${t} → ${v}`;
    case "s": return v ? `clip de ${t}, scène ${Number(p[3]) + 1} : ${v.notes ? `${v.notes.length} notes` : "audio"}${v.name ? ` (« ${v.name} »)` : ""}` : `a supprimé un clip de ${t}`;
    case "a": return v ? `clip d'arrangement de ${t} à ${v.start} temps${v.notes ? `, ${v.notes.length} notes` : ""}` : `a supprimé un clip d'arrangement de ${t}`;
    case "d": return p[4] === "p" ? `a tourné un bouton sur ${t}` : v ? `a placé « ${v.name} » sur ${t}` : `a retiré un device de ${t}`;
  }
  return null;
}

ws.onopen = () => ws.send(JSON.stringify({ t: "hello" }));
ws.onerror = () => {};
ws.onclose = () => {
  say("Connexion fermée.");
  process.exit(0);
};
ws.onmessage = (e) => {
  if (e.data === "pong") return;
  const m = JSON.parse(e.data);
  if (m.t === "welcome") {
    Object.assign(buf, m.state);
    if (!m.more) {
      Object.assign(state, buf);
      ready(m.seq);
    }
  } else if (m.t === "peers") {
    say(`Dans la session : ${m.peers.join(", ")}`);
  } else if (m.t === "ops") {
    let shown = 0;
    for (const op of m.ops) {
      if (op.by === clientId) continue;
      if (op.v === null) delete state[op.k];
      else state[op.k] = op.v;
      const d = describe(op.k, op.v);
      if (d && shown++ < 6) console.log(`[${now()}] 👀 ${m.from} ${d}`);
    }
    if (shown > 6) console.log(`[${now()}] 👀 … et ${shown - 6} autre(s) changement(s)`);
  }
};

const seq = await Promise.race([welcomed, sleep(15000).then(() => -1)]);
if (seq === -1) {
  say("Le serveur ne répond pas.");
  process.exit(1);
}
const tracks = Object.keys(state).filter((k) => /^t\/[^/]+$/.test(k));
if (!tracks.length) {
  say(`La session ${code} est vide : vérifie le code, ou attends que Live ait fini de l'envoyer.`);
  process.exit(1);
}
say(`J'ai rejoint ${code} : ${tracks.length} piste(s), tempo ${state["song/tempo"]}.`);

// --- scénario audio
async function audioScenario() {
  const tempo = state["song/tempo"] || 120;
  const beats = 8;
  const seconds = (beats * 60) / tempo;
  const wav = makeWav(seconds, [130.81, 155.56, 196.0, 261.63]); // Cm
  const hash = crypto.createHash("sha256").update(wav).digest("hex");
  const up = await fetch(`${SERVER}/s/${hash}`, { method: "PUT", body: wav });
  say(`J'envoie un accord de ${seconds.toFixed(1)} s au serveur (${Math.round(wav.length / 1024)} Ko) : ${up.status}`);
  const tid = crypto.randomBytes(4).toString("hex");
  const cid = crypto.randomBytes(4).toString("hex");
  send([[`t/${tid}`, { kind: "audio" }], [`t/${tid}/name`, "Robot Audio"], [`t/${tid}/mute`, false], [`t/${tid}/solo`, false]]);
  await sleep(2000);
  say("Je pose le clip audio au début de l'Arrangement, sur la piste « Robot Audio ».");
  send([[`t/${tid}/a/${cid}`, {
    kind: "audio", name: "Robot – accord", color: null, muted: false, looping: false,
    loopStart: 0, loopEnd: beats, startMarker: 0, endMarker: beats, start: 0, end: beats,
    sample: { hash, name: "robot-accord.wav" },
  }]]);
  say("Si ton Live le reçoit, le clip apparaît dans l'Arrangement (vue Arrangement, piste « Robot Audio »).");
  say("Pour tester l'envoi : glisse un sample sur une piste audio de l'ARRANGEMENT. Je vérifierai le rendu que Live m'enverra.");
  const checked = new Set([hash]);
  const until = Date.now() + STAY_MINUTES * 60_000;
  while (Date.now() < until) {
    for (const [k, v] of Object.entries(state)) {
      if (!/^t\/[^/]+\/a\//.test(k) || v?.kind !== "audio" || !v.sample?.hash || checked.has(v.sample.hash)) continue;
      checked.add(v.sample.hash);
      const r = await fetch(`${SERVER}/s/${v.sample.hash}`);
      if (!r.ok) {
        say(`❌ Le rendu de « ${v.name || v.sample.name} » n'est pas sur le serveur (${r.status}).`);
        continue;
      }
      const buf = Buffer.from(await r.arrayBuffer());
      const same = crypto.createHash("sha256").update(buf).digest("hex") === v.sample.hash;
      say(`✅ Rendu reçu de ton Live : « ${v.sample.name} », ${describeAudio(buf)}${same ? ", intact" : ", ⚠️ empreinte différente"}.`);
    }
    await sleep(2000);
  }
}

function makeWav(seconds, freqs) {
  const rate = 44100;
  const n = Math.round(seconds * rate);
  const data = Buffer.alloc(n * 4);
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    const env = Math.min(1, t * 20) * Math.min(1, (seconds - t) * 4);
    let x = 0;
    for (const f of freqs) x += Math.sin(2 * Math.PI * f * t);
    const v = Math.round((x / freqs.length) * env * 0.5 * 32767);
    data.writeInt16LE(v, i * 4);
    data.writeInt16LE(v, i * 4 + 2);
  }
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + data.length, 4); h.write("WAVE", 8);
  h.write("fmt ", 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(2, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 4, 28); h.writeUInt16LE(4, 32); h.writeUInt16LE(16, 34);
  h.write("data", 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

// Format et durée d'un WAV ou d'un AIFF (Live rend selon son réglage « Record File Type »).
function describeAudio(buf) {
  const kb = `${Math.round(buf.length / 1024)} Ko`;
  const tag = buf.toString("ascii", 0, 4);
  if (tag === "RIFF" && buf.toString("ascii", 8, 12) === "WAVE") {
    let at = 12, ch = 0, rate = 0, bits = 0, dataLen = 0;
    while (at + 8 <= buf.length) {
      const id = buf.toString("ascii", at, at + 4);
      const len = buf.readUInt32LE(at + 4);
      if (id === "fmt ") {
        ch = buf.readUInt16LE(at + 10);
        rate = buf.readUInt32LE(at + 12);
        bits = buf.readUInt16LE(at + 22);
      }
      if (id === "data") dataLen = len;
      at += 8 + len + (len % 2);
    }
    const sec = rate && ch && bits ? dataLen / (rate * ch * (bits / 8)) : 0;
    return `WAV ${ch} canaux, ${rate} Hz, ${bits} bits, ${sec.toFixed(2)} s (${kb})`;
  }
  if (tag === "FORM") return `AIFF (${kb})`;
  return `format inconnu « ${tag} » (${kb})`;
}

if (process.env.ROBOT_SCENARIO === "audio") {
  await audioScenario();
  say("Fin du test audio. Merci !");
  ws.close();
  process.exit(0);
}

// --- le scénario
const note = (pitch, startTime, duration, velocity) => ({
  pitch, startTime, duration, velocity,
  muted: false, probability: 1, velocityDeviation: 0, releaseVelocity: 64,
});
const arp = (chord) => [...Array(8)].map((_, i) => note(chord[i % 4], i * 0.5, 0.45, i % 2 ? 85 : 100));
const clip = (name, notes) => ({
  kind: "midi", name, color: null, muted: false, looping: true,
  loopStart: 0, loopEnd: 4, startMarker: 0, endMarker: 4, notes,
});
const CHORDS = [
  ["Cm", [60, 63, 67, 72]],
  ["Ab", [56, 60, 63, 68]],
  ["Eb", [63, 67, 70, 75]],
  ["Bb", [58, 62, 65, 70]],
];

// Une piste « Robot » déjà là (session précédente) : on la reprend.
const existing = Object.keys(state).find((k) => /^t\/[^/]+\/name$/.test(k) && state[k] === "Robot" && state[k.slice(0, -5)]?.kind === "midi");
const tid = existing ? existing.split("/")[1] : crypto.randomBytes(4).toString("hex");
const T = `t/${tid}`;
await sleep(2000);
if (existing) {
  say("Je reprends ma piste « Robot » de la dernière fois.");
  if (!Object.keys(state).some((k) => k.startsWith(`${T}/d/`) && state[k]?.name === "Drift")) send([[`${T}/d/0`, { name: "Drift" }]]);
  send([[`${T}/vol`, 0.85]]);
} else {
  say("Je crée ma piste « Robot » avec un synthé Drift…");
  send([[T, { kind: "midi" }], [`${T}/name`, "Robot"], [`${T}/mute`, false], [`${T}/solo`, false], [`${T}/d/0`, { name: "Drift" }]]);
}
await sleep(4000);
say("Je pose un clip de 4 temps dans la scène 1 (lance-le pour l'entendre).");
send([[`${T}/s/0`, clip("Robot – Cm", arp(CHORDS[0][1]))]]);
await sleep(6000);
for (const [name, chord] of [...CHORDS.slice(1), CHORDS[0]]) {
  say(`Je change d'accord : ${name}`);
  send([[`${T}/s/0`, clip(`Robot – ${name}`, arp(chord))]]);
  await sleep(6000);
}
say("Je mets le tempo à 124.");
send([["song/tempo", 124]]);
await sleep(4000);
say("Je baisse un peu mon volume.");
send([[`${T}/vol`, 0.7]]);
await sleep(3000);
say(`À toi ! Modifie des notes, renomme une piste, change le tempo… Je te dis ce que je vois pendant ${STAY_MINUTES} minutes.`);
await sleep(STAY_MINUTES * 60_000);
say("Je m'en vais (ma piste reste dans ton Set). Merci !");
ws.close();
