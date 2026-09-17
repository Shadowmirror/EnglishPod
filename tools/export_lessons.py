"""Re-export English SRT/TXT after editing the shared bilingual lesson JSON."""
import argparse
import json
from pathlib import Path
from build_lessons import dump_srt, validate_lesson, write_text


def export(root):
    files = sorted((root / 'lessons').glob('englishpod_*.json'))
    lessons = []
    for path in files:
        lesson = json.loads(path.read_text(encoding='utf-8'))
        validate_lesson(lesson)
        lessons.append((path.stem, lesson))
    for name, lesson in lessons:
        write_text(root / 'srt' / (name + '.srt'), dump_srt(lesson['segments']))
        write_text(root / 'txt' / (name + '.txt'), '\n\n'.join(s['en'] for s in lesson['segments']) + '\n')
    return len(lessons)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=Path(__file__).parents[1])
    args = parser.parse_args()
    print(f'Exported {export(args.root)} synchronized SRT/TXT pairs.')
