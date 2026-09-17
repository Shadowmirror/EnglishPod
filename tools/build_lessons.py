"""Build synchronized lesson/SRT/TXT data from a frozen transcript and audio evidence.

All decisions remain inspectable in audit.json. ASR disagreements are flagged, never
silently substituted. A reviewed correction file can replace source cues.
This tool uses only the Python standard library and never modifies source audio.
"""
import argparse
import difflib
import json
import math
import re
import zipfile
from pathlib import Path

ABBREVIATIONS = {'mr.', 'mrs.', 'ms.', 'dr.', 'prof.', 'st.', 'jr.', 'sr.', 'e.g.', 'i.e.', 'vs.', 'etc.'}


def normalize(word):
    return re.sub(r'[^a-z0-9]', '', word.lower().replace('’', "'"))


def seconds(value):
    h, m, s = value.replace(',', '.').split(':')
    return int(h) * 3600 + int(m) * 60 + float(s)


def parse_srt(text):
    result = []
    for block in re.split(r'\n\s*\n', text.replace('\r', '').lstrip('\ufeff').strip()):
        rows = block.splitlines()
        if len(rows) < 3 or ' --> ' not in rows[1]:
            raise ValueError('Invalid SRT block: ' + block[:100])
        start, end = rows[1].split(' --> ')
        result.append(dict(start=seconds(start), end=seconds(end), en=' '.join(rows[2:]).strip()))
    return result


def timestamp(value):
    total = round(value * 1000)
    return f'{total // 3600000:02}:{total // 60000 % 60:02}:{total // 1000 % 60:02},{total % 1000:03}'


def dump_srt(segments):
    return '\r\n\r\n'.join(f'{i}\r\n{timestamp(s["start"])} --> {timestamp(s["end"])}\r\n{s["en"]}'
                            for i, s in enumerate(segments, 1)) + '\r\n'


def sentence_parts(text):
    tokens = text.split()
    result, part = [], []
    for token in tokens:
        part.append(token)
        clean = token.rstrip('\"”’\')]').lower()
        if re.search(r'[.!?]$', clean) and clean not in ABBREVIATIONS and not re.fullmatch(r'(?:[a-z]\.)+', clean):
            result.append(' '.join(part))
            part = []
    if part:
        # Keep an unpunctuated continuation together rather than manufacture a sentence.
        if result:
            result[-1] += ' ' + ' '.join(part)
        else:
            result.append(' '.join(part))
    return result


def token_mapping(text, words):
    source = text.split()
    matcher = difflib.SequenceMatcher(None, [normalize(w) for w in source],
                                     [normalize(w['word']) for w in words], autojunk=False)
    mapping = {a + n: b + n for a, b, size in matcher.get_matching_blocks() for n in range(size)}
    return source, mapping


def align_cue(cue, words):
    words = [w for w in words if normalize(w['word']) and w['end'] > w['start']
             and w['start'] >= cue['start'] - 1.0 and w['end'] <= cue['end'] + 1.0]
    source, mapping = token_mapping(cue['en'], words)
    coverage = len(mapping) / max(1, len(source))
    parts = sentence_parts(cue['en'])
    if not mapping:
        return [dict(cue)], coverage
    if len(parts) < 2:
        result = dict(cue)
        if coverage >= .8 and 0 in mapping and len(source) - 1 in mapping:
            start = max(cue['start'], words[mapping[0]]['start'])
            end = min(cue['end'], words[mapping[len(source) - 1]]['end'])
            if end - start >= .12:
                result.update(start=start, end=end)
        return [result], coverage
    # A split is permitted only at recognized words next to the punctuation.
    pieces, position = [], 0
    for part in parts:
        count = len(part.split())
        first, last = position, position + count - 1
        start_word, end_word = mapping.get(first), mapping.get(last)
        left = max(cue['start'], words[start_word]['start']) if start_word is not None else None
        right = min(cue['end'], words[end_word]['end']) if end_word is not None else None
        pieces.append(dict(en=part, start=left, end=right, first=first, last=last))
        position += count
    # A missing boundary stays merged with its neighbor. Do not invent even spacing.
    result = []
    pending = dict(en='', start=cue['start'], end=cue['end'])
    for i, piece in enumerate(pieces):
        if not pending['en'] and piece['start'] is not None:
            pending['start'] = piece['start']
        pending['en'] = (pending['en'] + ' ' + piece['en']).strip()
        if i == len(pieces) - 1:
            pending['end'] = piece['end'] or cue['end']
            if pending['end'] <= pending['start']:
                pending['end'] = cue['end']
            result.append(pending)
        elif piece['end'] is not None and pieces[i + 1]['start'] is not None:
            boundary = min(piece['end'], pieces[i + 1]['start'])
            if boundary - pending['start'] >= .12 and cue['end'] - boundary >= .12:
                pending['end'] = boundary
                result.append(pending)
                pending = dict(en='', start=max(boundary, pieces[i + 1]['start']), end=cue['end'])
    if any(p['start'] >= p['end'] for p in result) or any(a['end'] > z['start'] for a, z in zip(result, result[1:])):
        return [dict(cue)], coverage
    assert ' '.join(p['en'] for p in result) == cue['en']
    return result, coverage


