"use strict";
// Collab Room — produire à plusieurs sur le même Set Ableton, en direct.
//
// L'API des Extensions ne prévient pas quand le Set change : on relit donc le Set
// toutes les POLL_MS millisecondes, on le met à plat (clé → valeur), on compare avec
// le dernier état synchronisé et on envoie les différences au serveur. Les
// changements des autres arrivent par le même WebSocket et sont appliqués au Set.
//
// Tout l'accès à Live passe par le SDK officiel (@ableton-extensions/sdk), que
// package.sh intègre au .ablx avec esbuild, en y inscrivant l'adresse du serveur.

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { execFile, spawn } = require("node:child_process");

/* global __COLLAB_SERVER__ */
const DEFAULT_SERVER = typeof __COLLAB_SERVER__ === "string" ? __COLLAB_SERVER__ : "";
const POLL_MS = 500;
const MAX_PARAMS = 128;
// Chaque lecture de réglage est un aller-retour avec Live : on relit les réglages des
// devices au plus toutes les PARAM_REFRESH_MS, le reste du Set à chaque tour.
const PARAM_REFRESH_MS = 2000;
const MAX_MESSAGE = 200_000;
const SCOPES = ["MidiTrack", "AudioTrack"];
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

// ---------------------------------------------------------------- utilitaires

const r6 = (x) => Math.round(Number(x) * 1e6) / 1e6;
const r3 = (x) => Math.round(Number(x) * 1e3) / 1e3;
const rParam = (x) => Math.round(Number(x) * 1e5) / 1e5;
const num = (x) => (typeof x === "bigint" ? Number(x) : x);
const near = (a, b) => Math.abs(a - b) < 1e-4;
const hid = (obj) => String(obj.handle.id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Live rejette parfois sans aucune erreur (rejet « vide ») : ne jamais lire e.message directement.
const errMsg = (e) => (e && e.message) || (e != null && String(e)) || "erreur inconnue";
const RENDER_RETRY_MS = 60_000;
// Au-delà, le rendu dépasserait ce que le serveur accepte (30 Mo ≈ 2 min 50 en WAV stéréo).
const MAX_AUDIO_SECONDS = 150;
const UPLOAD_RETRY_MS = 30_000;
const APPLY_RETRIES = 3;

function stable(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(stable).join(",") + "]";
  return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + stable(v[k])).join(",") + "}";
}

// Différences de a vers b : [{ k, v }], v === null pour une clé disparue.
function diff(a, b) {
  const ops = [];
  for (const k of Object.keys(b)) if (!(k in a) || stable(a[k]) !== stable(b[k])) ops.push({ k, v: b[k] });
  for (const k of Object.keys(a)) if (!(k in b)) ops.push({ k, v: null });
  return ops;
}

// Reprend dans `base` les valeurs actuelles des clés touchées (et de tout ce qui est en dessous).
function absorb(base, cur, touched) {
  const set = new Set(touched);
  const hit = (k) => {
    for (let i = k.length; i > 0; i = k.lastIndexOf("/", i - 1)) if (set.has(k.slice(0, i))) return true;
    return false;
  };
  const out = { ...base };
  for (const k of Object.keys(out)) if (hit(k) && !(k in cur)) delete out[k];
  for (const k of Object.keys(cur)) if (hit(k)) out[k] = cur[k];
  return out;
}

function normNotes(notes) {
  return (notes || [])
    .map((n) => ({
      pitch: Number(n.pitch),
      startTime: r6(n.startTime),
      duration: r6(n.duration),
      velocity: r3(n.velocity ?? 100),
      muted: !!n.muted,
      probability: r3(n.probability ?? 1),
      velocityDeviation: r3(n.velocityDeviation ?? 0),
      releaseVelocity: r3(n.releaseVelocity ?? 64),
    }))
    .sort((a, b) => a.startTime - b.startTime || a.pitch - b.pitch || a.duration - b.duration);
}

const clipLen = (v) => (v.looping ? v.loopEnd - v.loopStart : v.endMarker - v.startMarker);

function makeCode() {
  let c = "";
  for (let i = 0; i < 6; i++) c += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  return c;
}
function parseCode(text) {
  const s = String(text || "").toUpperCase();
  const valid = (c) => [...c].every((ch) => CODE_ALPHABET.includes(ch));
  for (const m of s.matchAll(/\b([A-Z0-9]{3})-?([A-Z0-9]{3})\b/g)) if (valid(m[1] + m[2])) return m[1] + m[2];
  return null;
}
const formatCode = (c) => c.slice(0, 3) + "-" + c.slice(3);

// Plus longue sous-suite commune (pour réordonner les devices sans tout casser).
function lcsIndexes(a, b) {
  const dp = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const keep = new Set();
  for (let i = 0, j = 0; i < a.length && j < b.length; ) {
    if (a[i] === b[j]) {
      keep.add(i);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
    else j++;
  }
  return keep;
}

// ---------------------------------------------------------------- samples audio

async function sha256File(p) {
  const hash = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(p)) hash.update(chunk);
  return hash.digest("hex");
}

// Une coupure réseau passagère ne doit pas faire perdre un sample : un nouvel essai.
async function fetchRetry(url, opts) {
  try {
    return await fetch(url, opts);
  } catch {
    await sleep(1500);
    return fetch(url, opts);
  }
}

class HttpStore {
  constructor(server) {
    this.base = server.replace(/\/$/, "");
  }
  async has(hash) {
    const r = await fetchRetry(`${this.base}/s/${hash}`, { method: "HEAD" });
    if (r.status === 501) throw new Error("le serveur ne stocke pas encore les samples");
    return r.ok;
  }
  async put(hash, buf) {
    const r = await fetchRetry(`${this.base}/s/${hash}`, { method: "PUT", body: buf });
    if (r.status === 413) throw new Error("fichier trop gros pour le serveur");
    if (!r.ok) throw new Error(`envoi du sample refusé (${r.status})`);
  }
  async get(hash) {
    const r = await fetchRetry(`${this.base}/s/${hash}`);
    if (!r.ok) throw new Error(`sample introuvable sur le serveur (${r.status})`);
    return Buffer.from(await r.arrayBuffer());
  }
}

