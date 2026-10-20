// Logique d'une salle, sans dépendance à Cloudflare (testable dans Node).
//
// L'état partagé est une table plate clé → valeur JSON, par ex.
//   "song/tempo" → 124
//   "t/a1b2c3d4/name" → "Basse"
//   "t/a1b2c3d4/s/0" → { kind: "midi", notes: [...], ... }
// Chaque opération reçue reçoit un numéro de séquence ; le serveur la renvoie
// à tout le monde, émetteur compris (ça lui sert d'accusé de réception).
// La dernière écriture arrivée au serveur gagne, clé par clé.

export const MAX_KEY = 300;

export class RoomCore {
  constructor(state = {}, seq = 0) {
    this.state = state;
    this.seq = seq;
  }

  // L'état complet, découpé en morceaux pour rester sous la taille max d'un message WebSocket.
  welcome(maxBytes = 256_000) {
    const out = [];
    let part = {};
    let size = 0;
    for (const [k, v] of Object.entries(this.state)) {
      const n = k.length + JSON.stringify(v).length;
      if (size > 0 && size + n > maxBytes) {
        out.push(part);
        part = {};
        size = 0;
      }
      part[k] = v;
      size += n;
    }
    out.push(part);
    return out.map((state, i) => ({ t: "welcome", seq: this.seq, state, more: i < out.length - 1 }));
  }

  // Nom de chaque piste, pour la fenêtre (qui n'a pas besoin de tout l'état).
  trackNames() {
    const names = {};
    for (const [k, v] of Object.entries(this.state)) {
      const m = k.match(/^t\/([^/]+)\/name$/);
      if (m) names[m[1]] = v;
    }
    return names;
  }

  // ops : [{ k, v, id }] ; v === null supprime la clé.
  apply(by, ops) {
    const out = [];
    for (const op of ops) {
      if (!op || typeof op.k !== "string" || op.k.length === 0 || op.k.length > MAX_KEY) continue;
      const v = op.v === undefined ? null : op.v;
      this.seq++;
      if (v === null) delete this.state[op.k];
      else this.state[op.k] = v;
      out.push({ k: op.k, v, id: op.id, by, seq: this.seq });
    }
    return out;
  }
}
