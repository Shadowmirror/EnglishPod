const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../player-core.js');

const lesson = {
  version: 1, id: 1, number: '0001', title: 'A lesson', audio: 'mp3/a.mp3', duration: 30,
  segments: [
    { id: 1, start: 1, end: 3, en: 'Intro', zh: '开场' },
    { id: 2, start: 7, end: 9, en: 'Hello', zh: '你好' },
    { id: 3, start: 10, end: 12, en: 'Bye', zh: '再见' },
    { id: 4, start: 20, end: 22, en: 'Outro', zh: '结尾' }
  ],
  dialog: { start: 7, end: 12, segmentIds: [2, 3] }
};

test('dialog uses explicit sentence IDs and excludes intro and outro', () => {
  assert.deepEqual(core.visibleSegments(lesson, 'dialog').map(s => s.id), [2, 3]);
  assert.deepEqual(core.visibleSegments(lesson, 'full').map(s => s.id), [1, 2, 3, 4]);
});

test('sentence lookup leaves timing gaps empty and treats end as exclusive', () => {
  assert.equal(core.findSegment(lesson.segments, 3), -1);
  assert.equal(core.findSegment(lesson.segments, 8), 1);
  assert.equal(core.findSegment(lesson.segments, 9), -1);
});

test('selected sentence loop takes priority over dialog and lesson loop', () => {
  assert.deepEqual(core.playbackRange(lesson, 'dialog', 2, true), { start: 7, end: 9, kind: 'sentence' });
  assert.equal(core.endAction('sentence', 'sequential'), 'restart');
  assert.equal(core.endAction('sentence', 'loop'), 'restart');
});

test('dialog end follows existing lesson play mode', () => {
  assert.deepEqual(core.playbackRange(lesson, 'dialog', 2, false), { start: 7, end: 12, kind: 'dialog' });
  assert.equal(core.endAction('dialog', 'loop'), 'restart');
  assert.equal(core.endAction('dialog', 'sequential'), 'next');
});

test('out-of-range native seek stays inside selected dialog or sentence', () => {
  const range = core.playbackRange(lesson, 'dialog', null, false);
  assert.equal(core.clampTime(0, range), 7);
  assert.equal(core.clampTime(12.5, range), 7);
  assert.equal(core.clampTime(10.5, range), 10.5);
  assert.equal(core.clampTime(40, core.playbackRange(lesson, 'full', null, false)), 40);
});

test('invalid sentence target cannot escape dialog', () => {
  assert.deepEqual(core.playbackRange(lesson, 'dialog', 4, true), { start: 7, end: 12, kind: 'dialog' });
});

test('dialog tolerates microsecond seek rounding but keeps millisecond escapes clamped', () => {
  const range = { start: 64.52, end: 80, kind: 'dialog' };
  assert.equal(core.clampTime(64.519999, range), 64.519999);
  assert.equal(core.clampTime(64.519, range), 64.52);
  assert.equal(core.clampTime(80, range), 64.52);
  assert.equal(core.clampTime(80.000001, range), 64.52);
});


test('gap highlighting retains only the preceding visible sentence between two sentences', () => {
  const segments = lesson.segments;
  assert.equal(core.findHighlightSegment(segments, 5, false), -1);
  assert.equal(core.findHighlightSegment(segments, 5, true), 0);
  assert.equal(core.findHighlightSegment(segments, 3, true), 0);
  assert.equal(core.findHighlightSegment(segments, 7, true), 1);
  assert.equal(core.findHighlightSegment(segments, 19, true), 2);
  assert.equal(core.findHighlightSegment(segments, 0, true), -1);
  assert.equal(core.findHighlightSegment(segments, 22, true), -1);
  assert.equal(core.findHighlightSegment([], 5, true), -1);
  assert.equal(core.findHighlightSegment(segments, NaN, true), -1);
  const dialog = core.visibleSegments(lesson, 'dialog');
  assert.equal(core.findHighlightSegment(dialog, 5, true), -1);
  assert.equal(core.findHighlightSegment(dialog, 9.5, true), 0);
  assert.equal(core.findHighlightSegment(dialog, 15, true), -1);
  assert.equal(core.findSegment(segments, 5), -1);
});