class Samples {
  // dir : où télécharger (dossier temporaire de l'Extension) ; importer : copie le
  // fichier dans le projet Live (resources.importIntoProject) et rend le nouveau chemin.
  constructor(store, dir, importer = async (p) => p) {
    this.store = store;
    this.dir = dir;
    this.importer = importer;
    this.byPath = new Map(); // chemin → { mtime, size, d }
    this.byHash = new Map(); // empreinte → chemin local
    this.uploaded = new Set();
  }
  async describe(p) {
    if (!p) return null;
    let st;
    try {
      st = await fsp.stat(p);
    } catch {
      return { hash: null, name: path.basename(p) };
    }
    const c = this.byPath.get(p);
    if (c && c.mtime === st.mtimeMs && c.size === st.size) return c.d;
    const d = { hash: await sha256File(p), name: path.basename(p) };
    this.byPath.set(p, { mtime: st.mtimeMs, size: st.size, d });
    this.byHash.set(d.hash, p);
    return d;
  }
  async upload(hash) {
    if (!hash || this.uploaded.has(hash)) return;
    const p = this.byHash.get(hash);
    if (!p) return;
    if (!(await this.store.has(hash))) await this.store.put(hash, await fsp.readFile(p));
    this.uploaded.add(hash);
  }
  async localFile(sample) {
    if (!sample || !sample.hash) throw new Error(`fichier audio manquant chez l'autre (${sample && sample.name})`);
    const known = this.byHash.get(sample.hash);
    if (known) return known;
    const safe = String(sample.name || "sample").replace(/[^\w.\- ]+/g, "_");
    const dest = path.join(this.dir, `${sample.hash.slice(0, 12)}-${safe}`);
    if (!fs.existsSync(dest)) {
      const buf = await this.store.get(sample.hash);
      await fsp.mkdir(this.dir, { recursive: true });
      await fsp.writeFile(dest + ".part", buf);
      await fsp.rename(dest + ".part", dest);
    }
    const imported = await this.importer(dest);
    this.byHash.set(sample.hash, imported);
    this.uploaded.add(sample.hash);
    return imported;
  }
}

// ---------------------------------------------------------------- connexion

// Le contexte où Live exécute les Extensions n'expose pas WebSocket (fetch, si) :
// on prend alors la bibliothèque ws, intégrée au .ablx par esbuild.
function webSocketClass() {
  return typeof WebSocket === "function" ? WebSocket : require("ws");
}

function wsTransport(server) {
  const base = server.replace(/^http/, "ws").replace(/\/$/, "");
  const WS = webSocketClass();
  return ({ room, name, clientId, onOpen, onClose, onMessage }) => {
    let ws = null;
    let closed = false;
    let delay = 1000;
    let retry = null;
    const ping = setInterval(() => {
      if (ws && ws.readyState === 1) ws.send("ping");
    }, 30_000);
    const open = () => {
      ws = new WS(`${base}/r/${room}/ws?name=${encodeURIComponent(name)}&id=${clientId}`);
      ws.onopen = () => {
        delay = 1000;
        onOpen();
      };
      ws.onmessage = (e) => {
        const text = typeof e.data === "string" ? e.data : Buffer.from(e.data).toString();
        if (text === "pong") return;
        try {
          onMessage(JSON.parse(text));
        } catch (err) {
          console.error("Collab Room: message illisible", err);
        }
      };
      ws.onerror = () => {};
      ws.onclose = () => {
        onClose();
        if (!closed) retry = setTimeout(open, (delay = Math.min(delay * 2, 15_000)));
      };
    };
    open();
    return {
      send(m) {
        if (ws && ws.readyState === 1) ws.send(JSON.stringify(m));
      },
      close() {
        closed = true;
        clearTimeout(retry);
        clearInterval(ping);
        if (ws) ws.close();
      },
    };
  };
}

// ---------------------------------------------------------------- session
// `ctx` est le contexte du SDK (initialize) ; `sdk` donne les classes pour
// reconnaître pistes et clips (MidiTrack, AudioTrack, MidiClip, AudioClip).

class Session {
  constructor({ ctx, sdk, transport, samples, room, mode, name, pollMs = POLL_MS, paramRefreshMs = PARAM_REFRESH_MS, onEvent = () => {} }) {
    Object.assign(this, { ctx, sdk, transport, samples, room, mode, name, pollMs, paramRefreshMs, onEvent });
    this.paramCache = new Map(); // id du device → valeurs de ses réglages
    this.audioIds = new Map(); // id partagé d'un clip audio → { fp, sample } (rendu envoyé ou reçu)
    this.renders = new Map(); // rendus audio en cours
    this.renderFailures = new Map(); // id partagé → { fp, at } du dernier rendu refusé
    this.uploadFailures = new Map(); // empreinte → { at, permanent } du dernier envoi raté
    this.retries = []; // changements reçus qui n'ont pas pu s'appliquer, à réessayer
    this.paramsReadAt = 0;
    this.stats = { n: 0, total: 0, max: 0, since: Date.now() };
    this.clientId = crypto.randomBytes(6).toString("hex");
    this.ids = { track: new Map(), clip: new Map() }; // id Live → id partagé
    this.baseline = null; // dernier état synchronisé (null : jamais synchronisé)
    this.pending = new Map(); // clé → id de notre dernière op pas encore confirmée
    this.inbox = [];
    this.welcome = null;
    this.welcomeBuf = null;
    this.peers = [];
    this.gotPeers = false;
    this.connected = false;
    this.ready = false;
    this.roomWasEmpty = false;
    this.auto = true;
    this.paused = false;
    this.removedTids = new Set();
    this.errors = 0;
    this.opCounter = 0;
    this.busy = null;
    this.warned = new Set();
  }

  song() {
    const app = this.ctx.application;
    return app ? app.song : null;
  }
  trackKind(t) {
    if (t instanceof this.sdk.MidiTrack) return "midi";
    if (t instanceof this.sdk.AudioTrack) return "audio";
    return null; // pistes de groupe, retours : pas synchronisées
  }
  clipKind(c) {
    if (c instanceof this.sdk.MidiClip) return "midi";
    if (c instanceof this.sdk.AudioClip) return "audio";
    return null;
  }

  start() {
    const ready = new Promise((res, rej) => {
      this._ready = res;
      this._fail = rej;
    });
    this.conn = this.transport({
      room: this.room,
      name: this.name,
      clientId: this.clientId,
      onOpen: () => {
        this.connected = true;
        this.conn.send({ t: "hello" });
      },
      onClose: () => {
        this.connected = false;
      },
      onMessage: (m) => this.onMessage(m),
    });
    if (this.pollMs > 0) this.timer = setInterval(() => this.loop(), this.pollMs);
    return ready;
  }

  // Après une pause (autre Set ouvert) : on retente ; si le bon Set est revenu, ça repart.
  async resume() {
    if (!this.paused) return this.loop();
    this.paused = false;
    await this.loop();
    if (!this.paused && this.auto && this.pollMs > 0) {
      clearInterval(this.timer);
      this.timer = setInterval(() => this.loop(), this.pollMs);
    }
  }

  stop() {
    clearInterval(this.timer);
    if (this.conn) this.conn.close();
    this.connected = false;
  }

