import importlib.util
import pathlib
import sys
import unittest

MODULE = pathlib.Path(__file__).parents[1] / 'tools' / 'build_lessons.py'
sys.path.insert(0, str(MODULE.parent))
spec = importlib.util.spec_from_file_location('builder', MODULE)
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)


class LessonBuilderTests(unittest.TestCase):
    def test_cue_words_does_not_drop_words_when_asr_times_go_backwards(self):
        words = [dict(word=w, start=t, end=t + .2) for w, t in
                 [('before', 0), ('hello', 6), ('overlap', 5), ('after', 10)]]
        chosen = builder.cue_words(dict(start=6.5, end=6.8, en='hello'), {}, words)
        self.assertEqual([w['word'] for w in chosen], ['hello'])

    def test_recheck_words_can_cover_text_without_covering_source_silence(self):
        words = [dict(word='Hello', start=2, end=2.4), dict(word='there.', start=2.5, end=3)]
        evidence = dict(recheckClips=[dict(start=2, end=3, segments=[dict(words=words)])])
        chosen = builder.cue_words(dict(start=1, end=5, en='Hello there.'), evidence, [])
        self.assertEqual([w['word'] for w in chosen], ['Hello', 'there.'])

    def test_outside_source_time_gets_audio_alignment_before_duration_filter(self):
        text = 'The careful student brings another green notebook.'
        evidence = dict(duration=10, model='test', audio_sha256='test', segments=[dict(words=[
            dict(word=w, start=2 + i * .25, end=2.2 + i * .25, probability=.99)
            for i, w in enumerate(text.split())])])
        lesson, audit = builder.build_episode(
            dict(id=1, number='0001', title='Example', mp3='test.mp3'),
            '1\n00:00:11,000 --> 00:00:13,000\n' + text + '\n', evidence,
            dict(firstCue=0, lastCue=0, confidence='test'), {}, [])
        self.assertEqual(lesson['segments'][0]['en'], text)
        self.assertEqual(lesson['segments'][0]['start'], 2)
        self.assertFalse(any(i['kind'] == 'outside_audio' for i in audit['issues']))

    def test_locked_untranslated_correction_keeps_timing_through_build(self):
        evidence = dict(duration=10, model='test', audio_sha256='test', segments=[dict(words=[
            dict(word='Hello', start=2, end=2.5, probability=.99),
            dict(word='there.', start=2.5, end=3, probability=.99)])])
        lesson, _ = builder.build_episode(
            dict(id=1, number='0001', title='Example', mp3='test.mp3'),
            '1\n00:00:01,000 --> 00:00:05,000\nHello there.\n', evidence,
            dict(firstCue=0, lastCue=0, confidence='test'), {},
            [dict(firstCue=0, segments=[dict(start=1, end=5, en='Hello there.', lockedTiming=True)])])
        self.assertEqual((lesson['segments'][0]['start'], lesson['segments'][0]['end']), (1, 5))

    def test_crlf_srt_and_roundtrip(self):
        text = '1\r\n00:00:01,200 --> 00:00:04,600\r\nHello there.\r\n\r\n'
        cues = builder.parse_srt(text)
        self.assertEqual(cues, [{'start': 1.2, 'end': 4.6, 'en': 'Hello there.'}])
        self.assertEqual(builder.parse_srt(builder.dump_srt(cues)), cues)

    def test_sentence_boundaries_preserve_abbreviations_and_whole_text(self):
        text = 'Dr. Smith costs $3.50. Really? Yes!'
        parts = builder.sentence_parts(text)
        self.assertEqual(parts, ['Dr. Smith costs $3.50.', 'Really?', 'Yes!'])
        self.assertEqual(' '.join(parts), text)

    def test_initialisms_do_not_split_a_sentence_inside_its_subject(self):
        self.assertEqual(builder.sentence_parts('The U.S. Embassy opens at 9 a.m. on Monday. Is that clear?'),
                         ['The U.S. Embassy opens at 9 a.m. on Monday.', 'Is that clear?'])

    def test_split_uses_audio_words_instead_of_equal_durations(self):
        cue = {'start': 1, 'end': 10, 'en': 'Hello there. How are you?'}
        words = [dict(word=w, start=s, end=e) for w, s, e in
                 [('Hello', 1.1, 1.8), ('there.', 2, 2.3), ('How', 5, 5.5), ('are', 5.5, 5.8), ('you?', 5.8, 6.5)]]
        parts, _ = builder.align_cue(cue, words)
        self.assertEqual([p['en'] for p in parts], ['Hello there.', 'How are you?'])
        self.assertEqual(parts[1]['start'], 5)
        self.assertEqual(parts[0]['end'], 2.3)

    def test_unrecognized_boundary_is_not_fabricated(self):
        cue = {'start': 1, 'end': 10, 'en': 'Hello there. How are you?'}
        parts, _ = builder.align_cue(cue, [])
        self.assertEqual(parts, [cue])

    def test_matching_word_outside_cue_cannot_create_negative_duration(self):
        cue = dict(start=1, end=2, en='Hello there. Bye now.')
        words = [dict(word=w, start=s, end=e) for w, s, e in
                 [('Hello', 1, 1.2), ('there.', 1.2, 1.4), ('Bye', 2.3, 2.5), ('now.', 2.5, 2.7)]]
        parts, _ = builder.align_cue(cue, words)
        self.assertEqual(parts, [cue])

    def test_dialog_requires_all_ids_inside_range(self):
        lesson = dict(duration=10, segments=[dict(id=1, start=1, end=3, en='Hi.', zh='你好。')],
                      dialog=dict(start=1, end=2, segmentIds=[1]))
        with self.assertRaises(ValueError):
            builder.validate_lesson(lesson)

    def test_missing_translation_and_overlaps_are_rejected(self):
        lesson = dict(duration=10, segments=[dict(id=1, start=1, end=3, en='Hi.', zh='')],
                      dialog=dict(start=1, end=3, segmentIds=[1]))
        with self.assertRaises(ValueError):
            builder.validate_lesson(lesson)


if __name__ == '__main__':
    unittest.main()
