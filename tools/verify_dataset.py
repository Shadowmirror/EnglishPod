"""Validate the served 365-lesson corpus and its SRT/TXT exports."""
import argparse
import json
from pathlib import Path
from build_lessons import parse_srt, validate_lesson


def verify(root):
    manifest = json.loads((root / 'manifest.json').read_text(encoding='utf-8'))
    if [e['id'] for e in manifest] != list(range(1, 366)):
        raise ValueError('Manifest must contain lessons 1 through 365 once, in order')
    sentence_count = 0
    for entry in manifest:
        name = f'englishpod_{entry["number"]}'
        lesson = json.loads((root / 'lessons' / (name + '.json')).read_text(encoding='utf-8'))
        validate_lesson(lesson)
        if (lesson['id'], lesson['number'], lesson['audio']) != (entry['id'], entry['number'], entry['mp3']):
            raise ValueError(f'{name}: metadata differs from manifest')
        if not (root / lesson['audio']).is_file():
            raise ValueError(f'{name}: audio missing')
        expected = [{k: s[k] for k in ('start', 'end', 'en')} for s in lesson['segments']]
        exported = parse_srt((root / entry['srt']).read_text(encoding='utf-8'))
        exported = [dict(row, start=round(row['start'], 3), end=round(row['end'], 3)) for row in exported]
        if exported != expected:
            raise ValueError(f'{name}: SRT differs from shared sentence data')
        text = '\n\n'.join(s['en'] for s in lesson['segments']) + '\n'
        if (root / entry['txt']).read_text(encoding='utf-8') != text:
            raise ValueError(f'{name}: TXT differs from shared sentence data')
        sentence_count += len(lesson['segments'])
    files = list((root / 'lessons').glob('englishpod_*.json'))
    if len(files) != 365:
        raise ValueError('Unexpected lesson JSON files')
    return dict(lessons=365, sentences=sentence_count, translated=sentence_count, dialogs=365,
                audioFiles=365, exportsSynchronized=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=Path(__file__).parents[1])
    args = parser.parse_args()
    print(json.dumps(verify(args.root), ensure_ascii=False, indent=2))