  onMessage(m) {
    if (m.t === "welcome") {
      this.welcomeBuf = Object.assign(this.welcomeBuf || {}, m.state);
      if (!m.more) {
        this.welcome = { state: this.welcomeBuf, seq: m.seq };
        this.welcomeBuf = null;
        this.inbox = []; // l'état complet remplace tout ce qui précède
        this.loop();
      }
    } else if (m.t === "ops") {
      for (const op of m.ops) {
        if (op.by === this.clientId) {
          if (this.pending.get(op.k) === op.id) this.pending.delete(op.k);
          continue;
        }
        // Notre propre op sur cette clé arrivera après au serveur : elle gagnera.
        if (this.pending.has(op.k)) continue;
        this.inbox.push({ k: op.k, v: op.v, from: m.from });
      }
    } else if (m.t === "peers") {
      const before = new Set(this.peers);
      const others = (list) => list.filter((n) => n !== this.name);
      const joined = others(m.peers.filter((n) => !before.has(n)));
      const left = others(this.peers.filter((n) => !m.peers.includes(n)));
      const first = !this.gotPeers; // ceux déjà là quand on arrive : pas de notification
      this.gotPeers = true;
      this.peers = m.peers;
      if (!first && (joined.length || left.length)) this.onEvent({ type: "peers", joined, left, peers: m.peers });
    }
  }

  loop() {
    if (this.busy) return this.busy;
    this.busy = this.tick()
      .then(() => {
        this.errors = 0;
      })
      .catch((e) => this.onTickError(e))
      .finally(() => {
        this.busy = null;
      });
    return this.busy;
  }

  onTickError(e) {
    if (!e || e.code !== "SET_CHANGED" || !this.paused) console.error("Collab Room:", errMsg(e));
    if (!this.ready && this._fail) this._fail(e);
    if (e && e.code === "SET_CHANGED") {
      if (!this.paused) {
        this.paused = true;
        clearInterval(this.timer);
        this.onEvent({ type: "setChanged" });
      }
      return;
    }
    if (++this.errors >= 5 && this.auto && this.pollMs > 0) {
      // Live refuse peut-être les accès hors d'une commande : on passe en manuel.
      clearInterval(this.timer);
      this.auto = false;
      this.onEvent({ type: "manual", error: e });
    }
  }

  async tick() {
    if (this.paused) return; // autre Set ouvert : on attend resume()
    if (this.welcome) {
      const w = this.welcome;
      this.welcome = null;
      await this.syncWelcome(w);
      if (!this.ready) {
        this.ready = true;
        this._ready(this);
      }
      return;
    }
    if (!this.ready || !this.connected || this.baseline === null) return; // hors ligne : les changements locaux attendent
    const t0 = Date.now();
    const cur = await this.readModel();
    if (!cur) return;
    this.measure(Date.now() - t0);
    const ops = diff(this.baseline, cur);
    if (ops.length) await this.send(ops);
    this.baseline = cur;
    if (this.retries.length) {
      const now = Date.now();
      const due = this.retries.filter((r) => r.at <= now);
      this.retries = this.retries.filter((r) => r.at > now);
      this.inbox = [...due, ...this.inbox]; // les plus récents passent après, donc gagnent
    }
    if (this.inbox.length) {
      const batch = this.inbox;
      this.inbox = [];
      await this.applyRemote(batch);
    }
  }

  // Durée de lecture du Set, dans le journal toutes les 30 s (pour régler la cadence).
  measure(ms) {
    const st = this.stats;
    st.n++;
    st.total += ms;
    st.max = Math.max(st.max, ms);
    if (Date.now() - st.since >= 30_000) {
      console.log(`Collab Room: lecture du Set en ${Math.round(st.total / st.n)} ms en moyenne (max ${st.max} ms, ${st.n} tours)`);
      this.stats = { n: 0, total: 0, max: 0, since: Date.now() };
    }
  }

  async send(ops) {
    for (const op of ops) {
      if (op.v && op.v.kind === "audio" && op.v.sample) {
        try {
          await this.samples.upload(op.v.sample.hash);
          this.uploadFailures.delete(op.v.sample.hash);
        } catch (e) {
          const permanent = /trop gros/.test(errMsg(e));
          this.uploadFailures.set(op.v.sample.hash, { at: Date.now(), permanent });
          this.warn("upload", `Audio non partagé${permanent ? "" : " pour l'instant (nouvel essai dans 30 s)"} : ${errMsg(e)}`);
          // Les autres ne pourraient pas le télécharger : on ne l'annonce pas. Il repartira
          // si le clip change (nouveau rendu).
          op.v = { ...op.v, sample: null };
        }
      }
    }
    let batch = [];
    let size = 0;
    const flush = () => {
      if (batch.length) this.conn.send({ t: "ops", ops: batch });
      batch = [];
      size = 0;
    };
    for (const op of ops) {
      const id = `${this.clientId}.${++this.opCounter}`;
      this.pending.set(op.k, id);
      const n = op.k.length + JSON.stringify(op.v).length;
      if (size + n > MAX_MESSAGE) flush();
      batch.push({ k: op.k, v: op.v, id });
      size += n;
    }
    flush();
  }

  async applyRemote(batch) {
    const latest = new Map();
    const from = new Set();
    for (const op of batch) {
      if (this.pending.has(op.k)) continue;
      latest.set(op.k, op.v);
      if (op.from) from.add(op.from);
    }
    if (!latest.size) return;
    const attempts = new Map(batch.filter((op) => op.attempt).map((op) => [op.k, op.attempt]));
    const ops = [...latest].map(([k, v]) => ({ k, v, attempt: attempts.get(k) }));
    await this.applyOps(ops);
    this.queueRetries(this._failed);
    const cur = await this.readModel();
    if (!cur) return;
    const touched = ops.map((o) => o.k);
    for (const o of ops) {
      const p = o.k.split("/");
      if (p[0] === "t" && p[2] === "d") touched.push(`t/${p[1]}/d`);
    }
    touched.push("song/scenes");
    this.baseline = absorb(this.baseline, cur, touched);
    this.onEvent({ type: "remote", count: ops.length, from: [...from] });
  }

