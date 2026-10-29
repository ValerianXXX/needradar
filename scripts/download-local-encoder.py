"""Explicit download of pinned public model assets; never called by inference."""
import argparse
import hashlib
import json
import pathlib
import urllib.request


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--directory', required=True)
    parser.add_argument('--download', action='store_true')
    args = parser.parse_args()
    if not args.download:
        parser.error('--download is required for network access')
    spec = json.loads((pathlib.Path(__file__).resolve().parents[1] / 'config' / 'local-encoder.json').read_text(encoding='utf-8'))
    directory = pathlib.Path(args.directory).resolve()
    directory.mkdir(parents=True, exist_ok=True)
    for name, expected in spec['files'].items():
        path = directory / name
        if not path.exists():
            url = f"https://huggingface.co/{spec['model']}/resolve/{spec['revision']}/{expected['path']}"
            with urllib.request.urlopen(url, timeout=60) as response, path.open('xb') as output:
                copied = 0
                while chunk := response.read(1024 * 1024):
                    copied += len(chunk)
                    if copied > expected['bytes']:
                        raise ValueError('ASSET_SIZE_MISMATCH')
                    output.write(chunk)
        if path.stat().st_size != expected['bytes'] or hashlib.sha256(path.read_bytes()).hexdigest() != expected['sha256']:
            raise ValueError('ASSET_HASH_MISMATCH: preserve the file for inspection; inference will reject it')
        print(json.dumps({'asset': name, 'bytes': expected['bytes'], 'sha256': expected['sha256'], 'verified': True}), flush=True)


if __name__ == '__main__':
    main()
