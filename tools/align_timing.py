"""Conservatively retime intact subtitle cues from matching ASR word boundaries.

The ASR transcript is evidence for time, not a replacement for the subtitle text.
Long distinctive cues may tolerate a few internal ASR errors; short or uncertain
cues remain at their original time.
"""

import bisect
import math
import re


def _token(value):
    return re.sub(r'[^a-z0-9]', '', value.lower().replace('’', "'"))


def _track(segments, source):
    words = []
    for segment in segments:
        for word in segment.get('words', []):
            start, end = word.get('start'), word.get('end')
            token = _token(word.get('word', ''))
            if (token and isinstance(start, (int, float)) and isinstance(end, (int, float))
                    and math.isfinite(start) and math.isfinite(end) and start <= end):
                words.append((start, end, token, word.get('probability', 1)))
    words.sort(key=lambda item: (item[0], item[1]))
    positions = {}
    for index, (_, _, token, _) in enumerate(words):
        positions.setdefault(token, []).append(index)
    return dict(words=words, starts=[word[0] for word in words], positions=positions, source=source)


def _tracks(evidence):
    result = [_track(evidence.get('segments', []), 'base')]
    for index, clip in enumerate(evidence.get('recheckClips', [])):
        result.append(_track(clip.get('segments', []), f'recheck:{index}'))
    return result


def _lcs_length(left, right):
    """Count ordered exact words without guessing times for missing words."""
    row = [0] * (len(right) + 1)
    for token in left:
        prior, next_row = row, [0]
        for index, other in enumerate(right, 1):
            next_row.append(prior[index - 1] + 1 if token == other else
                            max(prior[index], next_row[-1]))
        row = next_row
    return row[-1]


def _fuzzy_candidates(cue, tokens, tracks, window):
    # Exact first/last words and an additional early word anchor make this
    # fallback selective even when a cue is played twice in one lesson.
    if len(tokens) < 8 or len(set(tokens)) < 6:
        return []
    maximum_errors = len(tokens) - math.ceil(len(tokens) * .85)
    found = []
    for track in tracks:
        words = track['words']
        starts = track['positions'].get(tokens[0], [])
        lower = bisect.bisect_left(track['starts'], cue['start'] - window)
        upper = bisect.bisect_right(track['starts'], cue['start'] + window)
        for position in starts[bisect.bisect_left(starts, lower):bisect.bisect_left(starts, upper)]:
            if words[position][0] >= words[position][1] or words[position][3] < .55:
                continue
            minimum = max(position + 3, position + len(tokens) - maximum_errors - 1)
            maximum = min(len(words) + 1, position + len(tokens) + maximum_errors + 1)
            for end_position in range(minimum, maximum):
                if words[end_position - 2][2] != tokens[-2] or words[end_position - 1][2] != tokens[-1]:
                    continue
                span = words[position:end_position]
                start, end = span[0][0], span[-1][1]
                if (start >= end or span[-1][0] >= end or span[-1][3] < .55
                        or end - start > max(2, len(tokens) * 1.1 + 2)
                        or any(span[at + 1][0] - span[at][1] > 2.5
                               for at in range(len(span) - 1))):
                    continue
                heard = [word[2] for word in span]
                if not any(token in heard[1:5] for token in tokens[1:4]):
                    continue
                matched = 3 + _lcs_length(tokens[1:-2], heard[1:-2])
                if matched < math.ceil(.85 * len(tokens)) or matched < math.ceil(.85 * len(heard)):
                    continue
                errors = len(tokens) + len(heard) - 2 * matched
                cost = (abs(start - cue['start']) + .35 * abs(end - cue['end'])
                        + errors + (2 - span[0][3] - span[-1][3]) * .4)
                found.append(dict(start=start, end=end, cost=cost,
                                  source=track['source'] + ':fuzzy', errors=errors, fuzzy=True))
    return found