def trim_marker(cue, marker, side, words):
    """Trim a cue shared by teaching and dialog using exact text and matched words."""
    if not marker:
        return cue
    at = cue['en'].find(marker)
    if at < 0:
        raise ValueError('Dialog marker is not present: ' + marker)
    point = at if side == 'start' else at + len(marker)
    if point in (0, len(cue['en'])):
        return cue
    tokens, mapping = token_mapping(cue['en'], words)
    split = len(cue['en'][:point].split())
    wi = mapping.get(split if side == 'start' else split - 1)
    if wi is None:
        raise ValueError('Dialog boundary lacks an audio word: ' + marker)
    result = dict(cue)
    result['en'] = cue['en'][point:].strip() if side == 'start' else cue['en'][:point].strip()
    result[side] = words[wi][side]
    return result


def validate_lesson(lesson, require_chinese=True):
    segments = lesson['segments']
    if not segments or not math.isfinite(lesson['duration']) or lesson['duration'] <= 0:
        raise ValueError('Empty lesson or invalid duration')
    ids = set()
    previous = 0
    for seg in segments:
        if seg['id'] in ids or not isinstance(seg['id'], int):
            raise ValueError('Duplicate or invalid sentence id')
        ids.add(seg['id'])
        if not all(math.isfinite(seg[k]) for k in ('start', 'end')):
            raise ValueError('Invalid timestamp')
        if not (0 <= seg['start'] < seg['end'] <= lesson['duration'] + .02) or seg['start'] < previous - .002:
            raise ValueError(f'Overlapping or out-of-range sentence {seg["id"]}: {seg["start"]}-{seg["end"]}, previous={previous}, duration={lesson["duration"]}, text={seg["en"][:100]}')
        previous = seg['end']
        if not seg['en'].strip() or (require_chinese and not seg['zh'].strip()):
            raise ValueError('Missing English or Chinese sentence')
    dialog = lesson['dialog']
    if not dialog['segmentIds'] or len(set(dialog['segmentIds'])) != len(dialog['segmentIds']):
        raise ValueError('Empty or duplicated dialog')
    if not 0 <= dialog['start'] < dialog['end'] <= lesson['duration']:
        raise ValueError('Invalid dialog interval')
    selected = [s for s in segments if s['id'] in set(dialog['segmentIds'])]
    if [s['id'] for s in selected] != dialog['segmentIds']:
        raise ValueError('Unknown or unordered dialog sentence')
    if any(s['start'] < dialog['start'] - .002 or s['end'] > dialog['end'] + .002 for s in selected):
        raise ValueError('Dialog sentence outside playback range')
    if abs(selected[0]['start'] - dialog['start']) > .002 or abs(selected[-1]['end'] - dialog['end']) > .002:
        raise ValueError('Dialog interval differs from selected sentences')


def write_text(path, text):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(text.replace('\r\n', '\n').replace('\n', '\r\n').encode('utf-8'))


def load_translations(path, overrides=None, preferred=None):
    cache = {}
    for source in (path, preferred):
        if source and source.exists():
            for line in source.read_text(encoding='utf-8').splitlines():
                try:
                    row = json.loads(line)
                    cache[row['en']] = row['zh']
                except json.JSONDecodeError:
                    pass  # The translator may still be writing its last line.
    if overrides and overrides.exists():
        cache.update(json.loads(overrides.read_text(encoding='utf-8')))
    return cache


def merge_evidence(evidence, recheck):
    """Keep independent hypotheses so a dropped utterance cannot erase evidence."""
    if not recheck:
        return evidence
    return dict(evidence, model=evidence['model'] + '+small.en/recheck', recheckClips=recheck['clips'])


