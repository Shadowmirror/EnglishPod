import functools
import http.client
import importlib.util
from pathlib import Path
import tempfile
import threading
import unittest
from http.server import ThreadingHTTPServer

spec = importlib.util.spec_from_file_location("player_serve", Path(__file__).parents[1] / "serve.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class RangeServerTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.data = bytes(range(256)) * 16
        Path(self.directory.name, "sample.mp3").write_bytes(self.data)
        handler = functools.partial(module.PlayerHandler, directory=self.directory.name)
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.directory.cleanup()

    def request(self, byte_range=None, method="GET"):
        conn = http.client.HTTPConnection(*self.server.server_address)
        conn.request(method, "/sample.mp3", headers={"Range": byte_range} if byte_range else {})
        response = conn.getresponse()
        result = response.status, dict(response.getheaders()), response.read()
        conn.close()
        return result

    def test_full_file(self):
        status, headers, body = self.request()
        self.assertEqual(status, 200)
        self.assertEqual(headers["Accept-Ranges"], "bytes")
        self.assertEqual(body, self.data)

    def test_ranges_and_head(self):
        for value, start, end in [("bytes=100-199", 100, 199), ("bytes=4000-", 4000, 4095), ("bytes=-100", 3996, 4095), ("bytes=4000-9999", 4000, 4095)]:
            with self.subTest(value=value):
                status, headers, body = self.request(value)
                self.assertEqual(status, 206)
                self.assertEqual(headers["Content-Range"], f"bytes {start}-{end}/4096")
                self.assertEqual(body, self.data[start:end+1])
        status, headers, body = self.request("bytes=100-199", "HEAD")
        self.assertEqual(status, 206)
        self.assertEqual(headers["Content-Length"], "100")
        self.assertEqual(body, b"")

    def test_unsatisfiable_range(self):
        for value in ["bytes=4096-", "bytes=200-100", "bytes=-0"]:
            status, headers, _ = self.request(value)
            self.assertEqual(status, 416)
            self.assertEqual(headers["Content-Range"], "bytes */4096")

    def test_unsupported_range_falls_back_to_full_file(self):
        for value in ["invalid", "bytes=0-1,4-5"]:
            status, _, body = self.request(value)
            self.assertEqual(status, 200)
            self.assertEqual(body, self.data)