  async syncWelcome({ state }) {
    this.roomWasEmpty = Object.keys(state).length === 0;
    if (this.baseline === null) {
      if (this.mode === "join" && this.roomWasEmpty) {
        return; // code faux ou salle vide : on n'envoie rien, l'appli prévient
      }
      if (this.roomWasEmpty) {
        // Création : tout le Set part tout de suite, et on attend que le serveur
        // l'ait reçu, pour que quelqu'un qui rejoint aussitôt le trouve.
        const cur = await this.readModel();
        if (!cur) throw new Error("aucun Set ouvert");
        this.baseline = cur;
        await this.send(diff({}, cur));
        await this.acked(15_000);
        return;
      }
      await this.joinFrom(state);
      return;
    }
    // Reconnexion : nos changements faits hors ligne gagnent, le reste vient du serveur.
    const cur = await this.readModel();
    if (!cur) return;
    const local = new Set([...diff(this.baseline, cur).map((o) => o.k), ...this.pending.keys()]);
    this.inbox = this.inbox.filter((op) => !local.has(op.k));
    const remote = diff(this.baseline, state).filter((op) => !local.has(op.k));
    this.baseline = cur;
    if (local.size) await this.send([...local].map((k) => ({ k, v: k in cur ? cur[k] : null })));
    if (remote.length) await this.applyRemote(remote);
  }

  async joinFrom(S) {
    const song = this.song();
    if (!song) throw new Error("aucun Set ouvert");
    // 1. Pistes déjà là (même projet rouvert) : on les reconnaît par type + nom.
    const remote = Object.keys(S)
      .filter((k) => /^t\/[^/]+$/.test(k))
      .map((k) => ({ tid: k.slice(2), kind: S[k].kind, name: S[k + "/name"] }));
    const local = song.tracks
      .map((t) => ({ t, id: hid(t), kind: this.trackKind(t), name: t.name }))
      .filter((l) => l.kind);
    const used = new Set();
    for (const rt of remote) {
      const twins = remote.filter((o) => o.kind === rt.kind && o.name === rt.name).length;
      const cands = local.filter((l) => !used.has(l.id) && l.kind === rt.kind && l.name === rt.name);
      if (twins === 1 && cands.length === 1) {
        this.ids.track.set(cands[0].id, rt.tid);
        used.add(cands[0].id);
      }
    }
    // 2. Tout l'état de la salle.
    await this.applyOps(Object.entries(S).map(([k, v]) => ({ k, v })));
    this.queueRetries(this._failed);
    // 3. Les pistes vides du Set de départ disparaissent.
    if (remote.length) {
      for (const l of local) {
        if (used.has(l.id) || !this.isEmptyTrack(l.t)) continue;
        try {
          await song.deleteTrack(l.t);
        } catch (e) {
          console.error("Collab Room: piste vide non supprimée", e);
        }
      }
    }
    // 4. Le reste du Set local (pistes non vides) partira au prochain tour.
    const cur = await this.readModel();
    this.baseline = {};
    for (const k of Object.keys(cur)) if (k in S) this.baseline[k] = cur[k];
  }

  async acked(ms) {
    const until = Date.now() + ms;
    while (this.pending.size && Date.now() < until) {
      if (!this.connected) throw new Error("connexion perdue pendant l'envoi du Set");
      await sleep(30);
    }
    if (this.pending.size) throw new Error("le serveur n'a pas tout reçu à temps");
  }

  isEmptyTrack(t) {
    return t.arrangementClips.length === 0 && t.devices.length === 0 && t.clipSlots.every((s) => !s.clip);
  }

  warn(key, text) {
    console.warn("Collab Room:", text);
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.onEvent({ type: "warning", text });
  }

  // ------------------------------------------------ lecture du Set

  tid(t) {
    const id = hid(t);
    let x = this.ids.track.get(id);
    if (!x) {
      x = crypto.randomBytes(4).toString("hex");
      this.ids.track.set(id, x);
    }
    return x;
  }
  cid(c) {
    const id = hid(c);
    let x = this.ids.clip.get(id);
    if (!x) {
      x = crypto.randomBytes(4).toString("hex");
      this.ids.clip.set(id, x);
    }
    return x;
  }

  // Live donne un nouveau handle à une piste ou un clip déplacé, et à tout quand on
  // ouvre un Set. On retrouve donc les pistes perdues par type + nom, et les clips
  // par position ; si plus aucune piste de la session n'est là, c'est un autre Set.
  remapTracks(tracks) {
    const base = this.baseline || {};
    const baseTids = Object.keys(base)
      .filter((k) => /^t\/[^/]+$/.test(k))
      .map((k) => k.slice(2))
      .filter((tid) => !this.removedTids.has(tid)); // supprimées par la synchro elle-même
    if (!baseTids.length) return;
    const present = new Set();
    for (const t of tracks) {
      const tid = this.ids.track.get(hid(t));
      if (tid) present.add(tid);
    }
    const lost = baseTids.filter((tid) => !present.has(tid));
    const sig = (tid) => `${base[`t/${tid}`].kind}\u0000${base[`t/${tid}/name`]}`;
    for (const tid of lost) {
      if (lost.filter((o) => sig(o) === sig(tid)).length !== 1) continue;
      const cands = tracks.filter((t) => !this.ids.track.has(hid(t)) && `${this.trackKind(t)}\u0000${t.name}` === sig(tid));
      if (cands.length === 1) {
        this.ids.track.set(hid(cands[0]), tid);
        present.add(tid);
      }
    }
    if (!baseTids.some((tid) => present.has(tid))) {
      const e = new Error("le Set a changé (ce n'est plus celui de la session)");
      e.code = "SET_CHANGED";
      throw e;
    }
  }

  remapClips(p, clips) {
    const base = this.baseline || {};
    const prefix = `${p}/a/`;
    const used = new Set();
    for (const c of clips) {
      const x = this.ids.clip.get(hid(c));
      if (x) used.add(x);
    }
    for (const c of clips) {
      if (this.ids.clip.has(hid(c))) continue;
      const kind = this.clipKind(c);
      const key = Object.keys(base).find((k) => {
        if (!k.startsWith(prefix) || k.indexOf("/", prefix.length) !== -1) return false;
        const cid = k.slice(prefix.length);
        return !used.has(cid) && base[k].kind === kind && near(base[k].start, c.startTime) && near(base[k].end, c.endTime);
      });
      if (key) {
        this.ids.clip.set(hid(c), key.slice(prefix.length));
        used.add(key.slice(prefix.length));
      }
    }
  }

