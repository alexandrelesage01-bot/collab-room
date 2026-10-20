// Le parcours complet par la fenêtre, contre un vrai serveur (wrangler dev) :
//   node test/e2e-window.mjs http://localhost:8787
// Live est remplacé par le faux Live ; la fenêtre par un « clic » scripté qui lit
// l'état injecté dans la page et renvoie ce qu'enverrait le bouton.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { FakeLive } = require("./fake-live.js");
const { fakeSdk } = require("./fake-sdk.js");
const { App } = require("../extension/src/extension.js")._test;

// COLLAB_NO_GLOBAL_WS=1 : comme dans Live, pas de WebSocket global → l'Extension prend ws.
const BrowserWebSocket = globalThis.WebSocket; // la fenêtre (webview) a le sien
if (process.env.COLLAB_NO_GLOBAL_WS) delete globalThis.WebSocket;
const server = process.argv[2] || "http://localhost:8787";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "collab-window-"));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function fakeHost(fake, name, clicks) {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ server, name, pollMs: 200 }));
  const windows = [];
  const f = fakeSdk(fake);
  const ctx = f.context({
    environment: { storageDirectory: dir },
    commands: { registerCommand: () => {} },
    ui: {
      registerContextMenuAction: async () => async () => {},
      withinProgressDialog: (_text, _opts, cb) => cb(async () => {}, new AbortController().signal),
      showModalDialog: async (url) => {
        assert.ok(url.startsWith("data:text/html;charset=utf-8,"));
        const html = decodeURIComponent(url.slice(url.indexOf(",") + 1));
        const state = JSON.parse(html.match(/const STATE = ([\s\S]*?) \|\| \{/)[1]);
        windows.push(state);
        const click = clicks.shift();
        await wait(0);
        if (!click) throw new Error("fenêtre fermée");
        return JSON.stringify(click(state));
      },
    },
  });
  const app = new App(ctx, f.classes);
  let clip = "";
  app.notify = (t) => console.log(`   [notification ${name}] ${t}`);
  app.clipboard = { read: async () => clip, write: async (t) => void (clip = t) };
  app.setClipboard = (t) => (clip = t);
  app.getClipboard = () => clip;
  return { app, windows };
}

// --- Alex crée une session depuis la fenêtre
const A = new FakeLive();
A.S.tempo = 124;
A.addTrack("midi", "Drums");
A.addTrack("midi", "Bass");
const alex = fakeHost(A, "Alex", [
  (s) => (assert.equal(s.session, null), { action: "create", name: "Alex", notifyChanges: false }),
  (s) => (assert.ok(s.session && s.notice.kind === "info"), { action: "close", name: "Alex" }),
]);
await alex.app.openWindow();
const code = alex.windows[1].session.code;
assert.match(code, /^[A-Z0-9]{3}-[A-Z0-9]{3}$/);
assert.equal(alex.app.getClipboard(), code);
console.log(`✓ Alex : « Créer une session » → code ${code}, copié dans le presse-papiers`);

// --- Victor colle le code : la fenêtre le propose déjà, il clique « Rejoindre »
const B = new FakeLive();
B.addTrack("midi");
const victor = fakeHost(B, "Victor", [
  (s) => (assert.equal(s.clipboardCode, code.replace("-", "")), { action: "join", code: s.clipboardCode, name: "Victor" }),
  (s) => (assert.ok(s.session.peers.includes("Alex")), { action: "close", name: "Victor" }),
]);
victor.app.setClipboard(`yo rejoins : ${code}`);
await victor.app.openWindow();
assert.deepEqual(B.S.tracks.map((t) => B.o(t).name).sort(), ["Bass", "Drums"]);
assert.equal(B.S.tempo, 124);
console.log(`✓ Victor : code pré-rempli, « Rejoindre » → le Set d'Alex est arrivé ; la fenêtre affiche ${victor.windows[1].notice.text}`);

// --- Code faux : message d'erreur dans la fenêtre, rien n'est envoyé
const C = new FakeLive();
C.addTrack("midi", "Perso");
const sam = fakeHost(C, "Sam", [
  () => ({ action: "join", code: "ZZZZZZ", name: "Sam" }),
  (s) => (assert.equal(s.notice.kind, "error"), { action: "close", name: "Sam" }),
]);
await sam.app.openWindow();
assert.equal(sam.app.session, null);
console.log(`✓ Sam : code faux → « ${sam.windows[1].notice.text} »`);

// --- La fenêtre observatrice : participants et activité en direct
const room = code.replace("-", "");
const ws = new BrowserWebSocket(`${server.replace(/^http/, "ws")}/r/${room}/ws?watch=1&name=Victor`);
const got = [];
ws.onmessage = (e) => got.push(JSON.parse(e.data));
await new Promise((r) => (ws.onopen = r));
ws.send(JSON.stringify({ t: "hello" }));
await wait(300);
const summary = got.find((m) => m.t === "summary");
assert.deepEqual(summary.peers.sort(), ["Alex", "Victor"]); // la fenêtre ne compte pas
assert.deepEqual(Object.values(summary.names).sort(), ["Bass", "Drums"]);
A.o(A.trackByName("Bass")).name = "Sub";
await wait(800);
const ops = got.filter((m) => m.t === "ops");
assert.ok(ops.some((m) => m.from === "Alex" && m.ops.some((o) => o.k.endsWith("/name") && o.v === "Sub")));
assert.ok(B.trackByName("Sub"));
console.log("✓ Fenêtre observatrice : participants Alex + Victor, voit passer « Alex a renommé une piste en Sub »");

ws.close();
alex.app.leave();
victor.app.leave();
console.log("✓ tout bon");
process.exit(0);
