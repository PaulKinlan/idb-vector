"""Install a download at a trusted cache path only after its SHA-256 matches.

Split out of tools/prepare-real-vectors.py (idb-vector-pgs7) so the ordering can be tested with a
fake downloader and no numpy/h5py, and so one rule covers both corpora: bytes reach a trusted path
only after they have been verified, and a file already at a trusted path is verified before use.

A digest mismatch never deletes or overwrites a file at the trusted path: the caller is told which
path and which two digests disagree, and the human decides whether to keep the bytes.
"""
import hashlib
from pathlib import Path
import urllib.request

CHUNK = 1024 * 1024


def digest(path):
    with open(path, 'rb') as f:
        return hashlib.file_digest(f, 'sha256').hexdigest()


def _open(url):
    req = urllib.request.Request(url, headers={'User-Agent': 'idb-vector benchmark'})
    return urllib.request.urlopen(req, timeout=120)


def fetch_verified(url, path, sha256, open_url=None):
    """Download `url` to `<path>.partial`, verify it, and only then rename it onto `path`.

    A mismatch removes the partial download and leaves `path` absent, so the next run retries
    instead of trusting the bad bytes.
    """
    path = Path(path)
    partial = Path(str(path) + '.partial')
    with (open_url or _open)(url) as response, open(partial, 'wb') as out:
        while chunk := response.read(CHUNK):
            out.write(chunk)
    actual = digest(partial)
    if actual != sha256:
        partial.unlink(missing_ok=True)
        raise ValueError(
            f'{partial}: downloaded {url} has sha256 {actual}, expected {sha256}. '
            f'Partial download removed; {path} was not written, so rerunning retries the fetch.')
    partial.replace(path)
    return path


def require_verified(path, expected, remedy):
    """Return `path` when it hashes to `expected`, else raise naming the path, both digests and `remedy`."""
    actual = digest(path)
    if actual != expected:
        raise ValueError(f'{path}: sha256 {actual}, expected {expected}. {remedy}')
    return path


def ensure_verified(url, path, sha256, open_url=None):
    """Return `path` holding verified bytes: download when absent, verify in place when present."""
    path = Path(path)
    if not path.exists():
        return fetch_verified(url, path, sha256, open_url)
    return require_verified(
        path, sha256,
        f'Cached file left in place (not overwritten or deleted) because its bytes may need inspection: '
        f'remove it (rm {path}) and rerun to download {url} again.')