  async readModel() {
    const song = this.song();
    if (!song) return null;
    const tracks = song.tracks;
    this.remapTracks(tracks);
    const refresh = Date.now() - this.paramsReadAt >= this.paramRefreshMs;
    const cache = new Map();
    const out = {};
    out["song/tempo"] = r3(song.tempo);
    out["song/scenes"] = song.scenes.length;
    for (const t of tracks) {
      const kind = this.trackKind(t);
      if (!kind) continue;
      const p = `t/${this.tid(t)}`;
      out[p] = { kind };
      out[p + "/name"] = t.name;
      out[p + "/mute"] = !!t.mute;
      out[p + "/solo"] = !!t.solo;
      const mixer = t.mixer;
      const [vol, pan] = await Promise.all([mixer.volume.getValue(), mixer.panning.getValue()]);
      out[p + "/vol"] = rParam(vol);
      out[p + "/pan"] = rParam(pan);
      const slots = t.clipSlots;
      for (let i = 0; i < slots.length; i++) {
        const c = slots[i].clip;
        if (c) out[`${p}/s/${i}`] = await this.readClip(c, false);
      }
      const clips = t.arrangementClips;
      this.remapClips(p, clips);
      for (const c of clips) {
        const cid = this.cid(c);
        out[`${p}/a/${cid}`] = await this.readClip(c, true, t, cid);
      }
      const devs = t.devices;
      for (let i = 0; i < devs.length; i++) {
        out[`${p}/d/${i}`] = { name: devs[i].name };
        const key = hid(devs[i]);
        let vals = refresh ? null : this.paramCache.get(key);
        if (!vals) {
          const params = devs[i].parameters.slice(0, MAX_PARAMS);
          vals = (await Promise.all(params.map((q) => q.getValue()))).map(rParam);
        }
        cache.set(key, vals);
        for (let j = 0; j < vals.length; j++) out[`${p}/d/${i}/p/${j}`] = vals[j];
      }
    }
    this.paramCache = cache;
    if (refresh) this.paramsReadAt = Date.now();
    return out;
  }

  async readClip(c, arrangement, t, cid) {
    const kind = this.clipKind(c);
    const v = {
      kind,
      name: c.name,
      color: num(c.color),
      muted: !!c.muted,
      looping: !!c.looping,
      loopStart: r6(c.loopStart),
      loopEnd: r6(c.loopEnd),
      startMarker: r6(c.startMarker),
      endMarker: r6(c.endMarker),
    };
    if (arrangement) {
      v.start = r6(c.startTime);
      v.end = r6(c.endTime);
    }
    if (kind === "midi") v.notes = normNotes(c.notes);
    else if (kind === "audio") v.sample = arrangement ? this.audioSample(t, c, cid) : null;
    return v;
  }

  // Le bac à sable de Live interdit de lire les fichiers de samples. On demande donc à
  // Live un rendu (pré-effets) de la zone du clip, rangé dans notre dossier temporaire,
  // et c'est ce rendu qu'on partage. Il n'est refait que si le clip change.
  // (La vue Session ne se rend pas : ses clips audio ne sont pas partagés.)
  audioFingerprint(c) {
    return stable([c.filePath, r6(c.startTime), r6(c.endTime), r6(c.startMarker), r6(c.endMarker),
      r6(c.loopStart), r6(c.loopEnd), !!c.looping, !!c.warping, num(c.warpMode)]);
  }

  audioSample(t, c, cid) {
    const fp = this.audioFingerprint(c);
    const known = this.audioIds.get(cid);
    if (known && known.fp === fp) {
      const up = known.sample && this.uploadFailures.get(known.sample.hash);
      if (up && (up.permanent || Date.now() - up.at < UPLOAD_RETRY_MS)) return null;
      return known.sample; // (après 30 s, réannoncé : send() retentera l'envoi)
    }
    const failed = this.renderFailures.get(cid);
    if (failed && failed.fp === fp && Date.now() - failed.at < RENDER_RETRY_MS) return null;
    const song = this.song();
    const seconds = ((c.endTime - c.startTime) * 60) / ((song && song.tempo) || 120);
    if (seconds > MAX_AUDIO_SECONDS) {
      this.warn(`long:${cid}`, `Le clip audio « ${c.name || t.name} » dure ${Math.round(seconds / 60)} min : trop long pour être partagé (2 min 30 maximum). Coupe-le en morceaux.`);
      return null;
    }
    if (!this.renders.has(cid)) {
      const where = `piste « ${t.name} », temps ${r3(c.startTime)}–${r3(c.endTime)}`;
      const job = this.renderClip(t, c)
        .then((sample) => {
          if (sample) {
            this.audioIds.set(cid, { fp, sample });
            this.renderFailures.delete(cid);
            console.log(`Collab Room: rendu audio OK (${where})`);
          }
        })
        .catch((e) => {
          this.renderFailures.set(cid, { fp, at: Date.now() });
          console.error(`Collab Room: rendu audio refusé par Live (${where}) : ${errMsg(e)}`);
          this.warn("render", "Live a refusé le rendu d'un clip audio. Clique « Synchroniser maintenant » pour réessayer.");
        })
        .finally(() => this.renders.delete(cid));
      this.renders.set(cid, job);
    }
    return null; // en cours de rendu : la valeur arrivera à un prochain tour
  }

  async renderClip(t, c) {
    const file = await this.ctx.resources.renderPreFxAudio(t, c.startTime, c.endTime);
    const d = await this.samples.describe(file);
    if (!d || !d.hash) return null;
    return { hash: d.hash, name: path.basename(c.filePath || d.name) };
  }

  // ------------------------------------------------ application des changements

  track(tid) {
    const song = this.song();
    if (!song) return null;
    for (const t of song.tracks) if (this.ids.track.get(hid(t)) === tid) return t;
    return null;
  }

  async applyOps(ops) {
    // Pistes d'abord, puis le reste ; les suppressions en dernier.
    const rank = ({ k, v }) => {
      const p = k.split("/");
      if (p[0] === "song") return 0;
      if (p.length === 2) return v === null ? 9 : 1;
      if (p[2] === "d") return p.length === 4 ? 2 : 3;
      return v === null ? 7 : 4;
    };
    ops = ops.slice().sort((a, b) => rank(a) - rank(b));
    this._failed = [];
    this._created = new Set();
    this._deviceTargets = new Map();
    const deviceOps = new Map();
    for (const op of ops) {
      const p = op.k.split("/");
      if (p[0] === "t" && p[2] === "d" && p.length === 4) {
        if (!deviceOps.has(p[1])) deviceOps.set(p[1], []);
        deviceOps.get(p[1]).push(op);
      }
    }
    // Live ajoute aux nouvelles pistes les devices de la piste par défaut de chacun (un
    // EQ Eight, par exemple) : une piste créée pour reproduire celle d'un autre ne doit
    // avoir que ses devices à lui. On passe donc aussi ces pistes-là dans applyDevices.
    const applyAllDevices = async () => {
      for (const tid of this._created) if (!deviceOps.has(tid)) deviceOps.set(tid, []);
      for (const [tid, dops] of deviceOps) await this.safely(`t/${tid}/d`, () => this.applyDevices(tid, dops), dops);
    };
    let devicesDone = false;
    for (const op of ops) {
      if (rank(op) >= 2 && !devicesDone) {
        devicesDone = true;
        await applyAllDevices();
      }
      if (rank(op) === 2) continue;
      await this.safely(op.k, () => this.applyOne(op.k, op.v), [op]);
    }
    if (!devicesDone) await applyAllDevices();
  }

