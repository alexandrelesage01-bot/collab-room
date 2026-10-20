// Serveur Collab Room : un Worker Cloudflare, entièrement dans l'offre gratuite.
//   GET  /r/<SALLE>/ws   → WebSocket vers la salle (un Durable Object par salle)
//   HEAD/GET/PUT /s/<sha256> → samples audio, rangés par empreinte dans des Durable
//                             Objects (pas de R2, donc pas de moyen de paiement)

import { DurableObject } from "cloudflare:workers";
import { RoomCore } from "./room-core.js";

const MAX_SAMPLE = 30 * 1024 * 1024; // un rendu de clip : largement assez
const CHUNK = 1024 * 1024; // une valeur de Durable Object : 2 Mo maximum

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    let m = url.pathname.match(/^\/r\/([A-Z0-9]{4,16})\/ws$/);
    if (m) {
      if (req.headers.get("Upgrade") !== "websocket") return new Response("WebSocket attendu", { status: 426 });
      return env.ROOMS.get(env.ROOMS.idFromName(m[1])).fetch(req);
    }
    m = url.pathname.match(/^\/s\/([a-f0-9]{64})$/);
    if (m) return samples(req, env, m[1]);
    if (url.pathname === "/") return new Response("Collab Room : serveur OK\n");
    return new Response("Introuvable", { status: 404 });
  },
};

// 256 compartiments (d'après le début de l'empreinte) pour ne pas remplir un seul objet.
function samples(req, env, hash) {
  return env.SAMPLES.get(env.SAMPLES.idFromName("samples-" + hash.slice(0, 2))).fetch(req);
}

export class SampleStore extends DurableObject {
  async fetch(req) {
    const hash = new URL(req.url).pathname.split("/").pop();
    const meta = await this.ctx.storage.get("m:" + hash);
    if (req.method === "HEAD") return new Response(null, { status: meta ? 200 : 404 });
    if (req.method === "GET") {
      if (!meta) return new Response("Introuvable", { status: 404 });
      const keys = [...Array(meta.chunks)].map((_, i) => `c:${hash}:${i}`);
      const parts = [];
      for (let i = 0; i < keys.length; i += 128) {
        const got = await this.ctx.storage.get(keys.slice(i, i + 128));
        for (const k of keys.slice(i, i + 128)) parts.push(new Uint8Array(got.get(k)));
      }
      const body = new Uint8Array(meta.size);
      let at = 0;
      for (const p of parts) {
        body.set(p, at);
        at += p.byteLength;
      }
      return new Response(body, { headers: { "Content-Type": "application/octet-stream" } });
    }
    if (req.method === "PUT") {
      if (meta) return new Response("Déjà là", { status: 200 });
      if (Number(req.headers.get("Content-Length") || 0) > MAX_SAMPLE) return new Response("Fichier trop gros", { status: 413 });
      const body = await req.arrayBuffer();
      if (body.byteLength > MAX_SAMPLE) return new Response("Fichier trop gros", { status: 413 });
      const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", body))]
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
      if (digest !== hash) return new Response("Empreinte incorrecte", { status: 400 });
      const chunks = Math.max(1, Math.ceil(body.byteLength / CHUNK));
      for (let i = 0; i < chunks; i++) await this.ctx.storage.put(`c:${hash}:${i}`, body.slice(i * CHUNK, (i + 1) * CHUNK));
      await this.ctx.storage.put("m:" + hash, { size: body.byteLength, chunks, at: Date.now() });
      return new Response("OK", { status: 201 });
    }
    return new Response("Méthode non permise", { status: 405 });
  }
}

export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.core = null;
    // Répond aux "ping" des clients sans réveiller l'objet.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  async ready() {
    if (this.core) return this.core;
    const state = {};
    for (const [k, v] of await this.ctx.storage.list({ prefix: "k:" })) state[k.slice(2)] = v;
    const seq = (await this.ctx.storage.get("seq")) ?? 0;
    this.core = new RoomCore(state, seq);
    return this.core;
  }

  async fetch(req) {
    const url = new URL(req.url);
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({
      name: (url.searchParams.get("name") || "?").slice(0, 40),
      id: (url.searchParams.get("id") || "").slice(0, 40),
      // La fenêtre de l'Extension se connecte en observatrice : elle voit passer
      // les changements mais ne compte pas parmi les participants.
      watch: url.searchParams.has("watch"),
    });
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    const core = await this.ready();
    const me = ws.deserializeAttachment();
    if (msg.t === "hello" && me.watch) {
      ws.send(JSON.stringify({ t: "summary", names: core.trackNames(), peers: this.peerNames() }));
    } else if (msg.t === "hello") {
      for (const m of core.welcome()) ws.send(JSON.stringify(m));
      this.broadcastPeers();
    } else if (msg.t === "ops" && Array.isArray(msg.ops) && !me.watch) {
      const out = core.apply(me.id, msg.ops);
      if (!out.length) return;
      await this.persist(out, core.seq);
      const data = JSON.stringify({ t: "ops", from: me.name, ops: out });
      for (const s of this.ctx.getWebSockets()) {
        try {
          s.send(data);
        } catch {}
      }
    }
  }

  async persist(ops, seq) {
    const puts = {};
    const dels = [];
    for (const op of ops) {
      if (op.v === null) {
        dels.push("k:" + op.k);
        delete puts["k:" + op.k];
      } else puts["k:" + op.k] = op.v;
    }
    const putKeys = Object.keys(puts);
    for (let i = 0; i < putKeys.length; i += 128) {
      await this.ctx.storage.put(Object.fromEntries(putKeys.slice(i, i + 128).map((k) => [k, puts[k]])));
    }
    for (let i = 0; i < dels.length; i += 128) await this.ctx.storage.delete(dels.slice(i, i + 128));
    await this.ctx.storage.put("seq", seq);
  }

  webSocketClose(ws, code) {
    try {
      ws.close(code === 1005 ? 1000 : code, "bye");
    } catch {}
    this.broadcastPeers(ws);
  }

  webSocketError(ws) {
    this.broadcastPeers(ws);
  }

  peerNames(exclude) {
    return this.ctx
      .getWebSockets()
      .filter((s) => s !== exclude)
      .map((s) => s.deserializeAttachment())
      .filter((a) => !a.watch)
      .map((a) => a.name);
  }

  broadcastPeers(exclude) {
    const socks = this.ctx.getWebSockets().filter((s) => s !== exclude);
    const data = JSON.stringify({ t: "peers", peers: this.peerNames(exclude) });
    for (const s of socks) {
      try {
        s.send(data);
      } catch {}
    }
  }
}
