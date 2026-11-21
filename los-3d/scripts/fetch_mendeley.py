#!/usr/bin/env python3
"""
Download the public Mendeley Data package (doi:10.17632/4ghf42bs96) and print the folder that holds the
four *_Blocks_Final.csv files. Used by the GitHub Actions workflow that builds the map data.

    python fetch_mendeley.py --dataset 4ghf42bs96 --out .mendeley
"""
import argparse, io, json, os, sys, zipfile
import urllib.request

NEEDED = ['Chicago_Blocks_Final.csv', 'Houston_Blocks_Final.csv', 'LosAngeles_Blocks_Final.csv', 'NYC_Blocks_Final.csv']
UA = {'User-Agent': 'Mozilla/5.0 (los-3d data build; github.com/Omid-Mansourihanis)'}


def get(url, binary=True):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=300) as r:
        data = r.read()
    return data if binary else data.decode('utf-8', 'replace')


def extract_all(blob, dest):
    """Unzip, including zips nested inside the package."""
    with zipfile.ZipFile(io.BytesIO(blob)) as z:
        for name in z.namelist():
            if name.endswith('/'):
                continue
            data = z.read(name)
            if name.lower().endswith('.zip'):
                extract_all(data, os.path.join(dest, os.path.splitext(os.path.basename(name))[0]))
                continue
            path = os.path.join(dest, name)
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, 'wb') as fh:
                fh.write(data)


def find_dir(root):
    hits = {}
    for d, _, files in os.walk(root):
        for f in files:
            if f in NEEDED:
                hits[f] = d
    return hits


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--dataset', default='4ghf42bs96')
    ap.add_argument('--out', default='.mendeley')
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)

    # 1) dataset metadata: latest version and per-file download links
    version, files = None, []
    try:
        meta = json.loads(get(f'https://data.mendeley.com/public-api/datasets/{a.dataset}', binary=False))
        version = meta.get('version')
        files = meta.get('files') or []
        print(f'metadata: version {version}, {len(files)} files')
    except Exception as e:  # noqa: BLE001
        print('metadata request failed:', e)

    # 2) whole-package zip (latest version first)
    tried = []
    for v in ([version] if version else []) + list(range(10, 0, -1)):
        if v in tried:
            continue
        tried.append(v)
        url = f'https://data.mendeley.com/public-api/zip/{a.dataset}/download/{v}'
        try:
            blob = get(url)
            if blob[:2] != b'PK':
                continue
            print(f'downloaded package version {v} ({len(blob) / 1e6:.1f} MB)')
            extract_all(blob, a.out)
            break
        except Exception as e:  # noqa: BLE001
            print(f'  {url}: {e}')

    # 3) fall back to single files from the metadata
    hits = find_dir(a.out)
    if len(hits) < len(NEEDED):
        for f in files:
            name = f.get('filename') or f.get('name') or ''
            url = (f.get('content_details') or {}).get('download_url') or f.get('download_url')
            if not url:
                continue
            if name in NEEDED or name.lower().endswith('.zip'):
                try:
                    blob = get(url)
                    if name.lower().endswith('.zip'):
                        extract_all(blob, os.path.join(a.out, os.path.splitext(name)[0]))
                    else:
                        with open(os.path.join(a.out, name), 'wb') as fh:
                            fh.write(blob)
                    print('  got', name)
                except Exception as e:  # noqa: BLE001
                    print('  failed', name, e)
        hits = find_dir(a.out)

    missing = [f for f in NEEDED if f not in hits]
    if missing:
        print('MISSING:', missing)
        for d, _, fs in os.walk(a.out):
            for f in fs[:50]:
                print('   ', os.path.join(d, f))
        return 1
    dirs = set(hits.values())
    if len(dirs) != 1:
        print('CSV files are in different folders:', hits)
        return 1
    d = dirs.pop()
    print('CSV folder:', d)
    gh = os.environ.get('GITHUB_OUTPUT')
    if gh:
        with open(gh, 'a') as fh:
            fh.write(f'csv_dir={d}\n')
    return 0


if __name__ == '__main__':
    sys.exit(main())