  async safely(key, fn, ops) {
    try {
      await fn();
    } catch (e) {
      console.error(`Collab Room: ${key}: ${errMsg(e)}`);
      this.warn("apply:" + key.split("/").slice(0, 3).join("/"), `Changement non appliqué (${key}) : ${errMsg(e)}`);
      if (this._failed) this._failed.push(...ops);
    }
  }

  // Les changements reçus qui ont échoué (téléchargement coupé…) sont réessayés
  // jusqu'à APPLY_RETRIES fois, de plus en plus espacés. Un changement plus récent
  // sur la même clé passe devant (il arrive après dans la file).
  queueRetries(failed) {
    for (const op of failed) {
      const attempt = (op.attempt || 0) + 1;
      if (attempt > APPLY_RETRIES) continue;
      this.retries.push({ k: op.k, v: op.v, attempt, at: Date.now() + 3000 * attempt });
    }
  }

  async applyOne(k, v) {
    const song = this.song();
    if (!song) return;
    const p = k.split("/");
    if (p[0] === "song") {
      if (p[1] === "tempo" && typeof v === "number") song.tempo = v;
      else if (p[1] === "scenes" && typeof v === "number") await this.ensureScenes(v);
      return;
    }
    if (p[0] !== "t") return;
    const tid = p[1];
    let t = this.track(tid);
    if (p.length === 2) {
      if (v === null) {
        this.removedTids.add(tid);
        if (t) await song.deleteTrack(t);
        for (const [id, x] of this.ids.track) if (x === tid) this.ids.track.delete(id);
        return;
      }
      if (!t) {
        t = await (v.kind === "audio" ? song.createAudioTrack() : song.createMidiTrack());
        this.ids.track.set(hid(t), tid);
        if (this._created) this._created.add(tid);
      }
      return;
    }
    if (!t) return; // piste supprimée entre-temps
    switch (p[2]) {
      case "name":
        if (typeof v === "string" && t.name !== v) t.name = v;
        return;
      case "mute":
        if (v !== null) t.mute = !!v;
        return;
      case "solo":
        if (v !== null) t.solo = !!v;
        return;
      case "vol":
      case "pan":
        if (typeof v === "number") await (p[2] === "vol" ? t.mixer.volume : t.mixer.panning).setValue(v);
        return;
      case "s":
        return this.applySlot(t, Number(p[3]), v);
      case "a":
        return this.applyArrangement(t, p[3], v);
      case "d":
        if (p[4] === "p") return this.applyParam(t, tid, Number(p[3]), Number(p[5]), v);
        return;
    }
  }

  async ensureScenes(n) {
    const song = this.song();
    // On ajoute des scènes, on n'en supprime jamais (ça effacerait des clips).
    for (let i = song.scenes.length; i < n; i++) await song.createScene(i);
  }

  async sameShape(c, v, arrangement, cid) {
    const kind = this.clipKind(c);
    if (kind !== v.kind) return false;
    if (arrangement) {
      if (!near(c.startTime, v.start) || !near(c.endTime, v.end)) return false;
    } else if (kind === "midi") {
      const len = c.looping ? c.loopEnd - c.loopStart : c.endMarker - c.startMarker;
      if (!near(len, clipLen(v))) return false;
    }
    if (kind === "audio") {
      if (!arrangement || !v.sample) return true; // rien à comparer (pas de rendu)
      const known = this.audioIds.get(cid);
      return !!known && known.fp === this.audioFingerprint(c) && known.sample.hash === v.sample.hash;
    }
    return true;
  }

  async applySlot(t, i, v) {
    if (v !== null) await this.ensureScenes(i + 1);
    const slot = t.clipSlots[i];
    if (!slot) return;
    let c = slot.clip;
    if (v === null) {
      if (c) await slot.deleteClip();
      return;
    }
    if (c && !(await this.sameShape(c, v, false))) {
      await slot.deleteClip();
      c = null;
    }
    if (!c) {
      if (v.kind === "midi") {
        if (!(t instanceof this.sdk.MidiTrack)) return;
        c = await slot.createMidiClip(clipLen(v));
      } else {
        this.warn("session-audio", "Les clips audio de la vue Session ne sont pas encore partagés (Live ne sait rendre que l'Arrangement).");
        return;
      }
    }
    this.setClipProps(c, v);
  }

  async applyArrangement(t, cid, v) {
    const clips = t.arrangementClips;
    let c = clips.find((x) => this.ids.clip.get(hid(x)) === cid) || null;
    if (!c && v) {
      // Même projet rouvert : on reconnaît le clip à sa position.
      c = clips.find((x) => !this.ids.clip.has(hid(x)) && near(x.startTime, v.start) && this.clipKind(x) === v.kind) || null;
      if (c) this.ids.clip.set(hid(c), cid);
    }
    if (v === null) {
      if (c) {
        await t.deleteClip(c);
        this.ids.clip.delete(hid(c));
      }
      return;
    }
    if (c && !(await this.sameShape(c, v, true, cid))) {
      await t.deleteClip(c);
      this.ids.clip.delete(hid(c));
      c = null;
    }
    if (!c) {
      if (v.kind === "midi") {
        if (!(t instanceof this.sdk.MidiTrack)) return;
        c = await t.createMidiClip(v.start, v.end - v.start);
      } else {
        if (!(t instanceof this.sdk.AudioTrack)) return;
        if (!v.sample) return; // le rendu n'est pas encore arrivé
        // Un rendu se joue tel quel : pas de warp.
        c = await t.createAudioClip({
          filePath: await this.samples.localFile(v.sample),
          startTime: v.start,
          duration: v.end - v.start,
          isWarped: false,
        });
        this.ids.clip.set(hid(c), cid);
        this.setClipProps(c, v);
        this.audioIds.set(cid, { fp: this.audioFingerprint(c), sample: v.sample });
        console.log(`Collab Room: clip audio reçu et créé (piste « ${t.name} », « ${v.name || v.sample.name} »)`);
        return;
      }
      this.ids.clip.set(hid(c), cid);
    }
    this.setClipProps(c, v);
  }

  setClipProps(c, v) {
    // Une seule transaction : un seul pas d'annulation dans Live.
    this.ctx.withinTransaction(() => {
      if (typeof v.name === "string" && c.name !== v.name) c.name = v.name;
      if (v.color != null && num(c.color) !== v.color) c.color = v.color;
      if (!!c.muted !== !!v.muted) c.muted = !!v.muted;
      if (!!c.looping !== !!v.looping) c.looping = !!v.looping;
      if (v.kind === "midi") {
        if (stable(normNotes(c.notes)) !== stable(v.notes || [])) c.notes = v.notes || [];
      }
    });
  }

