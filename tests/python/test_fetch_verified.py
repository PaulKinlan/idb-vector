"""Offline ordering tests for tools/fetch_verified.py (idb-vector-pgs7). Stdlib only, no network.

tools/prepare-real-vectors.py imports numpy and h5py, so the script itself cannot load in a bare
python3; the download-and-verify step it now calls can, and that step is where the ordering lives:
bytes are hashed while they are still `<path>.partial` and the rename onto the trusted cache path
happens only after they match. A pre-existing file at that path is verified, never trusted.
"""
import hashlib
import io
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'tools'))
from fetch_verified import ensure_verified, fetch_verified  # noqa: E402

GOOD = b'glove-25-angular stand-in vectors\n'
GOOD_SHA256 = hashlib.sha256(GOOD).hexdigest()
CDN_ERROR_PAGE = b'<html>503 backend unavailable</html>\n'
CDN_ERROR_SHA256 = hashlib.sha256(CDN_ERROR_PAGE).hexdigest()
TRUNCATED = b'\x89HDF\r\n'
TRUNCATED_SHA256 = hashlib.sha256(TRUNCATED).hexdigest()
URL = 'https://example.invalid/glove-25-angular.hdf5'


class FakeDownloader:
    """Stands in for urllib.request.urlopen: serves `body`, records every URL it was asked for."""

    def __init__(self, body):
        self.body = body
        self.urls = []

    def __call__(self, url):
        self.urls.append(url)
        return io.BytesIO(self.body)


class FetchVerifiedTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.path = Path(self._tmp.name) / 'glove-25-angular.hdf5'
        self.partial = Path(str(self.path) + '.partial')

    def test_a_mismatched_payload_raises_naming_both_digests_and_leaves_the_cache_path_absent(self):
        downloader = FakeDownloader(CDN_ERROR_PAGE)
        with self.assertRaises(ValueError) as caught:
            fetch_verified(URL, self.path, GOOD_SHA256, downloader)
        message = str(caught.exception)
        self.assertIn(str(self.path), message, 'the error must name the cache file a human has to check')
        self.assertIn(CDN_ERROR_SHA256, message, 'the error must name the digest actually downloaded')
        self.assertIn(GOOD_SHA256, message, 'the error must name the expected digest')
        self.assertEqual(downloader.urls, [URL])
        self.assertFalse(self.path.exists(), 'bad bytes must never reach the trusted cache path')
        self.assertFalse(self.partial.exists(), 'the rejected partial download is removed')
        # The cache path being absent is what makes the next run retry instead of re-failing.
        self.assertEqual(ensure_verified(URL, self.path, GOOD_SHA256, FakeDownloader(GOOD)), self.path)
        self.assertEqual(self.path.read_bytes(), GOOD)

    def test_b_a_matching_payload_is_installed_at_the_cache_path(self):
        returned = fetch_verified(URL, self.path, GOOD_SHA256, FakeDownloader(GOOD))
        self.assertEqual(returned, self.path)
        self.assertEqual(self.path.read_bytes(), GOOD)
        self.assertEqual(hashlib.sha256(self.path.read_bytes()).hexdigest(), GOOD_SHA256)
        self.assertFalse(self.partial.exists(), 'the partial download is renamed, not left behind')

    def test_absent_cache_path_is_downloaded_and_installed_from_verified_bytes(self):
        downloader = FakeDownloader(GOOD)
        self.assertEqual(ensure_verified(URL, self.path, GOOD_SHA256, downloader), self.path)
        self.assertEqual(downloader.urls, [URL])
        self.assertEqual(self.path.read_bytes(), GOOD)

    def test_c_a_pre_existing_corrupt_file_is_reported_and_preserved_not_trusted(self):
        self.path.write_bytes(TRUNCATED)
        downloader = FakeDownloader(GOOD)
        with self.assertRaises(ValueError) as caught:
            ensure_verified(URL, self.path, GOOD_SHA256, downloader)
        message = str(caught.exception)
        self.assertIn(str(self.path), message, 'the error must name the cache file a human has to remove')
        self.assertIn(TRUNCATED_SHA256, message, 'the error must name the digest found on disk')
        self.assertIn(GOOD_SHA256, message, 'the error must name the expected digest')
        self.assertIn(f'rm {self.path}', message, 'the error must carry the remedy')
        self.assertEqual(downloader.urls, [], 'a corrupt cache is reported, never silently re-downloaded over')
        self.assertEqual(self.path.read_bytes(), TRUNCATED, 'the file is left for inspection, not deleted')

    def test_a_pre_existing_verified_file_is_reused_without_downloading(self):
        self.path.write_bytes(GOOD)
        downloader = FakeDownloader(CDN_ERROR_PAGE)
        self.assertEqual(ensure_verified(URL, self.path, GOOD_SHA256, downloader), self.path)
        self.assertEqual(downloader.urls, [], 'a matching cache file must not be re-fetched')
        self.assertEqual(self.path.read_bytes(), GOOD)


if __name__ == '__main__':
    # unittest reports to stderr; write the per-case lines to stdout for tests/unit/fetch-verified.test.mjs.
    result = unittest.TextTestRunner(verbosity=2, stream=sys.stdout).run(
        unittest.defaultTestLoader.loadTestsFromModule(sys.modules[__name__]))
    sys.exit(0 if result.wasSuccessful() else 1)
