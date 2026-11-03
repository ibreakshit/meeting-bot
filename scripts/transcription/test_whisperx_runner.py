import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock
from whisperx_runner import transcribe


class RunnerTests(unittest.TestCase):
    def engine(self, segments=None):
        result = {'segments': segments if segments is not None else [
            {'text': 'hello', 'start': 0, 'end': 1, 'words': [{'word': 'hello'}]}], 'language': 'en'}
        return Mock(transcribe=Mock(return_value=result),
                    align=Mock(side_effect=lambda result, audio: result),
                    diarize=Mock(return_value=[{'start': 0, 'end': 1, 'speaker': 'SPEAKER_00'}]),
                    assign=Mock(side_effect=lambda intervals, result: result),
                    write=Mock())

    def test_preserves_native_and_diarization_separately(self):
        engine = self.engine()
        with tempfile.TemporaryDirectory() as directory:
            transcribe('audio.wav', directory, engine)
            raw = json.loads((Path(directory) / 'transcript.json').read_text())
            display = json.loads((Path(directory) / 'display.json').read_text())
            self.assertNotIn('id', raw['segments'][0])
            self.assertEqual(display['segments'][0]['id'], 'segment-000000')
            self.assertNotIn('start', raw['segments'][0]['words'][0])
            self.assertEqual(len(json.loads((Path(directory) / 'diarization.json').read_text())), 1)
            self.assertEqual(engine.diarize.call_count, 1)
            self.assertTrue((Path(directory) / 'result.json').exists())

    def test_silence_is_valid(self):
        with tempfile.TemporaryDirectory() as directory:
            transcribe('audio.wav', directory, self.engine([]))
            self.assertEqual(json.loads((Path(directory) / 'display.json').read_text())['segments'], [])

    def test_failure_never_announces_completion(self):
        engine = self.engine()
        engine.align.side_effect = RuntimeError('alignment unavailable')
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(RuntimeError):
                transcribe('audio.wav', directory, engine)
            self.assertFalse((Path(directory) / 'result.json').exists())


class RealignmentTests(unittest.TestCase):
    def test_realigns_each_owned_window_and_reuses_diarization(self):
        from whisperx_runner import realign
        engine = RunnerTests().engine()
        def align(result, audio):
            text = result['segments'][0]['text']
            return {'language': 'en', 'segments': [
                {'text': text, 'start': 4, 'end': 6, 'words': [
                    {'word': 'Google', 'start': 4, 'end': 5},
                    {'word': 'Meet', 'start': 5, 'end': 6}]}]}
        engine.align.side_effect = align
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = {'language': 'en', 'segments': [{'id': 's1', 'text': 'Google Meet', 'start': 4, 'end': 6, 'words': []}]}
            save = root / 'segments.json'
            save.write_text(json.dumps(source))
            diarization = root / 'saved.json'
            diarization.write_text(json.dumps([{'start': 4, 'end': 6, 'speaker': 'SPEAKER_00'}]))
            before = save.read_bytes()
            realign('audio.wav', save, diarization, root / 'out', engine)
            result = json.loads((root / 'out/transcript.json').read_text())
            self.assertEqual(len(result['word_segments']), 2)
            display = json.loads((root / 'out/display.json').read_text())
            self.assertEqual(display['segments'][0]['id'], 's1')
            self.assertEqual(display['segments'][0]['text'], 'Google Meet')
            self.assertEqual(engine.transcribe.call_count, 0)
            self.assertEqual(engine.diarize.call_count, 0)
            self.assertEqual(before, save.read_bytes())

    def test_missing_alignment_is_never_fabricated(self):
        from whisperx_runner import realign
        engine = RunnerTests().engine()
        engine.align.side_effect = lambda result, audio: {'segments': [{'text': 'hello', 'words': [{'word': 'hello'}]}]}
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'segments.json').write_text(json.dumps({'language': 'ko', 'segments': [{'id': 's', 'start': 0, 'end': 1, 'text': 'hello'}]}))
            (root / 'saved.json').write_text('[]')
            realign('audio', root / 'segments.json', root / 'saved.json', root / 'out', engine)
            word = json.loads((root / 'out/transcript.json').read_text())['word_segments'][0]
            self.assertNotIn('start', word)