  // Les devices d'une piste forment une liste : on calcule la liste voulue
  // (dernier état synchronisé + changements reçus) et on y amène la piste avec
  // le moins de suppressions possible.
  async applyDevices(tid, ops) {
    const t = this.track(tid);
    if (!t) return;
    const want = new Map();
    for (const [k, v] of Object.entries(this.baseline || {})) {
      const m = k.match(/^t\/([^/]+)\/d\/(\d+)$/);
      if (m && m[1] === tid) want.set(Number(m[2]), v.name);
    }
    for (const op of ops) {
      const i = Number(op.k.split("/")[3]);
      if (op.v === null) want.delete(i);
      else want.set(i, op.v.name);
    }
    const target = [...want].sort((a, b) => a[0] - b[0]).map(([, n]) => n);
    this._deviceTargets.set(tid, target);

    const devs = t.devices;
    const names = devs.map((d) => d.name);
    const keep = lcsIndexes(names, target);
    for (let i = devs.length - 1; i >= 0; i--) if (!keep.has(i)) await t.deleteDevice(devs[i]);
    const kept = names.filter((_, i) => keep.has(i));
    let k = 0;
    let pos = 0;
    for (const name of target) {
      if (kept[k] === name) {
        k++;
        pos++;
        continue;
      }
      try {
        await t.insertDevice(name, pos);
        pos++;
      } catch (e) {
        this.warn("device:" + name, `Device « ${name} » introuvable ici (plugin absent ?) : ${errMsg(e)}`);
      }
    }
  }

  async applyParam(t, tid, i, j, v) {
    if (typeof v !== "number") return;
    const d = t.devices[i];
    if (!d) return;
    const target = this._deviceTargets && this._deviceTargets.get(tid);
    if (target && target[i] !== d.name) return; // device décalé : on ne touche pas
    const param = d.parameters[j];
    if (!param) return;
    await param.setValue(v);
    const vals = this.paramCache.get(hid(d));
    if (vals && j < vals.length) vals[j] = rParam(v);
  }
}

// ---------------------------------------------------------------- interface

function run(cmd, args, input) {
  return new Promise((res, rej) => {
    const child = spawn(cmd, args);
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.on("error", rej);
    child.on("close", () => res(out));
    if (input != null) child.stdin.end(input);
    else child.stdin.end();
  });
}

const clipboard = {
  read: () =>
    process.platform === "win32" ? run("powershell", ["-NoProfile", "-Command", "Get-Clipboard"]) : run("pbpaste", []),
  write: (text) => (process.platform === "win32" ? run("clip", [], text) : run("pbcopy", [], text)),
};

function notify(text) {
  console.log("Collab Room:", text);
  if (process.platform === "darwin") {
    execFile("osascript", ["-e", `display notification ${JSON.stringify(text)} with title "Collab Room"`], () => {});
  }
}

class App {
  constructor(ctx, sdk) {
    this.ctx = ctx;
    this.sdk = sdk;
    this.session = null;
    this.clipboard = clipboard;
    this.notify = notify;
    this.dir = ctx.environment.storageDirectory || path.join(os.homedir(), ".collab-room");
    this.config = this.loadConfig();
  }

  loadConfig() {
    const file = path.join(this.dir, "config.json");
    const defaults = { server: "", name: os.userInfo().username, notifyChanges: false, pollMs: POLL_MS };
    try {
      return { ...defaults, ...JSON.parse(fs.readFileSync(file, "utf8")) };
    } catch {
      try {
        fs.mkdirSync(this.dir, { recursive: true });
        fs.writeFileSync(file, JSON.stringify(defaults, null, 2));
      } catch {}
      return defaults;
    }
  }