def _candidates(cue, tracks, search_window=None):
    tokens = [_token(part) for part in cue['en'].split()]
    tokens = [token for token in tokens if token]
    if not tokens:
        return []
    # Long, distinctive text can safely search farther than a common short reply.
    window = search_window if search_window is not None else min(20, max(8, len(tokens) * 1.5))
    max_extras = max(1, len(tokens) // 6) if len(tokens) >= 5 else 0
    found = []
    for track in tracks:
        words = track['words']
        if not words:
            continue
        lower = bisect.bisect_left(track['starts'], cue['start'] - window)
        upper = bisect.bisect_right(track['starts'], cue['start'] + window)
        starts = track['positions'].get(tokens[0], [])
        for position in starts[bisect.bisect_left(starts, lower):bisect.bisect_left(starts, upper)]:
            cursor, extras, matched = position, 0, []
            for token in tokens:
                stop = min(len(words), cursor + max_extras - extras + 1)
                match = next((at for at in range(cursor, stop) if words[at][2] == token), None)
                if match is None:
                    break
                extras += match - cursor
                matched.append(match)
                cursor = match + 1
            if len(matched) != len(tokens):
                continue
            first, last = words[matched[0]], words[matched[-1]]
            minimum_probability = (.55 if len(tokens) > 3 or
                                   abs(first[0] - cue['start']) <= .5 else .75)
            if (first[0] >= first[1] or last[0] >= last[1]
                    or first[3] < minimum_probability
                    or last[3] < minimum_probability):
                continue
            start, end = first[0], last[1]
            if end <= start or end - start > max(2, len(tokens) * 1.1 + 2):
                continue
            cost = (abs(start - cue['start']) + .35 * abs(end - cue['end'])
                    + extras * .3 + (2 - first[3] - last[3]) * .4)
            found.append(dict(start=start, end=end, cost=cost, source=track['source'], extras=extras))
    if not found:
        found = _fuzzy_candidates(cue, tokens, tracks, window)
    # Base and recheck hypotheses may describe the same utterance. Keep the
    # closest instance so it cannot make a clearly unique phrase look ambiguous.
    found.sort(key=lambda item: item['cost'])
    distinct = []
    for candidate in found:
        if not any(abs(candidate['start'] - other['start']) < .35 and
                   abs(candidate['end'] - other['end']) < .35 for other in distinct):
            distinct.append(candidate)
    return distinct


def retime_cues(cues, evidence):
    """Return equal-count cues with safe audio times and an auditable report.

    Original text, order and all extra cue fields are retained. Uncertain matches
    remain at their source times. No time is invented by dividing an interval.
    """
    tracks = _tracks(evidence)
    changes, unresolved = [], []
    duration = evidence.get('duration', float('inf'))
    proposals, reasons = [], []
    for index, cue in enumerate(cues):
        if cue.get('lockedTiming'):
            proposals.append(None)
            reasons.append(None)
            continue
        tokens = [_token(part) for part in cue['en'].split() if _token(part)]
        candidates = _candidates(cue, tracks)
        reason = None
        if not candidates:
            reason = 'no_complete_word_match'
        elif len(candidates) > 1 and (candidates[0].get('fuzzy') or
                                       candidates[1]['cost'] - candidates[0]['cost'] < .35):
            reason = 'ambiguous_repetition'
        proposal = candidates[0] if not reason else None
        # A large jump is allowed only for a distinctive, unique phrase and a
        # neighboring cue with a corroborating shift. This catches drifted
        # blocks without jumping to a repeated teaching/dialog performance.
        if not proposal and reason == 'no_complete_word_match' and len(tokens) >= 6 and len(set(tokens)) >= 4:
            # Some legacy SRTs were timed against a different audio cut and
            # can be displaced by more than a minute. Search the whole track,
            # then require a second ordered anchor before moving anything.
            global_candidates = _candidates(cue, tracks, search_window=float('inf'))
            if len(global_candidates) == 1:
                proposal = dict(global_candidates[0], global_anchor=True)
                reason = None
        proposals.append(proposal)
        reasons.append(reason)

    for index, proposal in enumerate(proposals):
        if not proposal or not proposal.get('global_anchor'):
            continue
        shift = proposal['start'] - cues[index]['start']
        supported = any(other is not None and abs(other['start'] - cues[neighbor]['start'] - shift) <= 4
                        and ((neighbor < index and other['end'] <= proposal['start']) or
                             (neighbor > index and proposal['end'] <= other['start']))
                        for neighbor in range(max(0, index - 2), min(len(cues), index + 3))
                        if neighbor != index for other in [proposals[neighbor]])
        # A long cue whose original *end* is already audio-aligned may have
        # accumulated silence at its beginning. The following cue can confirm
        # that boundary even when the two start-time shifts differ greatly.
        if not supported and index + 1 < len(cues):
            following = proposals[index + 1]
            supported = (following is not None and
                         abs(proposal['end'] - cues[index]['end']) <= 3 and
                         abs(following['start'] - cues[index + 1]['start']) <= 3 and
                         proposal['end'] <= following['start'])
        if not supported:
            proposals[index] = None
            reasons[index] = 'global_anchor_without_context'

    # Resolve all proposed ranges together so adjacent cues can move as a
    # block. A proposal that would intrude into an unchanged cue is discarded.
    # Validation belongs in the same loop: if a clipped proposal proves too
    # short, its neighbor must be checked again against the original cue.
    active = list(proposals)
    adjusted = {}
    for _ in range(len(cues) + 1):
        rejected = None
        for index in range(len(cues) - 1):
            left = active[index] or cues[index]
            right = active[index + 1] or cues[index + 1]
            if left['end'] <= right['start'] + .08:
                continue
            if active[index] and active[index + 1]:
                rejected = index if active[index]['cost'] >= active[index + 1]['cost'] else index + 1
            elif active[index]:
                rejected = index
            elif active[index + 1]:
                rejected = index + 1
            else:
                continue  # Existing source overlap is reported, never enlarged.
            break
        if rejected is not None:
            active[rejected] = None
            reasons[rejected] = 'overlaps_neighbor'
            continue
        adjusted = {}
        for index, candidate in enumerate(active):
            if not candidate:
                continue
            start, end = candidate['start'], candidate['end']
            if index and start < (active[index - 1] or cues[index - 1])['end']:
                start = (active[index - 1] or cues[index - 1])['end']
            if index + 1 < len(cues) and end > (active[index + 1] or cues[index + 1])['start']:
                end = (active[index + 1] or cues[index + 1])['start']
            if start < 0 or end > duration + .02 or end - start < .12:
                rejected = index
                reasons[index] = 'invalid_audio_range'
                break
            adjusted[index] = (start, end)
        if rejected is not None:
            active[rejected] = None
            continue
        break

    result = [dict(cue) for cue in cues]
    for index, (start, end) in adjusted.items():
        candidate = active[index]
        # Even a sub-80ms adjustment must be committed when a neighboring
        # proposal used it as its boundary; otherwise the output can overlap.
        if abs(start - cues[index]['start']) >= .0005 or abs(end - cues[index]['end']) >= .0005:
            result[index]['start'], result[index]['end'] = round(start, 3), round(end, 3)
            changes.append(dict(cue=index, oldStart=cues[index]['start'], oldEnd=cues[index]['end'],
                                start=result[index]['start'], end=result[index]['end'],
                                source=candidate['source'], globalAnchor=bool(candidate.get('global_anchor'))))
    for index, reason in enumerate(reasons):
        if reason:
            unresolved.append(dict(cue=index, reason=reason, start=cues[index]['start'], end=cues[index]['end']))
    return result, dict(total=len(cues), changed=len(changes), kept=len(cues) - len(changes),
                        changes=changes, unresolved=unresolved)
