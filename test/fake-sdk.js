"use strict";
// Un faux SDK qui reproduit l'API publique de @ableton-extensions/sdk (d'après ses
// déclarations de types : Song, Track, ClipSlot, Clip, Device…) au-dessus du faux
// Live. Il permet de tester l'Extension sans le SDK ; test/sdk.test.mjs refait les
// mêmes scénarios avec le vrai SDK quand il est installé.

const call = (fn, ...args) =>
  new Promise((res, rej) => fn(...args, res, (e) => rej(e instanceof Error ? e : new Error(String(e)))));

function fakeSdk(L) {
  const dm = L.dataModel;
  const cache = new Map();
  const wrap = (h) => {
    if (!h) return null;
    let o = cache.get(h.id);
    if (o) return o;
    const classes = L.o(h).classes;
    const Cls = { MidiTrack, AudioTrack, MidiClip, AudioClip, ClipSlot, Device, DeviceParameter, MixerDevice: TrackMixer, Scene, Song }[classes[0]];
    if (!Cls) throw new Error("classe inconnue : " + classes[0]);
    o = new Cls(h);
    cache.set(h.id, o);
    return o;
  };

  class DataModelObject {
    constructor(h) {
      this.handle = { id: h.id };
    }
  }
  class DeviceParameter extends DataModelObject {
    get name() { return dm.deviceParameterGetName(this.handle); }
    getValue() { return new Promise((r) => dm.deviceParameterGetInternalValue(this.handle, r)); }
    setValue(v) { return call(dm.deviceParameterSetInternalValue, this.handle, v); }
  }
  class Device extends DataModelObject {
    get name() { return dm.deviceGetName(this.handle); }
    get parameters() { return dm.deviceGetParameters(this.handle).map(wrap); }
  }
  class TrackMixer extends DataModelObject {
    get volume() { return wrap(dm.mixerdeviceGetVolume(this.handle)); }
    get panning() { return wrap(dm.mixerdeviceGetPanning(this.handle)); }
  }
  class Clip extends DataModelObject {
    get name() { return dm.clipGetName(this.handle); }
    set name(v) { dm.clipSetName(this.handle, v); }
    get color() { return dm.clipGetColor(this.handle); }
    set color(v) { dm.clipSetColor(this.handle, v); }
    get muted() { return dm.clipGetMuted(this.handle); }
    set muted(v) { dm.clipSetMuted(this.handle, v); }
    get looping() { return dm.clipGetLooping(this.handle); }
    set looping(v) { dm.clipSetLooping(this.handle, v); }
    get loopStart() { return dm.clipGetLoopStart(this.handle); }
    get loopEnd() { return dm.clipGetLoopEnd(this.handle); }
    get startMarker() { return dm.clipGetStartMarker(this.handle); }
    get endMarker() { return dm.clipGetEndMarker(this.handle); }
    get startTime() { return dm.clipGetStartTime(this.handle); }
    get endTime() { return dm.clipGetEndTime(this.handle); }
  }
  class MidiClip extends Clip {
    get notes() { return dm.midiclipGetNotes(this.handle); }
    set notes(v) { dm.midiclipSetNotes(this.handle, v); }
  }
  class AudioClip extends Clip {
    get filePath() { return dm.audioclipGetFilePath(this.handle); }
    get warping() { return dm.audioclipGetWarping(this.handle); }
    set warping(v) { dm.audioclipSetWarping(this.handle, v); }
    get warpMode() { return dm.audioclipGetWarpMode(this.handle); }
    set warpMode(v) { dm.audioclipSetWarpMode(this.handle, v); }
  }
  class ClipSlot extends DataModelObject {
    get clip() { return wrap(dm.clipslotGetClip(this.handle)); }
    deleteClip() { return call(dm.clipslotDeleteClip, this.handle); }
    async createMidiClip(len) { return wrap(await call(dm.clipslotCreateMidiClip, this.handle, len)); }
    async createAudioClip(args) { return wrap(await call(dm.clipslotCreateAudioClip, this.handle, args)); }
  }
  class Track extends DataModelObject {
    get name() { return dm.trackGetName(this.handle); }
    set name(v) { dm.trackSetName(this.handle, v); }
    get mute() { return dm.trackGetMute(this.handle); }
    set mute(v) { dm.trackSetMute(this.handle, v); }
    get solo() { return dm.trackGetSolo(this.handle); }
    set solo(v) { dm.trackSetSolo(this.handle, v); }
    get mixer() { return wrap(dm.trackGetMixerDevice(this.handle)); }
    get clipSlots() { return dm.trackGetClipSlots(this.handle).map(wrap); }
    get arrangementClips() { return dm.trackGetArrangementClips(this.handle).map(wrap); }
    get devices() { return dm.trackGetDevices(this.handle).map(wrap); }
    async insertDevice(name, index) { return wrap(await call(dm.trackInsertDevice, this.handle, name, index)); }
    deleteDevice(d) { return call(dm.trackDeleteDevice, this.handle, d.handle); }
    deleteClip(c) { return call(dm.trackDeleteClip, this.handle, c.handle); }
  }
  class MidiTrack extends Track {
    async createMidiClip(start, dur) { return wrap(await call(dm.trackCreateMidiClip, this.handle, start, dur)); }
  }
  class AudioTrack extends Track {
    async createAudioClip(args) { return wrap(await call(dm.trackCreateAudioClip, this.handle, args)); }
  }
  class Scene extends DataModelObject {}
  class Song extends DataModelObject {
    get tempo() { return dm.songGetTempo(this.handle); }
    set tempo(v) { dm.songSetTempo(this.handle, v); }
    get tracks() { return dm.songGetTracks(this.handle).map(wrap); }
    get scenes() { return dm.songGetScenes(this.handle).map(wrap); }
    async createMidiTrack() { return wrap(await call(dm.songCreateMidiTrack, this.handle)); }
    async createAudioTrack() { return wrap(await call(dm.songCreateAudioTrack, this.handle)); }
    async createScene(i) { return wrap(await call(dm.songCreateScene, this.handle, i)); }
    deleteTrack(t) { return call(dm.songDeleteTrack, this.handle, t.handle); }
  }

  const song = wrap(dm.rootGetSong(dm.getRoot()));
  return {
    classes: { MidiTrack, AudioTrack, MidiClip, AudioClip },
    // Contexte comme celui que renvoie initialize() ; ui/commands/environment au choix des tests.
    context(extra = {}) {
      const resources = {
        renderPreFxAudio: async (track, start, end) => L.renderPreFx(track.handle, start, end),
        importIntoProject: async (file) => file,
      };
      return { application: { song }, withinTransaction: (fn) => fn(), resources, ...extra };
    },
  };
}

// Les modules de l'hôte que Live passe à l'Extension, pour lancer le VRAI SDK sur le faux Live.
function fakeActivation(L, extra = {}) {
  return {
    initializeExtensionHost: () => ({
      dataModel: L.dataModel,
      commands: { registerCommand() {}, executeCommand() {} },
      environment: { storageDirectory: extra.storageDirectory, tempDirectory: undefined, language: "fr" },
      resources: {
        renderPreFxAudio(lane, { startTime, endTime }, onResult, onError) {
          try {
            onResult(L.renderPreFx(lane, startTime, endTime));
          } catch {
            onError();
          }
        },
        importIntoProject(file, onResult) {
          onResult(file);
        },
      },
      ui: {
        registerContextMenuAction(_s, _t, _c, done) {
          if (done) done(() => {});
        },
        showModalDialog(_u, _w, _h, _res, err) {
          err();
        },
        showProgressDialog(_o, onShow) {
          onShow({ update: (_x, cb) => cb && cb(), close: (cb) => cb && cb() });
        },
      },
    }),
  };
}

module.exports = { fakeSdk, fakeActivation };
