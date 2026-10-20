// Deux (ou trois) faux Live reliés par une salle en mémoire qui utilise le vrai
// cœur du serveur, avec le faux SDK. Lancer : npm test
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { createRequire } from "node:module";
import { FakeLive, memoryNet, client, settle, view, alexSet, liveSet, pair, fakeBind } from "./helpers.mjs";

const require = createRequire(import.meta.url);
const { diff, absorb, parseCode, formatCode, makeCode, lcsIndexes, renderWindow, parseWindowResult } =
  require("../extension/src/extension.js")._test;

// ------------------------------------------------------------ tests

test("rejoindre : le Set de l'autre arrive en entier, les pistes vides partent", async () => {
  const { A, B, a, b } = await pair();
  assert.deepEqual(view(B), view(A));
  assert.equal(B.S.tracks.length, 3);
  assert.ok(!B.S.tracks.some((t) => /MIDI|Audio/.test(B.o(t).name)));
  a.stop();
  b.stop();
});

test("modifs en direct dans les deux sens", async () => {
  const { A, B, a, b } = await pair();
  // Alex ajoute une note à la batterie
  const beat = A.o(A.o(A.trackByName("Drums")).slots[0]).clip;
  A.setNotes(beat, [...A.o(beat).notes, { pitch: 39, startTime: 3, duration: 0.25 }]);
  // Victor renomme la basse et crée une piste avec un clip
  B.o(B.trackByName("Bass")).name = "Sub";
  const keys = B.addTrack("midi", "Keys");
  const chords = B.newMidiClip(0, 8, 8, true);
  B.o(B.o(keys).slots[2]).clip = chords;
  B.setNotes(chords, [{ pitch: 60, startTime: 0, duration: 4 }, { pitch: 64, startTime: 0, duration: 4 }]);
  await settle([a, b]);
  assert.deepEqual(view(A), view(B));
  assert.ok(A.trackByName("Keys") && A.trackByName("Sub"));
  a.stop();
  b.stop();
});

test("conflit sur la même valeur : tout le monde finit d'accord", async () => {
  const { A, B, a, b } = await pair();
  A.S.tempo = 100;
  B.S.tempo = 140;
  await settle([a, b]);
  assert.equal(A.S.tempo, B.S.tempo);
  a.stop();
  b.stop();
});

test("suppression de piste et de clip", async () => {
  const { A, B, a, b } = await pair();
  A.S.tracks = A.S.tracks.filter((t) => A.o(t).name !== "Vox");
  A.o(A.trackByName("Bass")).arr = [];
  await settle([a, b]);
  assert.deepEqual(view(B), view(A));
  assert.equal(B.trackByName("Vox"), undefined);
  a.stop();
  b.stop();
});

test("pas d'écho : une fois synchronisé, plus rien ne circule", async () => {
  const { net, a, b } = await pair();
  const seq = net.core.seq;
  await settle([a, b], 12);
  assert.equal(net.core.seq, seq);
  a.stop();
  b.stop();
});

test("coupure réseau : les modifs faites hors ligne repartent à la reconnexion", async () => {
  const { A, B, a, b } = await pair();
  b.conn.drop();
  A.o(A.trackByName("Drums")).name = "Drums 2";
  const bassMixer = B.o(B.o(B.trackByName("Bass")).mixer);
  B.o(bassMixer.vol).value = Math.fround(0.5);
  await settle([a, b]);
  assert.equal(B.trackByName("Drums 2"), undefined); // pas encore reçu
  b.conn.restore();
  await settle([a, b]);
  assert.deepEqual(view(A), view(B));
  assert.ok(A.trackByName("Drums 2") && B.trackByName("Drums 2"));
  assert.equal(view(A).tracks.find((t) => t.name === "Bass").vol, 0.5);
  a.stop();
  b.stop();
});

test("rejoindre après avoir relancé Live : rien n'est dupliqué", async () => {
  const { net, A, B, a, b } = await pair();
  b.stop();
  const before = view(B);
  const b2 = client(net, B, "Victor", "join");
  await b2.start();
  await settle([a, b2]);
  assert.deepEqual(view(B), before);
  assert.deepEqual(view(A), view(B));
  a.stop();
  b2.stop();
});

test("devices : insertion au milieu, réglages, suppression", async () => {
  const { A, B, a, b } = await pair();
  const drums = A.o(A.trackByName("Drums"));
  const util = A.make(["Device"], { name: "Utility", params: [A.param("Device On", 1), A.param("Gain", 0.7)] });
  drums.devices.unshift(util);
  await settle([a, b]);
  assert.deepEqual(view(B), view(A));
  assert.deepEqual(view(B).tracks.find((t) => t.name === "Drums").devices.map((d) => d.name), ["Utility", "EQ Eight"]);
  drums.devices = drums.devices.filter((d) => A.o(d).name !== "EQ Eight");
  await settle([a, b]);
  assert.deepEqual(view(B), view(A));
  a.stop();
  b.stop();
});

