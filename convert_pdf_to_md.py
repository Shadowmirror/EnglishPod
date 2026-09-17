import os
import re
import pdfplumber

PDF_DIR = 'pdf'
OUT_DIR = 'md'

LIGATURES = {
    'ﬁ': 'fi', 'ﬂ': 'fl', 'ﬃ': 'ffi',
    'ﬄ': 'ffl', 'ﬀ': 'ff', 'ﬆ': 'st',
}

COL_POS = 210
COL_DEF = 340

FOOTER_PATTERN = re.compile(
    r'Visit.*?Online.*?Review|Praxis.*?Language|\(cid:\d+\)|c\d{4}.*?Ltd|andDiscussion\(textversion\)',
    re.IGNORECASE,
)
PLAIN_FOOTER = re.compile(
    r'Visit\s*the\s*Online\s*Review\s*and\s*Discussion.*?$|'
    r'\(cid:\d+\)\s*c\d{4}.*?Ltd.*?$|'
    r'c\d{4}\s*Praxis.*?Ltd.*?$',
    re.MULTILINE | re.IGNORECASE,
)

SECTION_HEADERS = {'Key', 'Vocabulary', 'Supplementary'}


def fix_ligatures(text):
    for k, v in LIGATURES.items():
        text = text.replace(k, v)
    return text


def is_footer(word):
    return bool(FOOTER_PATTERN.search(word['text']))


def classify_col(word):
    x = word['x0']
    if x < COL_POS:
        return 'word'
    elif x < COL_DEF:
        return 'pos'
    else:
        return 'def'


def group_words_by_line(words):
    if not words:
        return []
    lines = []
    cur = [words[0]]
    for w in words[1:]:
        if abs(w['top'] - cur[0]['top']) < 10:
            cur.append(w)
        else:
            lines.append(sorted(cur, key=lambda w: w['x0']))
            cur = [w]
    if cur:
        lines.append(sorted(cur, key=lambda w: w['x0']))
    return lines


def parse_vocab_entries(words):
    lines = group_words_by_line(words)
    entries = []
    cur = None

    for line in lines:
        cols = {'word': [], 'pos': [], 'def': []}
        for w in line:
            col = classify_col(w)
            if col in cols:
                cols[col].append(fix_ligatures(w['text']))

        has_word = bool(cols['word'])
        has_pos = bool(cols['pos'])
        has_def = bool(cols['def'])

        # Filter out section header lines and footer-only lines
        word_text = ' '.join(cols['word']).strip()
        if word_text in ('Key Vocabulary', 'Supplementary Vocabulary'):
            continue
        if not has_word and not has_pos and not has_def:
            continue

        # Determine if this starts a new entry
        # A new entry has a POS keyword on the same line as word-column text
        is_new = has_word and has_pos

        if is_new:
            if cur:
                entries.append(finalize(cur))
            cur = {
                'word_parts': [word_text],
                'pos_parts': [' '.join(cols['pos'])],
                'def_parts': [' '.join(cols['def'])] if has_def else [],
            }
        elif has_word and not has_pos and not has_def:
            # Word continuation only (multi-line word, no POS or def)
            if cur:
                cur['word_parts'].append(word_text)
            else:
                cur = {'word_parts': [word_text], 'pos_parts': [], 'def_parts': []}
        elif has_word and not has_pos and has_def:
            # Multi-line entry where word wraps and def continues
            # This happens when word column text is actually a continuation
            # AND definition also continues
            if cur:
                cur['word_parts'].append(word_text)
                cur['def_parts'].append(' '.join(cols['def']))
            else:
                cur = {'word_parts': [word_text], 'pos_parts': [], 'def_parts': [' '.join(cols['def'])]}
        elif not has_word and has_pos and has_def:
            # POS + def continuation (no word)
            if cur:
                cur['pos_parts'].append(' '.join(cols['pos']))
                cur['def_parts'].append(' '.join(cols['def']))
        elif not has_word and has_pos:
            # POS continuation only
            if cur:
                cur['pos_parts'].append(' '.join(cols['pos']))
            else:
                cur = {'word_parts': [], 'pos_parts': [' '.join(cols['pos'])], 'def_parts': []}
        elif not has_word and not has_pos and has_def:
            # Definition continuation only
            if cur:
                cur['def_parts'].append(' '.join(cols['def']))
        elif has_word and has_pos and not has_def:
            # New entry without definition yet
            if cur:
                entries.append(finalize(cur))
            cur = {
                'word_parts': [word_text],
                'pos_parts': [' '.join(cols['pos'])],
                'def_parts': [],
            }

    if cur:
        entries.append(finalize(cur))

    return entries


def finalize(entry):
    word = ' '.join(entry['word_parts'])
    word = re.sub(r'\s*-\s*', '', word)
    word = re.sub(r'\s+', ' ', word).strip()

    pos = ' '.join(entry['pos_parts'])
    pos = re.sub(r'\s*-\s*', '', pos)
    pos = re.sub(r'\s+', ' ', pos).strip()

    definition = ' '.join(entry['def_parts'])
    definition = re.sub(r'\s+', ' ', definition).strip()

    return {'word': word, 'pos': pos, 'definition': definition}


