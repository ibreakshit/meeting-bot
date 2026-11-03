"""Small host adapter around the installed WhisperX fork. No engine internals."""
import argparse
import contextlib
import logging
import re
import copy
import json
import os
import sys
import time
import warnings
from pathlib import Path


@contextlib.contextmanager
def retained_warnings():
    retained = []
    class Capture:
        def __init__(self, stream):
            self.stream = stream
            self.pending = ''
        def write(self, text):
            self.stream.write(text)
            self.pending = (self.pending + text)[-65536:]
            while '\n' in self.pending:
                line, self.pending = self.pending.split('\n', 1)
                if re.search(r'GPU FALLBACK WARNING|CPU.*fallback|using.*CPU backend', line, re.I):
                    if line not in retained:
                        retained.append(line[:2048])
            return len(text)
        def flush(self):
            self.stream.flush()
    class LogCapture(logging.Handler):
        def emit(self, record):
            message = record.getMessage()
            if re.search(r'GPU FALLBACK WARNING|CPU.*fallback|using.*CPU backend', message, re.I) and message not in retained:
                retained.append(message[:2048])
    logger = logging.getLogger()
    handler = LogCapture()
    logger.addHandler(handler)
    try:
        with warnings.catch_warnings(record=True) as captured, contextlib.redirect_stdout(Capture(sys.stdout)), contextlib.redirect_stderr(Capture(sys.stderr)):
            warnings.simplefilter('always')
            yield retained
        retained.extend(str(item.message) for item in captured)
    finally:
        logger.removeHandler(handler)


def save_json(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, allow_nan=False), encoding='utf-8')


def display_segments(result):
    return [{**segment, 'id': f'segment-{index:06d}', 'words': segment.get('words', [])}
            for index, segment in enumerate(result['segments'])]


def transcribe(audio_path, output_directory, engine):
    output = Path(output_directory)
    output.mkdir(parents=True, exist_ok=True, mode=0o700)
    started = time.monotonic()
    with retained_warnings() as retained:
        result = engine.transcribe(audio_path)
        result = engine.align(result, audio_path)
        intervals = engine.diarize(audio_path) if result['segments'] else []
        save_json(output / 'diarization.json', intervals)
        result = engine.assign(intervals, result) if intervals else result
        # Do not annotate native engine output with application identifiers.
        save_json(output / 'transcript.json', result)
        save_json(output / 'display.json', {'language': result['language'], 'segments': display_segments(result)})
        engine.write(result, output)
    for message in retained:
        print(message, file=sys.stderr)
    save_json(output / 'result.json', {'language': result['language'], 'warnings': retained,
              'durationSeconds': time.monotonic() - started, 'deviceRequested': 'vulkan'})


def realign(audio_path, segments_path, diarization_path, output_directory, engine):
    started = time.monotonic()
    source = json.loads(Path(segments_path).read_text())
    intervals = json.loads(Path(diarization_path).read_text())
    output = Path(output_directory)
    output.mkdir(parents=True, exist_ok=True, mode=0o700)
    native = {'language': source['language'], 'segments': [], 'word_segments': []}
    display = []
    with retained_warnings() as retained:
        for segment in source['segments']:
            if 'start' not in segment or 'end' not in segment:
                raise ValueError('Corrected segment has no original audio window')
            aligned = engine.align({'language': source['language'], 'segments': [
                {key: segment[key] for key in ('text', 'start', 'end')}]}, audio_path)
            assigned = engine.assign(intervals, aligned) if intervals else aligned
            words = []
            for item in assigned['segments']:
                native['segments'].append(item)
                words.extend(item.get('words', []))
            for word in words:
                for key in ('start', 'end'):
                    if key in word and not segment['start'] <= word[key] <= segment['end'] + 0.01:
                        raise ValueError('Aligned word outside source audio window')
            native['word_segments'].extend(words)
            # Keep canonical text/ranges while reporting freshly assigned speakers.
            # Multiple labels explicitly represent a boundary within this window.
            speakers = list(dict.fromkeys(word['speaker'] for word in words if word.get('speaker')))
            if not speakers:
                speakers = list(dict.fromkeys(item['speaker'] for item in assigned['segments'] if item.get('speaker')))
            canonical = {key: value for key, value in segment.items() if key != 'speaker'}
            if speakers:
                canonical['speaker'] = ' / '.join(speakers)
            display.append({**canonical, 'words': words})
        save_json(output / 'transcript.json', native)
        save_json(output / 'display.json', {**source, 'segments': display})
        save_json(output / 'diarization.json', intervals)
        engine.write(native, output)
    save_json(output / 'result.json', {'language': source['language'],
              'warnings': retained, 'durationSeconds': time.monotonic() - started, 'deviceRequested': 'vulkan'})


class WhisperXEngine:
    def __init__(self):
        from whisperx.audio import load_audio
        from whisperx.asr import load_model
        from whisperx.alignment import align, load_align_model
        from whisperx.diarize import DiarizationPipeline, assign_word_speakers
        from whisperx.utils import get_writer
        self.load_audio = load_audio
        self.load_model = load_model
        self.align_function = align
        self.load_align_model = load_align_model
        self.diarization_pipeline = DiarizationPipeline
        self.assign_function = assign_word_speakers
        self.get_writer = get_writer
        self.audio = None

    def transcribe(self, path):
        self.audio = self.load_audio(path)
        model = self.load_model('large-v3', device='vulkan', compute_type='float32',
                                whisper_cpp_url=os.environ.get('WHISPER_CPP_URL', 'http://127.0.0.1:8090'),
                                local_files_only=True)
        return model.transcribe(self.audio, batch_size=8)

    def align(self, result, path):
        if not result['segments']:
            return copy.deepcopy(result)
        if self.audio is None:
            self.audio = self.load_audio(path)
        model, metadata = self.load_align_model(result['language'], device='vulkan', model_cache_only=True)
        try:
            aligned = self.align_function(result['segments'], model, metadata, self.audio, device='vulkan')
            aligned['language'] = result['language']
            return aligned
        finally:
            if hasattr(model, 'close'):
                model.close()

    def diarize(self, path):
        pipeline = self.diarization_pipeline(device='vulkan')
        frame = pipeline(path)
        return frame[['start', 'end', 'speaker']].to_dict(orient='records')

    def assign(self, intervals, result):
        import pandas as pd
        return self.assign_function(pd.DataFrame(intervals), result)

    def write(self, result, directory):
        options = {'max_line_width': None, 'max_line_count': None, 'highlight_words': False}
        for format_name in ('txt', 'srt', 'vtt'):
            self.get_writer(format_name, str(directory))(result, 'transcript.wav', options)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('command', choices=['transcribe', 'realign'])
    parser.add_argument('--audio', required=True)
    parser.add_argument('--output-dir', required=True)
    parser.add_argument('--segments')
    parser.add_argument('--diarization')
    args = parser.parse_args()
    if args.command == 'transcribe':
        transcribe(args.audio, args.output_dir, WhisperXEngine())
    else:
        if not args.segments or not args.diarization:
            parser.error('realign requires --segments and --diarization')
        realign(args.audio, args.segments, args.diarization, args.output_dir, WhisperXEngine())


if __name__ == '__main__':
    main()