test("plugin absent chez l'autre : un avertissement, pas de boucle infinie", async () => {
  const net = memoryNet();
  const A = alexSet();
  A.addDevice(A.trackByName("Bass"), "Serum");
  const a = client(net, A, "Alex", "create");
  await a.start();
  await settle([a]);
  const b = client(net, liveSet(), "Victor", "join");
  await b.start();
  await settle([a, b]);
  assert.ok(b.events.some((e) => e.type === "warning" && /Serum/.test(e.text)));
  const seq = net.core.seq;
  await settle([a, b], 10);
  assert.equal(net.core.seq, seq);
  a.stop();
  b.stop();
});

test("trois personnes", async () => {
  const { net, A, B, a, b } = await pair();
  const C = new FakeLive();
  C.addTrack("midi");
  const c = client(net, C, "Sam", "join");
  await c.start();
  await settle([a, b, c]);
  C.S.tempo = 90;
  B.o(B.trackByName("Drums")).mute = true;
  await settle([a, b, c]);
  assert.deepEqual(view(A), view(B));
  assert.deepEqual(view(A), view(C));
  [a, b, c].forEach((s) => s.stop());
});

test("piste déplacée (Live lui donne un nouveau handle) : rien n'est recréé chez les autres", async () => {
  const { net, A, B, a, b } = await pair();
  const victorsBass = B.trackByName("Bass").id;
  const seq = net.core.seq;
  A.rehandle(A.trackByName("Bass"), 0);
  await settle([a, b]);
  assert.ok(B.objs.has(victorsBass)); // la piste de Victor n'a pas été supprimée puis recréée
  assert.equal(net.core.seq, seq); // rien n'a circulé
  assert.deepEqual(view(A), view(B));
  a.stop();
  b.stop();
});

test("autre Set ouvert en pleine session : pause sans rien effacer, puis reprise", async () => {
  const { net, A, B, a, b } = await pair();
  const seq = net.core.seq;
  const sessionTracks = A.S.tracks;
  A.S.tracks = [];
  A.addTrack("midi", "Autre projet");
  await settle([a, b]);
  assert.equal(a.paused, true);
  assert.ok(a.events.some((e) => e.type === "setChanged"));
  assert.equal(net.core.seq, seq); // rien envoyé : le Set partagé est intact
  assert.equal(B.S.tracks.length, 3);
  // On rouvre le Set de la session : mêmes pistes, nouveaux handles.
  A.S.tracks = sessionTracks;
  for (const t of [...sessionTracks]) A.rehandle(t);
  await a.resume();
  await settle([a, b]);
  assert.equal(a.paused, false);
  assert.equal(net.core.seq, seq);
  assert.deepEqual(view(A), view(B));
  // et la synchro repart
  A.S.tempo = 101;
  await settle([a, b]);
  assert.equal(B.S.tempo, 101);
  a.stop();
  b.stop();
});

test("bouton tourné sur un device : relu après le délai, appliqué chez l'autre", async () => {
  const { A, B, a, b } = await pair();
  const eq = A.o(A.trackByName("Drums")).devices[0];
  A.o(A.o(eq).params[1]).value = Math.fround(0.9);
  await new Promise((r) => setTimeout(r, 2100)); // PARAM_REFRESH_MS
  await settle([a, b]);
  assert.deepEqual(view(B).tracks.find((t) => t.name === "Drums").devices[0].params, [1, 0.9, 0.25]);
  assert.deepEqual(view(A), view(B));
  a.stop();
  b.stop();
});

test("rendu audio refusé par Live sans message : pas de plantage, réessai possible", async () => {
  const net = memoryNet();
  const A = alexSet();
  const resources = fakeBind(A).ctx.resources;
  const realRender = resources.renderPreFxAudio;
  resources.renderPreFxAudio = () => Promise.reject(); // comme Live : rejet sans erreur
  const a = client(net, A, "Alex", "create");
  await a.start();
  await settle([a]);
  const B = liveSet();
  const b = client(net, B, "Victor", "join");
  await b.start();
  await settle([a, b]);
  assert.ok(a.events.some((e) => e.type === "warning" && /refusé le rendu/.test(e.text)));
  assert.equal(view(B).tracks.find((t) => t.name === "Vox").arr.length, 0); // pas encore d'audio
  // « Synchroniser maintenant » : on réessaie, et cette fois Live accepte.
  resources.renderPreFxAudio = realRender;
  a.renderFailures.clear();
  await settle([a, b]);
  assert.deepEqual(view(A), view(B));
  a.stop();
  b.stop();
});

test("clip audio trop long : pas de rendu, un message clair", async () => {
  const net = memoryNet();
  const A = alexSet();
  const vox = A.o(A.trackByName("Vox"));
  const clip = A.o(vox.arr[0]);
  clip.end = Math.fround(4 + 600); // 600 temps à 120 BPM = 5 min
  let renders = 0;
  const resources = fakeBind(A).ctx.resources;
  const realRender = resources.renderPreFxAudio;
  resources.renderPreFxAudio = (...args) => (renders++, realRender(...args));
  const a = client(net, A, "Alex", "create");
  await a.start();
  await settle([a]);
  assert.equal(renders, 0);
  assert.ok(a.events.some((e) => e.type === "warning" && /trop long/.test(e.text)));
  a.stop();
});

