"""Pinned local ONNX inference: JSON stdin, bounded NDJSON stdout, no downloads.

Run with the separately configured Python -I and an operator-supplied model dir.
Only public identity text belongs here. Never derive paths or arguments from it.
"""
import argparse
import hashlib
import json
import pathlib
import sys
import time


def emit(value):
    print(json.dumps(value, ensure_ascii=True, separators=(',', ':')), flush=True)


def load_spec():
    raw = (pathlib.Path(__file__).resolve().parents[1] / 'config' / 'local-encoder.json').read_text(encoding='utf-8').replace('\r\n', '\n')
    return json.loads(raw), hashlib.sha256(raw.encode()).hexdigest()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--model-dir', required=True)
    parser.add_argument('--threads', type=int, default=2, choices=range(1, 9))
    args = parser.parse_args()
    spec, encoder_id = load_spec()
    raw = sys.stdin.buffer.read(32_000_001)
    if len(raw) > 32_000_000:
        raise ValueError('INPUT_LIMIT')
    request = json.loads(raw)
    rows = request.get('rows')
    if request.get('protocol') != 'NEEDRADAR_EMBED_REQUEST_V1' or request.get('encoderId') != encoder_id \
            or not isinstance(rows, list) or not 1 <= len(rows) <= 10000:
        raise ValueError('REQUEST_CONTRACT')
    seen = set()
    for row in rows:
        text = row.get('text')
        if not isinstance(text, str) or not text.startswith(spec['prefix']) or len(text.encode()) > 16000 \
                or row.get('inputDigest') != hashlib.sha256(text.encode()).hexdigest() or row['inputDigest'] in seen:
            raise ValueError('IDENTITY_INPUT_CONTRACT')
        seen.add(row['inputDigest'])
    directory = pathlib.Path(args.model_dir).resolve(strict=True)
    for name, expected in spec['files'].items():
        path = directory / name
        if path.stat().st_size != expected['bytes'] or hashlib.sha256(path.read_bytes()).hexdigest() != expected['sha256']:
            raise ValueError('MODEL_ASSET_MISMATCH')
    started = time.perf_counter()
    import numpy as np
    import onnxruntime as ort
    from tokenizers import Tokenizer
    ort.disable_telemetry_events()
    options = ort.SessionOptions()
    options.intra_op_num_threads = args.threads
    options.inter_op_num_threads = 1
    options.log_severity_level = 3
    session = ort.InferenceSession(str(directory / 'model_qint8_avx512_vnni.onnx'), sess_options=options,
                                   providers=['CPUExecutionProvider'])
    tokenizer = Tokenizer.from_file(str(directory / 'tokenizer.json'))
    tokenizer.no_truncation()
    tokenizer.no_padding()
    emit({'type': 'READY', 'encoderId': encoder_id, 'provider': session.get_providers(),
          'runtime': {'python': sys.version.split()[0], 'onnxruntime': ort.__version__, 'numpy': np.__version__},
          'startupMs': round((time.perf_counter() - started) * 1000, 3)})
    for offset in range(0, len(rows), 16):
        batch = rows[offset:offset + 16]
        before = time.perf_counter()
        encoded = tokenizer.encode_batch([row['text'] for row in batch])
        lengths = [len(item.ids) for item in encoded]
        if any(length > spec['maxTokens'] or length < 1 for length in lengths):
            raise ValueError('ENCODER_TOKEN_LIMIT')  # No silent loss of the tail.
        width = max(lengths)
        ids = np.full((len(batch), width), 1, dtype=np.int64)
        masks = np.zeros_like(ids)
        types = np.zeros_like(ids)
        for index, item in enumerate(encoded):
            ids[index, :lengths[index]] = item.ids
            masks[index, :lengths[index]] = item.attention_mask
            types[index, :lengths[index]] = item.type_ids
        outputs = session.run(['last_hidden_state'], {'input_ids': ids, 'attention_mask': masks, 'token_type_ids': types})[0]
        pooled = (outputs * masks[:, :, None]).sum(axis=1) / masks.sum(axis=1)[:, None]
        norms = np.linalg.norm(pooled, axis=1, keepdims=True)
        if outputs.shape[-1] != spec['dimensions'] or not np.isfinite(pooled).all() or (norms <= 0).any():
            raise ValueError('INVALID_EMBEDDING')
        vectors = (pooled / norms).astype(np.float32)
        emit({'type': 'BATCH', 'encoderId': encoder_id, 'elapsedMs': round((time.perf_counter() - before) * 1000, 3),
              'rows': [{'inputDigest': row['inputDigest'], 'tokens': length, 'vector': vector.tolist()}
                       for row, length, vector in zip(batch, lengths, vectors)]})
    emit({'type': 'DONE', 'encoderId': encoder_id, 'encoded': len(rows), 'cloudRequests': 0,
          'elapsedMs': round((time.perf_counter() - started) * 1000, 3)})


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        # Never echo source text, paths, account details or provider exceptions.
        allowed = {'INPUT_LIMIT', 'REQUEST_CONTRACT', 'IDENTITY_INPUT_CONTRACT', 'MODEL_ASSET_MISMATCH',
                   'ENCODER_TOKEN_LIMIT', 'INVALID_EMBEDDING'}
        code = str(error) if isinstance(error, ValueError) and str(error) in allowed else 'LOCAL_ENCODER_FAILED'
        emit({'type': 'ERROR', 'code': code})
        sys.exit(1)
