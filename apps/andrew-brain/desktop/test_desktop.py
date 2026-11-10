import json
from pathlib import Path
import unittest
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from andrew_brain import APP_ROOT, ReaderProcess, allowed_local_uri


class DesktopBoundaryTests(unittest.TestCase):
    def test_embedded_navigation_requires_the_exact_loopback_origin(self):
        origin = 'http://127.0.0.1:12345'
        for uri in [origin + '/', origin + '/?q=note#section', origin + '/api/notes']:
            self.assertTrue(allowed_local_uri(uri, origin))
        for uri in ['file:///etc/passwd', 'javascript:alert(1)', 'https://example.test',
                    'http://127.0.0.1:12346/', 'http://localhost:12345/',
                    'http://127.0.0.1.example.test:12345/',
                    'http://user:password@127.0.0.1:12345/',
                    'http://127.0.0.1:invalid/']:
            self.assertFalse(allowed_local_uri(uri, origin), uri)

    def test_app_owned_reader_works_without_the_web_service_and_stops(self):
        reader = ReaderProcess(APP_ROOT / 'tests/fixtures/vault', fixture=True)
        try:
            origin = reader.start()
            process = reader.process
            self.assertNotEqual(origin, 'http://127.0.0.1:5191')
            with urlopen(origin + '/api/health', timeout=3) as response:
                health = json.load(response)
            self.assertTrue(health['readOnly'])
            self.assertEqual(health['dataset'], 'fixture')
            self.assertFalse(health['providerConfigured'])
            with urlopen(origin + '/api/notes?limit=50', timeout=3) as response:
                listing = json.load(response)
            self.assertEqual(listing['total'], 35)
            with self.assertRaises(HTTPError) as caught:
                urlopen(Request(origin + '/api/notes', method='POST', data=b'{}'), timeout=3)
            self.assertEqual(caught.exception.code, 405)
            caught.exception.close()
            with self.assertRaisesRegex(RuntimeError, 'already started'):
                reader.start()
        finally:
            reader.stop()
        self.assertIsNotNone(process.poll())
        self.assertEqual(process.returncode, 0)

    def test_parent_pipe_closure_does_not_leave_a_reader_running(self):
        reader = ReaderProcess(APP_ROOT / 'tests/fixtures/vault', fixture=True)
        try:
            reader.start()
            process = reader.process
            process.stdin.close()
            self.assertEqual(process.wait(timeout=4), 0)
        finally:
            reader.stop()


if __name__ == '__main__':
    unittest.main()