test("envoi du sample refusé par le serveur : le clip n'est pas annoncé", async () => {
  const net = memoryNet();
  net.samples.put = async () => {
    throw new Error("fichier trop gros pour le serveur");
  };
  const A = alexSet();
  const a = client(net, A, "Alex", "create");
  await a.start();
  await settle([a]);
  const vox = Object.entries(net.core.state).find(([k, v]) => /\/a\//.test(k) && v.kind === "audio");
  assert.equal(vox[1].sample, null);
  assert.ok(a.events.some((e) => e.type === "warning" && /trop gros/.test(e.text)));
  a.stop();
});

test("téléchargement d'un sample coupé chez l'invité : réessayé, le clip finit par arriver", async () => {
  const net = memoryNet();
  const realGet = net.samples.get;
  let fails = 1;
  net.samples.get = async (h) => {
    if (fails-- > 0) throw new Error("fetch failed");
    return realGet(h);
  };
  const A = alexSet();
  const a = client(net, A, "Alex", "create");
  await a.start();
  await settle([a]);
  const B = liveSet();
  const b = client(net, B, "Victor", "join");
  await b.start();
  await settle([a, b]);
  assert.equal(view(B).tracks.find((t) => t.name === "Vox").arr.length, 0); // raté une fois
  await new Promise((r) => setTimeout(r, 3100)); // premier nouvel essai
  await settle([a, b]);
  assert.deepEqual(view(A), view(B));
  a.stop();
  b.stop();
});

test("piste audio par défaut avec un EQ Eight chez l'invité : rien n'est ajouté chez l'hôte", async () => {
  const net = memoryNet();
  const A = alexSet();
  const a = client(net, A, "Alex", "create");
  await a.start();
  await settle([a]);
  const B = liveSet();
  B.defaultAudioDevice = "EQ Eight"; // comme le Live d'Alex : EQ Eight sur chaque nouvelle piste audio
  const b = client(net, B, "Victor", "join");
  await b.start();
  await settle([a, b]);
  assert.deepEqual(view(B).tracks.find((t) => t.name === "Vox").devices, []);
  assert.deepEqual(view(A), view(B));
  a.stop();
  b.stop();
});

test("salle vide : rejoindre le signale et n'y envoie rien", async () => {
  const net = memoryNet();
  const b = client(net, liveSet(), "Victor", "join", "NOPE00");
  await b.start();
  assert.equal(b.roomWasEmpty, true);
  await settle([b]);
  assert.equal(net.core.seq, 0);
  b.stop();
});

test("serveur : noms des pistes pour la fenêtre", async () => {
  const { net, a, b } = await pair();
  assert.deepEqual(Object.values(net.core.trackNames()).sort(), ["Bass", "Drums", "Vox"]);
  a.stop();
  b.stop();
});

test("fenêtre : l'état est injecté sans pouvoir casser la page, le script compile", () => {
  const template = fs.readFileSync(new URL("../extension/ui/window.html", import.meta.url), "utf8");
  assert.ok(template.includes("/*__STATE__*/null"));
  const html = renderWindow(template, { name: "</script><b>x", session: null });
  assert.ok(!html.includes("</script><b>"));
  const script = html.match(/<script>([\s\S]*)<\/script>/)[1];
  new vm.Script(script); // erreur de syntaxe → exception
  const state = vm.runInNewContext("(" + script.match(/const STATE = ([\s\S]*?) \|\| \{/)[1] + ")");
  assert.equal(state.name, "</script><b>x");
});

test("fenêtre : lecture du résultat", () => {
  assert.equal(parseWindowResult(""), null);
  assert.equal(parseWindowResult("pas du json"), null);
  assert.equal(parseWindowResult('{"x":1}'), null);
  assert.deepEqual(parseWindowResult('{"action":"join","code":"K7MQ2P","name":"  Victor  ","notifyChanges":1}'), {
    action: "join",
    code: "K7MQ2P",
    name: "Victor",
    notifyChanges: true,
  });
});

test("codes de session", () => {
  for (let i = 0; i < 50; i++) {
    const c = makeCode();
    assert.equal(parseCode(formatCode(c)), c);
    assert.equal(parseCode(`Rejoins-moi : ${formatCode(c).toLowerCase()} !`), c);
  }
  assert.equal(parseCode("bonjour"), null);
  assert.equal(parseCode("ABC-IL0"), null); // lettres ambiguës exclues
});

test("diff, absorb, lcs", () => {
  assert.deepEqual(diff({ a: 1, b: { x: [1] } }, { b: { x: [1] }, c: 2 }), [{ k: "c", v: 2 }, { k: "a", v: null }]);
  const base = { "t/1": {}, "t/1/name": "a", "t/2/name": "b", "t/10/name": "z" };
  const cur = { "t/1/name": "A", "t/2/name": "B" };
  assert.deepEqual(absorb(base, cur, ["t/1"]), { "t/1/name": "A", "t/2/name": "b", "t/10/name": "z" });
  assert.deepEqual([...lcsIndexes(["A", "B", "C"], ["B", "C"])], [1, 2]);
});