def format_entry(entry):
    w, p, d = entry['word'], entry['pos'], entry['definition']
    if w and p and d:
        return f'- **{w}** *{p}* — {d}'
    elif w and p:
        return f'- **{w}** *{p}*'
    elif w and d:
        return f'- **{w}** — {d}'
    elif w:
        return f'- **{w}**'
    return ''


def convert_pdf(pdf_path):
    with pdfplumber.open(pdf_path) as pdf:
        # --- Title & Dialog (plain text) ---
        all_plain = []
        for page in pdf.pages:
            text = page.extract_text()
            if text:
                text = fix_ligatures(text)
                text = PLAIN_FOOTER.sub('', text)
                all_plain.append(text)

        full_text = '\n'.join(all_plain)
        lines = full_text.split('\n')
        lines = [l.strip() for l in lines if l.strip()]

        title = lines[0] if lines else ''

        # Extract dialog (everything before "Key Vocabulary")
        dialog_lines = []
        for line in lines[1:]:
            if line in ('Key Vocabulary', 'Supplementary Vocabulary'):
                break
            if re.match(r'^[A-Z]:\s', line):
                dialog_lines.append(line)
            elif dialog_lines:
                dialog_lines[-1] += ' ' + line

        # --- Vocabulary (word positions) ---
        # Collect all pages' words and headers with global y-offsets
        vocab_sections = []
        current_header = None
        current_vocab_words = []

        for page in pdf.pages:
            page_words = page.extract_words(keep_blank_chars=True, x_tolerance=3)
            page_words = [w for w in page_words if not is_footer(w)]

            # Find section headers on this page
            header_tops = []
            for w in page_words:
                if w['text'] == 'Key' or w['text'] == 'Supplementary':
                    next_words = [nw for nw in page_words
                                  if abs(nw['top'] - w['top']) < 10 and nw['x0'] > w['x0']]
                    if any(nw['text'] == 'Vocabulary' for nw in next_words):
                        header_tops.append((w['top'], w['text'] + ' Vocabulary'))

            if header_tops:
                first_header_top = header_tops[0][0]
                # Words before the first header belong to the previous section
                pre_header_words = [w for w in page_words if w['top'] < first_header_top - 5]
                if current_header and pre_header_words:
                    current_vocab_words.extend(pre_header_words)

                # Process headers in order — each defines a new region
                for idx, (h_top, h_text) in enumerate(header_tops):
                    # Flush previous section first
                    if current_header and current_vocab_words:
                        entries = parse_vocab_entries(current_vocab_words)
                        vocab_sections.append((current_header, entries))

                    current_header = h_text
                    # Words between this header and the next header (or page end)
                    if idx + 1 < len(header_tops):
                        next_top = header_tops[idx + 1][0]
                        current_vocab_words = [w for w in page_words
                                               if w['top'] > h_top + 15 and w['top'] < next_top - 5]
                    else:
                        current_vocab_words = [w for w in page_words if w['top'] > h_top + 15]
            elif current_header:
                # Continuation page — all words are vocab
                current_vocab_words.extend(page_words)

        # Flush last section
        if current_header and current_vocab_words:
            entries = parse_vocab_entries(current_vocab_words)
            vocab_sections.append((current_header, entries))

    # Build Markdown
    md = []
    if title:
        md.append(f'# {title}')
        md.append('')
    for dl in dialog_lines:
        speaker, rest = dl.split(': ', 1)
        md.append(f'**{speaker}:** {rest}')
        md.append('')
    if dialog_lines:
        md.append('')
    for header, entries in vocab_sections:
        md.append(f'## {header}')
        md.append('')
        for e in entries:
            line = format_entry(e)
            if line:
                md.append(line)
        md.append('')

    return '\n'.join(md)


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    pdf_files = sorted(f for f in os.listdir(PDF_DIR) if f.endswith('.pdf'))
    total = len(pdf_files)
    success = 0
    failed = []

    for i, filename in enumerate(pdf_files, 1):
        num = filename.replace('englishpod_', '').replace('.pdf', '')
        pdf_path = os.path.join(PDF_DIR, filename)
        md_path = os.path.join(OUT_DIR, f'englishpod_{num}.md')

        try:
            md_content = convert_pdf(pdf_path)
            with open(md_path, 'w', encoding='utf-8') as f:
                f.write(md_content)
            success += 1
        except Exception as e:
            print(f'ERROR {filename}: {e}')
            failed.append(filename)

        if i % 50 == 0 or i == total:
            print(f'[{i}/{total}] {success} ok' + (f', {len(failed)} failed' if failed else ''))

    print(f'\nDone: {success} converted, {len(failed)} failed')
    if failed:
        for f in failed:
            print(f'  {f}')


if __name__ == '__main__':
    main()
