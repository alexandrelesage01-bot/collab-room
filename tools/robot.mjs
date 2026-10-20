// Un faux collaborateur, pour essayer Collab Room tout seul.
//
//   node tools/robot.mjs            → attend qu'un code de session soit copié
//                                     (clique « Créer une session » dans Live), puis rejoint
//   node tools/robot.mjs K7M-Q2P    → rejoint directement cette session
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
  for (let i = 0; i < 600 && !room; i++) {
    const c = parseCode(clipboard());
    if (c && c !== before) room = c;
    else await sleep(2000);
  }
  if (!room) {
    say("Pas de code reçu en 20 minutes, j'abandonne.");
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
