import os
import re
import json

pattern = re.compile(r'^(\d+)\.\s+(.+)\.mp3$')

entries = []
for f in sorted(os.listdir('mp3')):
    if not f.endswith('.mp3'):
        continue
    m = pattern.match(f)
    if not m:
        continue
    num = int(m.group(1))
    title = m.group(2)
    padded = f'{num:04d}'

    srt_path = f'srt/englishpod_{padded}.srt'
    txt_path = f'txt/englishpod_{padded}.txt'
    pdf_path = f'pdf/englishpod_{padded}.pdf'

    entries.append({
        'id': num,
        'number': padded,
        'title': title,
        'mp3': f'mp3/{f}',
        'srt': srt_path,
        'txt': txt_path,
        'pdf': pdf_path,
        'md': f'md/englishpod_{padded}.md'
    })

entries.sort(key=lambda x: x['id'])

with open('manifest.json', 'w', encoding='utf-8') as f:
    json.dump(entries, f, ensure_ascii=False, indent=2)

print(f'Generated manifest.json with {len(entries)} entries')