  saveConfig(patch) {
    this.config = { ...this.config, ...patch };
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.writeFileSync(path.join(this.dir, "config.json"), JSON.stringify(this.config, null, 2));
    } catch (e) {
      console.error("Collab Room: config.json non enregistré", e);
    }
  }

  server() {
    const s = this.config.server || DEFAULT_SERVER;
    if (!/^https?:\/\//.test(s)) {
      throw new Error(`aucun serveur configuré. Indique son adresse dans ${path.join(this.dir, "config.json")}`);
    }
    return s;
  }

  register() {
    const commands = [
      ["collab.window", "Collab Room…", () => this.openWindow()],
      ["collab.sync", "Synchroniser maintenant", () => this.syncNow()],
    ];
    for (const [id, title, fn] of commands) {
      this.ctx.commands.registerCommand(id, () => {
        fn().catch((e) => {
          console.error("Collab Room:", e);
          this.flash(`Erreur : ${errMsg(e)}`, 4000);
        });
      });
      for (const scope of SCOPES) {
        Promise.resolve(this.ctx.ui.registerContextMenuAction(scope, title, id)).catch((e) =>
          console.error(`Collab Room: menu ${scope} non ajouté`, e)
        );
      }
    }
    console.log("Collab Room chargée ✓ — clic droit sur une piste → Collab Room…");
  }

  // Une boîte de dialogue qui se ferme toute seule.
  flash(text, ms = 3000) {
    return this.ctx.ui.withinProgressDialog(text, {}, () => sleep(ms)).catch(() => {});
  }

  // Une boîte d'attente pendant `promise` ; « Annuler » appelle onCancel.
  withProgress(text, promise, onCancel) {
    // La boîte s'ouvre un peu plus tard : sans ce catch, un échec immédiat serait une
    // promesse rejetée « non gérée », et Live arrêterait toute l'Extension.
    promise.catch(() => {});
    return this.ctx.ui.withinProgressDialog(text, {}, (_update, signal) =>
      new Promise((res, rej) => {
        signal.addEventListener("abort", () => {
          if (onCancel) onCancel();
          rej(new Error("annulé"));
        });
        promise.then(res, rej);
      })
    );
  }

  // ------------------------------------------------ la fenêtre

  windowState(notice) {
    const s = this.session;
    let server = "";
    try {
      server = this.server();
    } catch {}
    return {
      name: this.config.name,
      server,
      clipboardCode: this.clipboardCode || "",
      notifyChanges: !!this.config.notifyChanges,
      notice: notice || (server ? null : { kind: "error", text: "Aucun serveur configuré : refais le .ablx avec package.sh, ou remplis config.json." }),
      session: s ? { room: s.room, code: formatCode(s.room), connected: s.connected, auto: s.auto, paused: s.paused, peers: s.peers } : null,
    };
  }

  async showWindow(notice) {
    const html = renderWindow(windowTemplate(), this.windowState(notice));
    const url = "data:text/html;charset=utf-8," + encodeURIComponent(html);
    const raw = await this.ctx.ui.showModalDialog(url, 460, this.session ? 600 : 480).catch((e) => {
      console.error("Collab Room: fenêtre", e);
      return null;
    });
    return parseWindowResult(raw);
  }

  // La fenêtre ne peut parler à l'Extension qu'en se fermant : chaque bouton la
  // ferme avec une action, on l'exécute, puis on la rouvre si besoin.
  async openWindow() {
    let notice = null;
    for (;;) {
      this.clipboardCode = this.session ? "" : parseCode(await this.clipboard.read().catch(() => ""));
      const r = await this.showWindow(notice);
      notice = null;
      if (!r) return;
      const patch = { notifyChanges: r.notifyChanges };
      if (r.name && !this.session) patch.name = r.name;
      this.saveConfig(patch);
      try {
        if (r.action === "create") {
          const code = await this.create();
          notice = { kind: "info", text: `Session ${formatCode(code)} créée. Le code est copié : envoie-le à tes potes.` };
        } else if (r.action === "join") {
          const others = await this.join(r.code);
          notice = { kind: "info", text: others.length ? `Connecté, avec ${others.join(", ")}.` : "Connecté." };
        } else if (r.action === "sync") {
          return await this.syncNow();
        } else if (r.action === "leave") {
          await this.leave();
          notice = { kind: "info", text: "Session quittée. Ton Set reste tel quel." };
        } else return;
      } catch (e) {
        console.error("Collab Room:", e);
        const m = errMsg(e);
        notice = { kind: "error", text: m.charAt(0).toUpperCase() + m.slice(1) };
      }
    }
  }

  // ------------------------------------------------ sessions

  newSession(room, mode) {
    const server = this.server();
    return new Session({
      ctx: this.ctx,
      sdk: this.sdk,
      transport: wsTransport(server),
      samples: new Samples(
        new HttpStore(server),
        path.join(this.ctx.environment.tempDirectory || this.dir, "samples"),
        (file) => this.ctx.resources.importIntoProject(file)
      ),
      room,
      mode,
      name: this.config.name,
      pollMs: this.config.pollMs,
      onEvent: (e) => this.onEvent(e),
    });
  }

  onEvent(e) {
    if (e.type === "peers") {
      for (const n of e.joined) this.notify(`${n} a rejoint la session`);
      for (const n of e.left) this.notify(`${n} est parti·e`);
    } else if (e.type === "remote" && this.config.notifyChanges) {
      this.notify(`${e.from.join(", ") || "Quelqu'un"} : ${e.count} changement(s)`);
    } else if (e.type === "warning") {
      this.notify(e.text);
    } else if (e.type === "setChanged") {
      this.notify("Tu as ouvert un autre Set : la session est en pause. Rouvre le Set de la session puis « Synchroniser maintenant », ou quitte la session.");
    } else if (e.type === "manual") {
      this.notify("Synchro automatique impossible ici : utilise « Synchroniser maintenant ».");
    }
  }

  async startSession(code, mode, text) {
    await this.leave();
    const session = this.newSession(code, mode);
    const started = new Promise((res, rej) => {
      const timer = setTimeout(() => rej(new Error("pas de réponse du serveur")), 20_000);
      Promise.resolve()
        .then(() => session.start())
        .then(
        (v) => {
          clearTimeout(timer);
          res(v);
        },
        (e) => {
          clearTimeout(timer);
          rej(e);
        }
      );
    });
    try {
      await this.withProgress(text, started, () => session.stop());
    } catch (e) {
      session.stop();
      throw e;
    }
    this.session = session;
    return session;
  }

  async create() {
    const code = makeCode();
    await this.startSession(code, "create", "Création de la session…");
    await this.clipboard.write(formatCode(code)).catch(() => {});
    return code;
  }

  async join(text) {
    const code = parseCode(text);
    if (!code) throw new Error("code invalide. Il ressemble à K7M-Q2P.");
    const session = await this.startSession(code, "join", `Connexion à ${formatCode(code)}…`);
    if (session.roomWasEmpty) {
      await this.leave();
      throw new Error(`la session ${formatCode(code)} n'existe pas ou est vide. Vérifie le code.`);
    }
    return session.peers.filter((n) => n !== this.config.name);
  }

  async syncNow() {
    if (!this.session) return this.flash("Pas de session en cours.\nClic droit → Collab Room… pour en créer ou en rejoindre une.");
    this.session.renderFailures.clear(); // depuis une commande, Live accepte peut-être le rendu
    await this.session.resume();
    await Promise.all([...this.session.renders.values()]);
    await sleep(600); // le temps que les accusés et les changements des autres arrivent
    await this.session.loop();
    if (this.session.paused) return this.flash("Ce n'est pas le Set de la session : rouvre-le, ou quitte la session.", 4000);
    await this.flash("Synchronisé.", 1500);
  }

  async leave() {
    if (!this.session) return;
    this.session.stop();
    this.session = null;
  }
}

// esbuild intègre la page au bundle (--loader:.html=text) ; sans bundle (tests),
// on la lit sur le disque.
function windowTemplate() {
  try {
    return require("../ui/window.html");
  } catch {
    return fs.readFileSync(path.join(__dirname, "..", "ui", "window.html"), "utf8");
  }
}

// Injecte l'état dans la page (« < » échappé : aucune valeur ne peut sortir du <script>).
function renderWindow(template, state) {
  return template.replace("/*__STATE__*/null", JSON.stringify(state).replace(/</g, "\\u003c"));
}

function parseWindowResult(raw) {
  let r;
  try {
    r = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!r || typeof r !== "object" || typeof r.action !== "string") return null;
  return {
    action: r.action,
    code: typeof r.code === "string" ? r.code : "",
    name: typeof r.name === "string" ? r.name.trim().slice(0, 40) : "",
    notifyChanges: !!r.notifyChanges,
  };
}

function activate(activation) {
  // Chargé ici (et non en haut du fichier) pour que les tests puissent utiliser
  // le reste du module sans le SDK ; esbuild l'intègre quand même au .ablx.
  const sdk = require("@ableton-extensions/sdk");
  const ctx = sdk.initialize(activation, "1.0.0");
  const globals = ["WebSocket", "fetch", "setInterval", "Buffer", "URL", "TextDecoder", "AbortController", "process"];
  console.log("Collab Room: globaux disponibles :", globals.map((g) => `${g}=${typeof globalThis[g] !== "undefined"}`).join(" "));
  new App(ctx, sdk).register();
}

module.exports = {
  activate,
  _test: { App, Session, Samples, HttpStore, wsTransport, renderWindow, parseWindowResult, diff, absorb, normNotes, stable, parseCode, formatCode, makeCode, lcsIndexes },
};
