'use strict';

function visibleSegments(lesson, scope) {
  if (scope !== 'dialog') return lesson.segments;
  const ids = new Set(lesson.dialog.segmentIds);
  return lesson.segments.filter(segment => ids.has(segment.id));
}

function findSegment(segments, time) {
  let lo = 0;
  let hi = segments.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (time < segments[mid].start) hi = mid - 1;
    else if (time >= segments[mid].end) lo = mid + 1;
    else return mid;
  }
  return -1;
}

// Highlight retention is visual only; playback always uses the original cue times.
function findHighlightSegment(segments, time, retainDuringGap) {
  if (!Number.isFinite(time)) return -1;
  const active = findSegment(segments, time);
  if (active !== -1 || !retainDuringGap) return active;
  let lo = 0;
  let hi = segments.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (segments[mid].start <= time) lo = mid + 1;
    else hi = mid;
  }
  // Only retain between cues, never in the leading or trailing silence.
  return lo > 0 && lo < segments.length ? lo - 1 : -1;
}

function playbackRange(lesson, scope, sentenceId, sentenceLoop) {
  if (sentenceLoop && sentenceId != null) {
    const sentence = visibleSegments(lesson, scope).find(segment => segment.id === sentenceId);
    if (sentence) return { start: sentence.start, end: sentence.end, kind: 'sentence' };
  }
  if (scope === 'dialog') return { start: lesson.dialog.start, end: lesson.dialog.end, kind: 'dialog' };
  return { start: 0, end: lesson.duration, kind: 'full' };
}

// Media decoders may round a requested timestamp down by one microsecond.
// Ten microseconds avoids seek loops without relaxing audible boundaries.
function sameTime(first, second) {
  return Math.abs(first - second) <= 0.00001;
}

function clampTime(time, range) {
  if (range.kind === 'full' || !Number.isFinite(time)) return time;
  return (time < range.start && !sameTime(time, range.start)) || time >= range.end ? range.start : time;
}

function endAction(kind, playMode) {
  if (kind === 'sentence' || playMode === 'loop') return 'restart';
  return 'next';
}

const PlayerCore = { visibleSegments, findSegment, findHighlightSegment, playbackRange, sameTime, clampTime, endAction };
if (typeof module !== 'undefined') module.exports = PlayerCore;
if (typeof window !== 'undefined') window.PlayerCore = PlayerCore;
