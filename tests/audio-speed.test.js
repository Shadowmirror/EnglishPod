const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function loadController({ supported = true, secure = true, failWorklet = false, failNode = false } = {}) {
  let sourceCreations = 0;
  let connected = [];
  let disconnected = [];
  let moduleLoads = 0;
  let pitchChanges = [];
  let stretchStarts = 0;
  let resumes = 0;
  const audio = { playbackRate: 1, preservesPitch: true, mozPreservesPitch: true, webkitPreservesPitch: true };
  const context = {
    state: 'suspended', currentTime: 10, destination: { id: 'destination' }, audioWorklet: { addModule: async () => { moduleLoads++; if (failWorklet) throw new Error('blocked'); } },
    createMediaElementSource: () => { sourceCreations++; return { connect: n => connected.push(n), disconnect: n => disconnected.push(n) }; },
    resume: async () => { resumes++; context.state = 'running'; }, close: async () => { context.state = 'closed'; }
  };
  class StretchNode {
    connect(n) { connected.push(n); }
    disconnect(n) { disconnected.push(n); }
    async start() { stretchStarts++; }
    async schedule(change) { pitchChanges.push(change); }
    async latency() { return 0.12; }
  }
  const window = {
    isSecureContext: secure,
    AudioContext: supported ? class { constructor() { return context; } } : undefined,
    AudioWorkletNode: class {},
    SignalsmithStretch: async ctx => {
      if (failNode) throw new Error('node setup failed');
      await ctx.audioWorklet.addModule('processor');
      return new StretchNode();
    }
  };
  const sandbox = { window, document: {}, Blob, fetch: async () => ({ ok: true, text: async () => '' }), console };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'audio-speed.js'), 'utf8'), sandbox);
  return { create: window.AudioSpeed.create, audio, state: () => ({ sourceCreations, connected, disconnected, moduleLoads, resumes, pitchChanges, stretchStarts, mode: window.AudioSpeed }) };
}

test('unsupported AudioWorklet falls back to audible native playback', async () => {
  const harness = loadController({ supported: false });
  const notices = [];
  const controller = await harness.create(harness.audio, { onFallback: reason => notices.push(reason) });
  assert.equal(controller.getMode(), 'native');
  controller.setRate(1.25);
  assert.equal(harness.audio.playbackRate, 1.25);
  assert.equal(notices.length, 1);
});

test('insecure contexts do not construct an AudioContext or replace native output', async () => {
  const harness = loadController({ secure: false });
  const controller = await harness.create(harness.audio);
  assert.equal(controller.getMode(), 'native');
  assert.equal(harness.state().sourceCreations, 0);
});

test('uses Signalsmith pitch correction while the media element remains the playback clock', async () => {
  const harness = loadController();
  const controller = await harness.create(harness.audio);
  await controller.resume();
  controller.setRate(1.5);
  assert.equal(controller.getMode(), 'signalsmith');
  assert.equal(harness.audio.playbackRate, 1.5);
  assert.equal(harness.audio.preservesPitch, false);
  const stats = harness.state();
  assert.equal(stats.sourceCreations, 1);
  assert.equal(stats.moduleLoads, 1);
  assert.equal(stats.resumes, 1);
  assert.equal(stats.stretchStarts, 1);
  assert.ok(Math.abs(stats.pitchChanges.at(-1).semitones + 12 * Math.log2(1.5)) < 1e-8);
  assert.equal(stats.pitchChanges.at(-1).formantCompensation, true);
  assert.ok(stats.disconnected.some(node => node.id === 'destination'));
});

test('slow playback uses native pitch-preserving time stretch without upward pitch shifting', async () => {
  const harness = loadController();
  const controller = await harness.create(harness.audio);
  controller.setRate(0.75);
  assert.equal(controller.getMode(), 'native');
  assert.equal(harness.audio.playbackRate, 0.75);
  assert.equal(harness.audio.preservesPitch, true);
  const stats = harness.state();
  assert.ok(stats.connected.some(node => node.id === 'destination'));
  assert.equal(stats.pitchChanges.filter(change => change.semitones !== 0).length, 0);
});

test('processor initialization failure connects the existing source directly for native fallback', async () => {
  const harness = loadController({ failNode: true });
  const controller = await harness.create(harness.audio);
  controller.setRate(0.75);
  assert.equal(controller.getMode(), 'native');
  assert.equal(harness.audio.playbackRate, 0.75);
  const stats = harness.state();
  assert.equal(stats.sourceCreations, 1);
  assert.ok(stats.connected.some(node => node.id === 'destination'));
});

test('processor module load failure leaves the media element on its native audible output', async () => {
  const harness = loadController({ failWorklet: true });
  const controller = await harness.create(harness.audio);
  assert.equal(controller.getMode(), 'native');
  assert.equal(harness.state().sourceCreations, 1);
  assert.ok(harness.state().connected.some(node => node.id === 'destination'));
});