def cue_words(cue, evidence, base_words):
    # ASR segment boundaries can move backwards. Filter without reordering its
    # transcript words; binary search is unsafe on these time sequences.
    alternatives = [[w for w in base_words
                     if cue['start'] - 1 <= w['start'] <= cue['end'] + 1]]
    for clip in evidence.get('recheckClips', []):
        if clip['start'] <= cue['end'] + 1 and clip['end'] >= cue['start'] - 1:
            alternatives.append([w for s in clip['segments'] for w in s['words']
                                 if w['start'] >= cue['start'] - 1 and w['end'] <= cue['end'] + 1])
    return max(alternatives, key=lambda candidate: len(token_mapping(cue['en'], candidate)[1]))


def build_episode(ep, source, evidence, boundary, translations, corrections, context_translations=None):
    original = parse_srt(source)
    words = [w for seg in evidence['segments'] for w in seg['words'] if normalize(w['word'])]
    segments, issues = [], []
    first, last = boundary['firstCue'], boundary['lastCue']
    replacements = {item['firstCue']: item for item in corrections}
    skip_to = -1
    for index, raw in enumerate(original):
        if index <= skip_to:
            continue
        cue = dict(raw)
        local = cue_words(cue, evidence, words)
        is_dialog = first <= index <= last
        if index in replacements:
            patch = replacements[index]
            skip_to = patch.get('lastCue', index)
            pieces = patch['segments']
            coverage = 1
        else:
            # Preserve non-dialog prefixes/suffixes as separate source cues.
            prefix, suffix = None, None
            try:
                if index == first:
                    trimmed = trim_marker(cue, boundary.get('startText'), 'start', local)
                    if trimmed['en'] != cue['en']:
                        prefix = dict(start=cue['start'], end=trimmed['start'], en=cue['en'][:cue['en'].find(trimmed['en'])].strip())
                    cue = trimmed
                if index == last:
                    trimmed = trim_marker(cue, boundary.get('endText'), 'end', local)
                    if trimmed['en'] != cue['en']:
                        suffix = dict(start=trimmed['end'], end=cue['end'], en=cue['en'][len(trimmed['en']):].strip())
                    cue = trimmed
            except ValueError as exc:
                issues.append(dict(cue=index, kind='boundary', detail=str(exc)))
            if prefix and prefix['en']:
                segments.append(dict(prefix, sourceCue=index, inDialog=False))
            pieces = [cue]
        segments.extend(dict(p, sourceCue=p.get('sourceCue', index), inDialog=p.get('inDialog', is_dialog)) for p in pieces)
        if index not in replacements and suffix and suffix['en']:
            segments.append(dict(suffix, sourceCue=index, inDialog=False))
    timing_report = {}
    try:
        from align_timing import retime_cues
    except ImportError:
        retime_cues = None
    if retime_cues:
        segments, timing_report = retime_cues(segments, evidence)
    split_segments = []
    for cue in segments:
        if cue['start'] >= evidence['duration']:
            issues.append(dict(cue=cue['sourceCue'], kind='outside_audio', source=cue['en']))
            continue
        if cue['end'] > evidence['duration']:
            issues.append(dict(cue=cue['sourceCue'], kind='trimmed_audio_end', oldEnd=cue['end'], end=evidence['duration']))
            cue = dict(cue, end=evidence['duration'])
        local = cue_words(cue, evidence, words)
        # Manually curated bilingual special-language rows already have meaningful boundaries.
        pieces, coverage = ([dict(cue)], 1) if cue.get('lockedTiming') or cue.get('zh') else align_cue(cue, local)
        if len(cue['en'].split()) >= 5 and coverage < .65:
            issues.append(dict(cue=cue['sourceCue'], kind='audio_disagreement', coverage=round(coverage, 3), start=cue['start'], end=cue['end'],
                               source=cue['en'], asr=' '.join(w['word'].strip() for w in local)))
        split_segments.extend(dict(p, sourceCue=cue['sourceCue'], inDialog=cue['inDialog']) for p in pieces)
    segments = split_segments
    context_translations = context_translations or {}
    for i, seg in enumerate(segments):
        zh = context_translations.get((ep['id'], seg['sourceCue'], seg['en'])) or seg.get('zh') or translations.get(seg['en'], '')
        seg.update(id=i + 1, start=round(seg['start'], 3), end=round(seg['end'], 3), zh=zh)
    selected = [s for s in segments if s['inDialog']]
    lesson = dict(version=1, id=ep['id'], number=ep['number'], title=ep['title'], audio=ep['mp3'],
                  duration=evidence['duration'], segments=[{k: s[k] for k in ('id', 'start', 'end', 'en', 'zh')} for s in segments],
                  dialog=dict(start=selected[0]['start'], end=selected[-1]['end'], segmentIds=[s['id'] for s in selected]))
    validate_lesson(lesson, require_chinese=False)
    audit = dict(id=ep['id'], sourceCues=len(original), sentences=len(segments), translated=sum(bool(s['zh']) for s in segments),
                 audioModel=evidence['model'], audioSha256=evidence['audio_sha256'], dialogConfidence=boundary['confidence'],
                 timing=timing_report, issues=issues, sourceMap=[s['sourceCue'] for s in segments])
    return lesson, audit


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--project', type=Path, default=Path(__file__).parents[1])
    parser.add_argument('--baseline', type=Path, required=True)
    parser.add_argument('--evidence', type=Path, required=True)
    parser.add_argument('--boundaries', type=Path, required=True)
    parser.add_argument('--translations', type=Path, required=True)
    parser.add_argument('--translation-overrides', type=Path)
    parser.add_argument('--preferred-translations', type=Path)
    parser.add_argument('--context-translations', type=Path)
    parser.add_argument('--corrections', type=Path)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--publish', action='store_true', help='Require all 365 audited, translated lessons and write SRT/TXT too')
    args = parser.parse_args()
    episodes = json.loads((args.project / 'manifest.json').read_text(encoding='utf-8'))
    boundaries = {b['id']: b for b in json.loads(args.boundaries.read_text(encoding='utf-8'))}
    corrections = json.loads(args.corrections.read_text(encoding='utf-8')) if args.corrections else {}
    translations = load_translations(args.translations, args.translation_overrides, args.preferred_translations)
    context_translations = {(r['id'], r['sourceCue'], r['en']): r['zh'] for r in
                            json.loads(args.context_translations.read_text(encoding='utf-8'))} if args.context_translations else {}
    pending, audits, failures, lessons = [], [], [], []
    with zipfile.ZipFile(args.baseline) as source:
        for ep in episodes:
            path = args.evidence / f'englishpod_{ep["number"]}.json'
            if not path.exists() or ep['id'] not in boundaries:
                pending.append(ep['id'])
                continue
            try:
                evidence = json.loads(path.read_text(encoding='utf-8'))
                recheck_path = args.evidence / 'rechecks' / path.name
                recheck = json.loads(recheck_path.read_text(encoding='utf-8')) if recheck_path.exists() else None
                evidence = merge_evidence(evidence, recheck)
                extra_clips = list(evidence.get('recheckClips', []))
                for extra in sorted((args.evidence / 'pending-rechecks').glob(f'{ep["id"]:04}-*.json')):
                    rows = json.loads(extra.read_text(encoding='utf-8'))['segments']
                    if rows:
                        extra_clips.append(dict(start=min(r['start'] for r in rows), end=max(r['end'] for r in rows), segments=rows))
                evidence = dict(evidence, recheckClips=extra_clips)
                lesson, audit = build_episode(ep, source.read(ep['srt']).decode('utf-8-sig'),
                                              evidence, boundaries[ep['id']], translations,
                                              corrections.get(str(ep['id']), []), context_translations)
                if args.publish:
                    validate_lesson(lesson)
                    if any(i['kind'] == 'boundary' for i in audit['issues']):
                        raise ValueError('Unresolved dialog boundary')
                lessons.append(lesson)
                audits.append(audit)
            except (ValueError, KeyError, IndexError) as exc:
                failures.append(dict(id=ep['id'], error=str(exc)))
    report = dict(completed=len(lessons), pending=pending, failures=failures, lessons=audits)
    write_text(args.output / 'audit.json', json.dumps(report, ensure_ascii=False, indent=2))
    if args.publish and (pending or failures or len(lessons) != 365):
        raise ValueError(f'Publication blocked: {len(pending)} pending, {len(failures)} failures')
    for lesson in lessons:
        name = f'englishpod_{lesson["number"]}'
        write_text(args.output / 'lessons' / (name + '.json'), json.dumps(lesson, ensure_ascii=False, indent=2))
        if args.publish:
            write_text(args.output / 'srt' / (name + '.srt'), dump_srt(lesson['segments']))
            write_text(args.output / 'txt' / (name + '.txt'), '\n\n'.join(s['en'] for s in lesson['segments']) + '\n')
    print(json.dumps({k: report[k] for k in ('completed', 'pending', 'failures')}, ensure_ascii=False))


if __name__ == '__main__':
    main()
