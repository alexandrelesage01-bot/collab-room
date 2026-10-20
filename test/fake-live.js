"use strict";
// Un faux Live en mémoire qui imite l'hôte des Extensions (mêmes noms de fonctions,
// mêmes conventions de rappels). Les temps et valeurs passent par Math.fround pour
// imiter les imprécisions de Live.

const fs = require("node:fs");

const NATIVE = {
  "EQ Eight": ["Device On", "1 Frequency A", "1 Gain A"],
  Utility: ["Device On", "Gain"],
  Reverb: ["Device On", "Decay Time", "Dry/Wet"],
  Drift: ["Device On", "Osc 1 Shape", "Filter Freq"],
};
const f = Math.fround;

class FakeLive {
  constructor({ scenes = 8 } = {}) {
    this.next = 1;
    this.objs = new Map();
    this.root = this.make(["Application"], {});
    this.songH = this.make(["Song"], { tempo: 120, tracks: [], scenes: [] });
    for (let i = 0; i < scenes; i++) this.S.scenes.push(this.make(["Scene"], {}));
    this.dataModel = this.buildDataModel();
  }

  get S() {
    return this.o(this.songH);
  }
  make(classes, props) {
    const id = this.next++;
    this.objs.set(id, { classes, ...props });
    return { id };
  }
  o(h) {
    const x = this.objs.get(h.id);
    if (!x) throw new Error(`objet ${h.id} inconnu (supprimé ?)`);
    return x;
  }
  ref(h) {
    return { id: h.id };
  }
  param(name, value, min = 0, max = 1) {
    return this.make(["DeviceParameter"], { name, value: f(value), min, max });
  }

  // ---- aides pour écrire les tests
  addTrack(kind, name) {
    const isMidi = kind === "midi";
    const h = this.make([isMidi ? "MidiTrack" : "AudioTrack", "Track"], {
      name: name || `${this.S.tracks.length + 1}-${isMidi ? "MIDI" : "Audio"}`,
      mute: false,
      solo: false,
      arm: false,
      mixer: this.make(["MixerDevice"], { vol: this.param("Track Volume", 0.85), pan: this.param("Track Panning", 0, -1, 1) }),
      slots: this.S.scenes.map(() => this.make(["ClipSlot"], { clip: null })),
      arr: [],
      devices: [],
    });
    this.S.tracks.push(h);
    return h;
  }
  addDevice(trackH, name, params = NATIVE[name] || ["Device On", "Macro 1"]) {
    const d = this.make(["Device"], { name, params: params.map((p, i) => this.param(p, i === 0 ? 1 : 0.5)) });
    this.o(trackH).devices.push(d);
    return d;
  }
  newMidiClip(start, end, len, looping) {
    return this.make(["MidiClip", "Clip"], {
      name: "",
      color: 7,
      muted: false,
      looping,
      loopStart: 0,
      loopEnd: f(len),
      startMarker: 0,
      endMarker: f(len),
      start: f(start),
      end: f(end),
      notes: [],
    });
  }
  newAudioClip(start, end, filePath, warped) {
    if (!fs.existsSync(filePath)) throw new Error("fichier introuvable : " + filePath);
    return this.make(["AudioClip", "Clip"], {
      name: require("node:path").basename(filePath),
      color: 3,
      muted: false,
      looping: false,
      loopStart: 0,
      loopEnd: f(end - start),
      startMarker: 0,
      endMarker: f(end - start),
      start: f(start),
      end: f(end),
      filePath,
      warping: !!warped,
      warpMode: 0,
    });
  }
  setNotes(clipH, notes) {
    this.o(clipH).notes = notes.map((n) => ({
      pitch: n.pitch,
      startTime: f(n.startTime),
      duration: f(n.duration),
      velocity: n.velocity ?? 100,
      muted: !!n.muted,
      probability: n.probability ?? 1,
      velocityDeviation: n.velocityDeviation ?? 0,
      releaseVelocity: n.releaseVelocity ?? 64,
    }));
  }
  // Ce que fait Live quand on déplace une piste (ou rouvre le Set) : nouveaux handles
  // pour la piste et ses clips, même contenu.
  rehandle(h, toIndex) {
    const swap = (old) => {
      const nh = { id: this.next++ };
      this.objs.set(nh.id, this.objs.get(old.id));
      this.objs.delete(old.id);
      return nh;
    };
    const i = this.S.tracks.findIndex((t) => t.id === h.id);
    const nh = swap(h);
    const o = this.o(nh);
    o.arr = o.arr.map(swap);
    this.S.tracks.splice(i, 1);
    this.S.tracks.splice(toIndex ?? i, 0, nh);
    return nh;
  }
  // Comme resources.renderPreFxAudio : rend la zone [start, end] d'une piste audio de
  // l'Arrangement dans un fichier temporaire (ici, une copie du fichier du clip).
  renderPreFx(trackH, start, end) {
    const clip = this.o(trackH).arr.map((c) => this.o(c)).find((c) => c.filePath && c.start < end && c.end > start);
    if (!clip) throw new Error("rien à rendre");
    const out = require("node:path").join(require("node:os").tmpdir(), `collab-render-${process.pid}-${this.next++}.wav`);
    fs.copyFileSync(clip.filePath, out);
    return out;
  }
  trackByName(name) {
    return this.S.tracks.find((t) => this.o(t).name === name);
  }

