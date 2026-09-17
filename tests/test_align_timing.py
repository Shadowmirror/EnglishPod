import importlib.util
import pathlib
import unittest

MODULE = pathlib.Path(__file__).parents[1] / 'tools' / 'align_timing.py'
spec = importlib.util.spec_from_file_location('align_timing', MODULE)
aligner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(aligner)


def spoken(text, start, step=.25):
    return [dict(word=token, start=round(start + i * step, 3),
                 end=round(start + i * step + .2, 3), probability=.98)
            for i, token in enumerate(text.split())]


def evidence(*word_groups, rechecks=(), duration=30):
    return dict(duration=duration, segments=[dict(words=group) for group in word_groups],
                recheckClips=[dict(segments=[dict(words=group)]) for group in rechecks])


class AlignTimingTests(unittest.TestCase):
    def test_short_cue_expands_from_complete_recheck_when_base_drops_words(self):
        text = "I've never gotten one of those because I don't have a home."
        full = spoken(text, 4.2)
        full[6]['end'] = full[6]['start']  # Recheck recognizes an internal word at zero duration.
        full[6]['probability'] = .32
        cues = [dict(start=5.0, end=6.0, en=text)]
        result, report = aligner.retime_cues(cues, evidence(full[:6], rechecks=[full]))
        self.assertEqual(result, [dict(start=4.2, end=7.15, en=text)])
        self.assertEqual(report['changed'], 1)

    def test_repeated_phrase_uses_nearby_occurrence_not_first_global_match(self):
        text = 'We are back.'
        cues = [dict(start=4.8, end=5.7, en=text), dict(start=14.7, end=15.5, en=text)]
        result, report = aligner.retime_cues(cues, evidence(spoken(text, 5), spoken(text, 15)))
        self.assertEqual([cue['start'] for cue in result], [5, 15])
        self.assertEqual([cue['en'] for cue in result], [text, text])
        self.assertLessEqual(result[0]['end'], result[1]['start'])

    def test_missing_audio_words_keeps_original_cue_and_reports_it(self):
        cue = dict(start=5, end=7, en='The world turns upside down.')
        result, report = aligner.retime_cues([cue], evidence(spoken('The world', 5.1)))
        self.assertEqual(result, [cue])
        self.assertEqual(report['changed'], 0)
        self.assertEqual(report['unresolved'][0]['cue'], 0)

    def test_proposals_never_overlap_or_reorder_cues(self):
        cues = [dict(start=1, end=2, en='First long phrase.'),
                dict(start=2, end=3, en='Second clear phrase.')]
        result, report = aligner.retime_cues(
            cues, evidence(spoken('First long phrase.', 1.1, .6),
                           spoken('Second clear phrase.', 2.4, .3)))
        self.assertEqual([cue['en'] for cue in result], [cue['en'] for cue in cues])
        self.assertEqual(len(result), len(cues))
        self.assertLessEqual(result[0]['end'], result[1]['start'])
        self.assertTrue(all(cue['start'] < cue['end'] for cue in result))

    def test_ambiguous_repetition_is_not_forced_to_either_occurrence(self):
        cue = dict(start=10, end=11, en='We are back.')
        result, report = aligner.retime_cues(
            [cue], evidence(spoken('We are back.', 5), spoken('We are back.', 15)))
        self.assertEqual(result, [cue])
        self.assertEqual(report['changed'], 0)

    def test_neighboring_short_replies_move_before_compressed_long_cue(self):
        long_text = "I've never gotten one of those because I don't have a home."
        okay = dict(word='Okay.', start=1.8, end=2.0, probability=.58)
        yeah = dict(word='Yeah.', start=2.2, end=2.4, probability=.9)
        cues = [dict(start=1, end=1.6, en='Before.'),
                dict(start=2, end=3, en='Okay.'),
                dict(start=3, end=4, en='Yeah.'),
                dict(start=4, end=5, en=long_text)]
        result, report = aligner.retime_cues(
            cues, evidence([okay, yeah] + spoken(long_text, 2.6)))
        self.assertEqual([(cue['start'], cue['end']) for cue in result[1:]],
                         [(1.8, 2.0), (2.2, 2.4), (2.6, 5.55)])
        self.assertEqual(report['changed'], 3)

    def test_two_unique_global_anchors_can_move_a_contiguous_block(self):
        first = 'The quick brown fox jumps happily.'
        second = 'Another bright orange fox follows slowly.'
        cues = [dict(start=10, end=12, en=first, sourceCue=7, inDialog=True),
                dict(start=12, end=14, en=second, sourceCue=8, inDialog=True)]
        result, report = aligner.retime_cues(
            cues, evidence(spoken(first, 30), spoken(second, 33), duration=50))
        self.assertEqual([(cue['start'], cue['end']) for cue in result],
                         [(30, 31.45), (33, 34.45)])
        self.assertEqual([cue['sourceCue'] for cue in result], [7, 8])
        self.assertTrue(all(cue['inDialog'] for cue in result))
        self.assertEqual(report['changed'], 2)

    def test_repeated_global_phrase_does_not_jump_to_a_different_performance(self):
        text = 'The quick brown fox jumps happily.'
        cue = dict(start=10, end=12, en=text)
        result, report = aligner.retime_cues(
            [cue], evidence(spoken(text, 30), spoken(text, 60), duration=90))
        self.assertEqual(result, [cue])
        self.assertEqual(report['changed'], 0)

    def test_rejected_tiny_reply_cannot_leave_following_cue_overlapping(self):
        cues = [dict(start=1, end=2, en='Yeah.'),
                dict(start=2, end=4, en='This is the following sentence.')]
        tiny_reply = [dict(word='Yeah.', start=1.9, end=1.92, probability=.99)]
        following = spoken('This is the following sentence.', 1.94)
        result, report = aligner.retime_cues(
            cues, evidence(tiny_reply, following))
        self.assertEqual(result[0], cues[0])
        self.assertLessEqual(result[0]['end'], result[1]['start'])
        self.assertIn('invalid_audio_range', [item['reason'] for item in report['unresolved']])

    def test_locked_timing_is_preserved_and_constrains_neighbors(self):
        locked = dict(start=2, end=4, en='The singer is singing.',
                      lockedTiming=True, sourceCue=12)
        following = dict(start=4, end=6, en='The hosts return.')
        result, report = aligner.retime_cues(
            [locked, following],
            evidence(spoken(locked['en'], 2.5), spoken(following['en'], 3.9)))
        self.assertEqual(result[0], locked)
        self.assertGreaterEqual(result[1]['start'], locked['end'])
        self.assertEqual(len(result), 2)

    def test_small_boundary_correction_is_kept_when_neighbor_uses_it(self):
        cues = [dict(start=1, end=2, en='Just one thing.'),
                dict(start=2, end=3, en='Another sentence follows.')]
        result, _ = aligner.retime_cues(
            cues, evidence(spoken('Just one thing.', 1, .37),
                           spoken('Another sentence follows.', 1.94, .3)))
        self.assertEqual(result[0]['end'], 1.94)
        self.assertLessEqual(result[0]['end'], result[1]['start'])

    def test_long_distinctive_cue_tolerates_contraction_and_one_asr_substitution(self):
        text = ('And it would be rude to decline his invitation. I guess so. '
                'You always rope me into things like this.')
        recognized = ('And itll be rude to decline his invitation I guess so '
                      'You always wrote me into things like this')
        cues = [dict(start=5, end=25, en=text)]
        result, report = aligner.retime_cues(
            cues, evidence(spoken(recognized, 15, .25), duration=30))
        self.assertEqual(result[0]['start'], 15)
        self.assertEqual(result[0]['end'], 19.7)
        self.assertEqual(result[0]['en'], text)
        self.assertEqual(report['changed'], 1)

    def test_fuzzy_match_rejects_similar_but_different_line(self):
        text = 'And it would be rude to decline his invitation today.'
        different = 'And it might be nice to accept your invitation today.'
        cue = dict(start=5, end=8, en=text)
        result, report = aligner.retime_cues(
            [cue], evidence(spoken(different, 15), duration=30))
        self.assertEqual(result, [cue])
        self.assertEqual(report['changed'], 0)

    def test_fuzzy_match_does_not_choose_between_repeated_performances(self):
        text = ('And it would be rude to decline his invitation. I guess so. '
                'You always rope me into things like this.')
        recognized = ('And itll be rude to decline his invitation I guess so '
                      'You always wrote me into things like this')
        cue = dict(start=30, end=35, en=text)
        result, report = aligner.retime_cues(
            [cue], evidence(spoken(recognized, 20), spoken(recognized, 40), duration=60))
        self.assertEqual(result, [cue])
        self.assertEqual(report['changed'], 0)

    def test_unique_long_cue_can_use_original_end_as_global_anchor(self):
        previous = dict(start=10, end=20, en='The guests arrive for dinner.')
        text = 'We are really anxious to see what happens in this dinner party.'
        cue = dict(start=20, end=43, en=text)
        next_cue = dict(start=43, end=45, en='Stay tuned.')
        result, report = aligner.retime_cues(
            [previous, cue, next_cue],
            evidence(spoken(previous['en'], 15), spoken(text, 39, .25),
                     spoken(next_cue['en'], 43.2), duration=50))
        self.assertEqual(result[1]['start'], 39)
        self.assertLessEqual(result[0]['end'], result[1]['start'])
        self.assertLessEqual(result[1]['end'], result[2]['start'])

    def test_two_full_audio_anchors_recover_ninety_six_second_offset(self):
        first = 'The trees outside seemed to come alive and formed shadows.'
        second = 'All of a sudden we heard screaming outside.'
        cues = [dict(start=110, end=115, en=first, sourceCue=71),
                dict(start=115, end=120, en=second, sourceCue=72)]
        result, report = aligner.retime_cues(
            cues, evidence(spoken(first, 14), spoken(second, 19), duration=30))
        self.assertEqual([cue['start'] for cue in result], [14, 19])
        self.assertEqual([cue['sourceCue'] for cue in result], [71, 72])
        self.assertEqual([change['globalAnchor'] for change in report['changes']],
                         [True, True])



if __name__ == '__main__':
    unittest.main()