  buildDataModel() {
    const L = this;
    const o = (h) => L.o(h);
    const r = (h) => L.ref(h);
    const async = (fn) => (...args) => {
      const rej = args.pop();
      const res = args.pop();
      try {
        const out = fn(...args);
        setImmediate(() => res(out));
      } catch (e) {
        setImmediate(() => rej(e.message));
      }
    };
    const insertSlot = (idx) => {
      for (const t of L.S.tracks) o(t).slots.splice(idx, 0, L.make(["ClipSlot"], { clip: null }));
    };
    return {
      withinTransaction: (fn) => fn(),
      getRoot: () => r(L.root),
      rootGetSong: () => r(L.songH),
      getObjectIsOfClass: (h, cls) => o(h).classes.includes(cls),

      songGetTempo: () => L.S.tempo,
      songSetTempo: (_s, v) => (L.S.tempo = v),
      songGetScenes: () => L.S.scenes.map(r),
      songCreateScene: async((_s, idx) => {
        const i = Number(idx);
        const h = L.make(["Scene"], {});
        L.S.scenes.splice(i, 0, h);
        insertSlot(i);
        return r(h);
      }),
      songGetTracks: () => L.S.tracks.map(r),
      songCreateMidiTrack: async(() => r(L.addTrack("midi"))),
      songCreateAudioTrack: async(() => {
        const t = L.addTrack("audio");
        if (L.defaultAudioDevice) L.addDevice(t, L.defaultAudioDevice); // piste audio par défaut de l'utilisateur
        return r(t);
      }),
      songDeleteTrack: async((_s, t) => {
        const i = L.S.tracks.findIndex((x) => x.id === t.id);
        if (i < 0) throw new Error("piste inconnue");
        L.S.tracks.splice(i, 1);
        L.objs.delete(t.id);
      }),

      trackGetName: (h) => o(h).name,
      trackSetName: (h, v) => (o(h).name = v),
      trackGetMute: (h) => o(h).mute,
      trackSetMute: (h, v) => (o(h).mute = v),
      trackGetSolo: (h) => o(h).solo,
      trackSetSolo: (h, v) => (o(h).solo = v),
      trackGetMixerDevice: (h) => r(o(h).mixer),
      mixerdeviceGetVolume: (h) => r(o(h).vol),
      mixerdeviceGetPanning: (h) => r(o(h).pan),
      trackGetClipSlots: (h) => o(h).slots.map(r),
      trackGetArrangementClips: (h) => o(h).arr.map(r),
      trackGetDevices: (h) => o(h).devices.map(r),
      trackCreateMidiClip: async((h, start, dur) => {
        const c = L.newMidiClip(start, start + dur, dur, false);
        o(h).arr.push(c);
        return r(c);
      }),
      trackCreateAudioClip: async((h, opts) => {
        const c = L.newAudioClip(opts.startTime, opts.startTime + opts.duration, opts.filePath, opts.isWarped);
        o(h).arr.push(c);
        return r(c);
      }),
      trackDeleteClip: async((h, c) => {
        const t = o(h);
        t.arr = t.arr.filter((x) => x.id !== c.id);
      }),
      trackInsertDevice: async((h, name, idx) => {
        if (!NATIVE[name]) throw new Error(`Device not found: ${name}`);
        const d = L.make(["Device"], { name, params: NATIVE[name].map((p, i) => L.param(p, i === 0 ? 1 : 0.5)) });
        o(h).devices.splice(Number(idx), 0, d);
        return r(d);
      }),
      trackDeleteDevice: async((h, d) => {
        const t = o(h);
        t.devices = t.devices.filter((x) => x.id !== d.id);
      }),

      clipslotGetClip: (h) => (o(h).clip ? r(o(h).clip) : null),
      clipslotCreateMidiClip: async((h, len) => {
        if (o(h).clip) throw new Error("slot occupé");
        o(h).clip = L.newMidiClip(0, len, len, true);
        return r(o(h).clip);
      }),
      clipslotCreateAudioClip: async((h, opts) => {
        if (o(h).clip) throw new Error("slot occupé");
        o(h).clip = L.newAudioClip(0, 4, opts.filePath, opts.isWarped);
        return r(o(h).clip);
      }),
      clipslotDeleteClip: async((h) => {
        o(h).clip = null;
      }),

      clipGetName: (h) => o(h).name,
      clipSetName: (h, v) => (o(h).name = v),
      clipGetColor: (h) => o(h).color,
      clipSetColor: (h, v) => (o(h).color = v),
      clipGetMuted: (h) => o(h).muted,
      clipSetMuted: (h, v) => (o(h).muted = v),
      clipGetLooping: (h) => o(h).looping,
      clipSetLooping: (h, v) => (o(h).looping = v),
      clipGetLoopStart: (h) => o(h).loopStart,
      clipGetLoopEnd: (h) => o(h).loopEnd,
      clipGetStartMarker: (h) => o(h).startMarker,
      clipGetEndMarker: (h) => o(h).endMarker,
      clipGetStartTime: (h) => o(h).start,
      clipGetEndTime: (h) => o(h).end,
      midiclipGetNotes: (h) => o(h).notes.map((n) => ({ ...n, selected: false })),
      midiclipSetNotes: (h, notes) => L.setNotes(h, notes),
      audioclipGetFilePath: (h) => o(h).filePath,
      audioclipGetWarping: (h) => o(h).warping,
      audioclipSetWarping: (h, v) => (o(h).warping = v),
      audioclipGetWarpMode: (h) => o(h).warpMode,
      audioclipSetWarpMode: (h, v) => (o(h).warpMode = v),

      deviceGetName: (h) => o(h).name,
      deviceGetParameters: (h) => o(h).params.map(r),
      deviceParameterGetName: (h) => o(h).name,
      deviceParameterGetInternalValue: (h, cb) => setImmediate(() => cb(o(h).value)),
      deviceParameterSetInternalValue: (h, v, res, rej) => {
        const p = o(h);
        if (v < p.min || v > p.max) return setImmediate(() => rej("hors limites"));
        p.value = f(v);
        setImmediate(res);
      },
    };
  }
}

module.exports = { FakeLive, NATIVE };
