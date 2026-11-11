"""Real HTTP/HTTPS tests; set MITMDUMP to a compatible engine executable.

No external Python packages are required. The test creates its own CA, origin
servers, private storage, authenticated control listener and engine process.
"""
import concurrent.futures
import contextlib
import gzip
import http.client
import http.server
import json
import os
import queue
import shutil
import socket
import ssl
import subprocess
import tempfile
import threading
import time
import unittest
import uuid
from pathlib import Path


class Control:
    def __init__(self):
        self.server = socket.socket()
        self.server.bind(("127.0.0.1", 0))
        self.server.listen(4)
        self.port = self.server.getsockname()[1]
        self.token = uuid.uuid4().hex
        self.connected = threading.Event()
        self.events = queue.Queue()
        self.pending = {}
        self.lock = threading.Lock()
        self.client = None
        self.closed = False
        self.thread = threading.Thread(target=self._read, daemon=True)
        self.thread.start()

    def _read(self):
        while not self.closed:
            try:
                client, _ = self.server.accept()
            except OSError:
                return
            self.client = client
            with client, client.makefile("rb") as reader:
                try:
                    hello = json.loads(reader.readline())
                    if hello.get("token") != self.token or hello.get("protocolVersion") != 1:
                        continue
                    self.connected.set()
                    for line in reader:
                        message = json.loads(line)
                        if "id" in message:
                            target = self.pending.get(message["id"])
                            if target:
                                target.put(message)
                        else:
                            self.events.put(message)
                except (OSError, ValueError):
                    pass
                finally:
                    self.connected.clear()

    def rpc(self, method, params=None, timeout=15):
        if not self.connected.wait(timeout):
            raise TimeoutError("Control handshake not received")
        request_id = uuid.uuid4().hex
        result = queue.Queue()
        self.pending[request_id] = result
        try:
            payload = json.dumps({"id": request_id, "method": method, "params": params or {}}).encode() + b"\n"
            with self.lock:
                self.client.sendall(payload)
            message = result.get(timeout=timeout)
            if "error" in message:
                raise ValueError(message["error"]["message"])
            return message["result"]
        finally:
            self.pending.pop(request_id, None)

    def event(self, name, timeout=15):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            message = self.events.get(timeout=max(0.01, deadline - time.monotonic()))
            if message.get("event") == name:
                return message["data"]
        raise TimeoutError("Missing event: " + name)

    def drop(self):
        self.connected.clear()
        self.client.shutdown(socket.SHUT_RDWR)
        self.client.close()

    def close(self):
        self.closed = True
        if self.client:
            with contextlib.suppress(OSError):
                self.client.shutdown(socket.SHUT_RDWR)
                self.client.close()
        self.server.close()


class Origin(http.server.BaseHTTPRequestHandler):
    calls = []

    def do_GET(self):
        self._respond()

    def do_POST(self):
        self._respond()

    def _respond(self):
        body = self.rfile.read(int(self.headers.get("Content-Length", "0")))
        data = {"method": self.command, "path": self.path, "headers": dict(self.headers), "body": body.decode("utf-8", errors="replace")}
        self.calls.append(data)
        content = json.dumps(data).encode()
        kind = "application/json"
        if self.path.startswith("/large"):
            content = b"a" * (2 * 1024 * 1024)
        elif self.path.startswith("/binary"):
            content, kind = bytes(range(256)) * 1000, "application/octet-stream"
        elif self.path.startswith("/stream"):
            content, kind = b"data: one\n\ndata: two\n\n", "text/event-stream"
        if self.path.startswith("/gzip"):
            if self.path.startswith("/gzip-bomb"):
                content = b"a" * (16 * 1024 * 1024)
            content = gzip.compress(content)
        self.send_response(401 if self.path.startswith("/error") else 200)
        self.send_header("Content-Type", kind)
        if self.path.startswith("/gzip"):
            self.send_header("Content-Encoding", "gzip")
        self.send_header("Content-Length", str(len(content)))
        self.end_headers()
        self.wfile.write(content)

    def log_message(self, *args):
        pass


@unittest.skipUnless(os.environ.get("MITMDUMP"), "设置 MITMDUMP 后运行真实 HTTP/HTTPS 集成测试")
class ProxyIntegrationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix="flutter-pilot-integration-")
        cls.folder = Path(cls.temp.name)
        cls.control = Control()
        cls.origin = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Origin)
        threading.Thread(target=cls.origin.serve_forever, daemon=True).start()
        config = cls.folder / "openssl.cnf"
        config.write_text("[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=localhost\n[ext]\nsubjectAltName=DNS:localhost,IP:127.0.0.1\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,digitalSignature,keyCertSign,keyEncipherment\n")
        cls.cert = cls.folder / "origin.pem"
        cls.key = cls.folder / "origin.key"
        subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-keyout", str(cls.key), "-out", str(cls.cert), "-config", str(config)], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        cls.tls = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Origin)
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(str(cls.cert), str(cls.key))
        cls.tls.socket = context.wrap_socket(cls.tls.socket, server_side=True)
        threading.Thread(target=cls.tls.serve_forever, daemon=True).start()
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            cls.port = sock.getsockname()[1]
        env = dict(os.environ, FLUTTER_PILOT_CONTROL_PORT=str(cls.control.port), FLUTTER_PILOT_CONTROL_TOKEN=cls.control.token, FLUTTER_PILOT_STORAGE=str(cls.folder / "storage"), FLUTTER_PILOT_SETTINGS=json.dumps({"maxBodyBytes": 1024 * 1024}), FLUTTER_PILOT_START_PAUSED="1")
        addon = Path(__file__).resolve().parents[2] / "proxy" / "addon.py"
        cls.log = (cls.folder / "engine.log").open("w+")
        cls.process = subprocess.Popen([os.environ["MITMDUMP"], "-s", str(addon), "--listen-host", "127.0.0.1", "--listen-port", str(cls.port), "--set", "confdir=" + str(cls.folder / "ca"), "--set", "connection_strategy=lazy", "--set", "server=false", "--set", "http2=false", "--set", "termlog_verbosity=error", "--set", "flow_detail=0", "--set", "ssl_verify_upstream_trusted_ca=" + str(cls.cert)], env=env, stdout=cls.log, stderr=subprocess.STDOUT)
        if not cls.control.connected.wait(60):
            cls.log.flush()
            cls.log.seek(0)
            diagnostic = cls.log.read()
            cls.process.terminate()
            raise RuntimeError("Engine did not authenticate: " + diagnostic)
        health = cls.control.rpc("health")
        if not health["ready"] or health["proxyActive"] or health["interactive"]:
            raise AssertionError("Engine must start ready but paused and non-interactive")
        health = cls.control.rpc("proxy.start")
        if not health["proxyActive"]:
            raise AssertionError("Proxy listener did not start")
        cls.ca_path = health["caCertPath"]

    @classmethod
    def tearDownClass(cls):
        cls.control.close()
        cls.process.terminate()
        try:
            cls.process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            cls.process.kill()
            cls.process.wait(timeout=5)
        cls.origin.shutdown()
        cls.tls.shutdown()
        cls.origin.server_close()
        cls.tls.server_close()
        cls.log.close()
        cls.temp.cleanup()

    def setUp(self):
        self.control.rpc("breakpoint.releaseAll")
        self.control.rpc("breakpoint.setInteractive", {"enabled": True})
        self.control.rpc("api.clear")
        self.sync([])
        self.control.rpc("history.clear")
        Origin.calls.clear()
        while not self.control.events.empty():
            self.control.events.get_nowait()

    def sync(self, rules):
        return self.control.rpc("rules.sync", {"version": 1, "rules": rules, "revision": 42})

    def rule(self, **kwargs):
        return dict({"id": uuid.uuid4().hex, "name": "集成测试", "enabled": True, "priority": 0, "match": {"path": "/*"}}, **kwargs)

    def request(self, path="/json", method="GET", body=None, headers=None, tls=False, timeout=25):
        if tls:
            context = ssl.create_default_context(cafile=self.ca_path)
            conn = http.client.HTTPSConnection("127.0.0.1", self.port, context=context, timeout=timeout)
            conn.set_tunnel("localhost", self.tls.server_port)
            target = path
        else:
            conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=timeout)
            target = "http://127.0.0.1:%s%s" % (self.origin.server_port, path)
        try:
            conn.request(method, target, body=body, headers=headers or {})
            response = conn.getresponse()
            return response.status, dict(response.getheaders()), response.read()
        finally:
            conn.close()

    def latest(self):
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            rows = self.control.rpc("history.list")
            if rows["items"]:
                return self.control.rpc("history.get", {"id": rows["items"][0]["id"]})
            time.sleep(0.03)
        raise AssertionError("History not persisted")

    def test_catalog_records_without_mock_and_survives_history_clear(self):
        self.request("/catalog?one=1")
        self.latest()
        self.request("/catalog?two=2")
        deadline = time.monotonic() + 5
        while self.control.rpc("history.list")["total"] < 2 and time.monotonic() < deadline:
            time.sleep(0.02)
        items = self.control.rpc("history.apis")["items"]
        self.assertEqual(len(items), 1)
        item = items[0]
        self.assertEqual((item["method"], item["host"], item["path"], item["count"]), ("GET", "127.0.0.1", "/catalog", 2))
        self.control.rpc("history.clear")
        self.assertEqual(self.control.rpc("history.list")["total"], 0)
        self.assertEqual(self.control.rpc("history.apis")["items"], items)
        self.assertEqual(self.control.rpc("api.delete", {"method": item["method"], "host": item["host"], "path": item["path"]}), {"deleted": 1})
        self.assertEqual(self.control.rpc("history.apis")["items"], [])
        self.request("/catalog?again=1")
        self.latest()
        self.assertEqual(self.control.rpc("history.apis")["items"][0]["count"], 1)

    def test_background_mode_skips_breakpoints_but_keeps_modification_and_recording(self):
        self.control.rpc("breakpoint.setInteractive", {"enabled": False})
        self.sync([self.rule(request={"headers": {"X-Background": "yes"}}, response={"status": 202}, breakpoint={"request": True, "response": True, "timeout": 10})])
        started = time.monotonic()
        status, _, body = self.request("/background")
        self.assertEqual(status, 202)
        self.assertLess(time.monotonic() - started, 5)
        self.assertEqual(json.loads(body)["headers"]["X-Background"], "yes")
        self.latest()
        self.assertEqual(self.control.rpc("health")["pendingBreakpoints"], 0)
        self.assertEqual(self.control.rpc("history.apis")["items"][0]["path"], "/background")

    def test_closing_workbench_releases_existing_and_skips_following_breakpoints(self):
        self.sync([self.rule(mock={"status": 200, "headers": {}, "body": "auto"}, breakpoint={"request": True, "response": True, "timeout": 60})])
        with concurrent.futures.ThreadPoolExecutor() as pool:
            future = pool.submit(self.request, "/pending")
            self.control.event("breakpoint")
            result = self.control.rpc("breakpoint.setInteractive", {"enabled": False})
            self.assertEqual(result, {"enabled": False, "released": 1})
            self.assertEqual(future.result(timeout=5)[2], b"auto")
        self.assertTrue(self.control.rpc("health")["proxyActive"])
        self.assertEqual(self.request("/after-close", timeout=5)[2], b"auto")
        self.assertEqual(self.control.rpc("health")["pendingBreakpoints"], 0)

    def test_http_bidirectional_modification_and_original_snapshots(self):
        self.sync([self.rule(request={"method": "POST", "headers": {"X-Test": "modified"}, "query": {"page": "2"}, "body": '{"edited":true}'}, response={"status": 201, "headers": {"X-Mock": "yes"}, "body": '{"result":"mocked"}'})])
        status, headers, body = self.request("/json?page=1", headers={"Content-Type": "application/json"})
        self.assertEqual((status, body), (201, b'{"result":"mocked"}'))
        self.assertEqual(headers["X-Mock"], "yes")
        call = Origin.calls[-1]
        self.assertEqual(call["method"], "POST")
        self.assertEqual(call["path"], "/json?page=2")
        self.assertEqual(call["body"], '{"edited":true}')
        entry = self.latest()
        self.assertEqual(entry["originalRequest"]["method"], "GET")
        self.assertEqual(entry["request"]["method"], "POST")
        self.assertEqual(entry["automaticResponse"]["status"], 201)
        self.assertEqual(entry["originalResponse"]["status"], 200)
        self.assertEqual(self.control.rpc("history.apis")["items"][0]["path"], "/json")
        self.assertNotIn("originalRequest", self.control.rpc("history.list")["items"][0])

    def test_https_decryption_with_trusted_ca(self):
        self.sync([self.rule(response={"headers": {"X-TLS-Modified": "true"}, "body": '{"secure":true}'})])
        status, headers, body = self.request(tls=True)
        self.assertEqual(status, 200)
        self.assertEqual(body, b'{"secure":true}')
        self.assertEqual(headers["X-TLS-Modified"], "true")
        self.assertTrue(self.latest()["url"].startswith("https://"))

    def test_mock_does_not_touch_upstream_and_response_rules_still_apply(self):
        self.sync([self.rule(mock={"status": 401, "headers": {"Content-Type": "application/json"}, "body": '{"mock":true}'}, response={"status": 200, "headers": {"X-Response": "modified"}})])
        status, headers, body = self.request()
        self.assertEqual((status, body), (200, b'{"mock":true}'))
        self.assertEqual(headers["X-Response"], "modified")
        self.assertEqual(Origin.calls, [])
        self.assertTrue(self.latest()["mocked"])

    def test_redirect_preserves_credentials_and_matches_original_path(self):
        target = "http://localhost:%s/redirected?target=1" % self.origin.server_port
        rule = self.rule(match={"path": "/original"}, redirect={"url": target}, response={"status": 202})
        self.sync([rule])
        headers = {"Authorization": "Bearer original", "Cookie": "sid=original", "Proxy-Authorization": "Bearer proxy", "X-Private-Token": "private", "Content-Type": "application/json"}
        status, _, body = self.request("/original?old=1", method="POST", body=b'{"private":true}', headers=headers)
        self.assertEqual(status, 202)
        call = json.loads(body)
        self.assertEqual(call["path"], "/redirected?target=1")
        self.assertEqual(call["method"], "POST")
        self.assertEqual(call["body"], '{"private":true}')
        for key, value in headers.items():
            self.assertEqual(call["headers"][key], value)
        self.assertEqual(call["headers"]["Host"], "localhost:%s" % self.origin.server_port)
        self.assertEqual(len(Origin.calls), 1)
        self.assertEqual(self.latest()["targetUrl"], target)
        self.assertFalse(self.latest()["mocked"])

    def test_redirect_path_preserves_private_request_and_raw_query(self):
        headers = {"Authorization": "Bearer original", "Cookie": "sid=original", "X-Private-Token": "private", "Content-Type": "application/json"}
        for target, expected in (("/private/new%2Fpart", "/private/new%2Fpart?a=1&a=2&token=x%2Fy+z"), ("/private/new?b=%2F&b=2", "/private/new?b=%2F&b=2"), ("/private/new?", "/private/new")):
            with self.subTest(target=target):
                self.sync([self.rule(redirect={"url": target})])
                status, _, body = self.request("/original?a=1&a=2&token=x%2Fy+z", method="POST", body=b'{"private":true}', headers=headers)
                call = json.loads(body)
                self.assertEqual(status, 200)
                self.assertEqual(call["path"].rstrip("?"), expected)
                self.assertEqual(call["method"], "POST")
                self.assertEqual(call["body"], '{"private":true}')
                for key, value in headers.items():
                    self.assertEqual(call["headers"][key], value)
                self.assertEqual(call["headers"]["Host"], "127.0.0.1:%s" % self.origin.server_port)
                self.assertFalse(self.latest()["mocked"])

    def test_request_url_still_strips_cross_origin_credentials(self):
        self.sync([self.rule(request={"url": "http://localhost:%s/target" % self.origin.server_port})])
        _, _, body = self.request(headers={"Authorization": "Bearer original", "Cookie": "sid=original"})
        call = json.loads(body)
        self.assertNotIn("Authorization", call["headers"])
        self.assertNotIn("Cookie", call["headers"])

    def test_error_response_can_be_changed_to_success(self):
        self.sync([self.rule(response={"status": 200, "body": '{"recovered":true}'})])
        status, _, body = self.request("/error")
        self.assertEqual((status, body), (200, b'{"recovered":true}'))
        self.assertEqual(self.latest()["originalResponse"]["status"], 401)

    def test_manual_request_and_response_edits_run_after_automatic_rules(self):
        self.sync([self.rule(request={"headers": {"X-Edit": "automatic"}}, response={"body": "automatic"}, breakpoint={"request": True, "response": True, "timeout": 10})])
        with concurrent.futures.ThreadPoolExecutor() as pool:
            future = pool.submit(self.request)
            request_bp = self.control.event("breakpoint")
            self.assertEqual(request_bp["stage"], "request")
            self.control.rpc("breakpoint.resolve", {"id": request_bp["id"], "action": "resume", "patch": {"headers": {"X-Edit": "manual"}}})
            response_bp = self.control.event("breakpoint")
            self.assertEqual(response_bp["current"]["body"], "automatic")
            self.control.rpc("breakpoint.resolve", {"id": response_bp["id"], "action": "resume", "patch": {"body": "manual"}})
            self.assertEqual(future.result()[2], b"manual")
        self.assertEqual(Origin.calls[-1]["headers"]["X-Edit"], "manual")
        entry = self.latest()
        self.assertEqual(entry["automaticResponse"]["body"], "automatic")
        self.assertEqual(entry["response"]["body"], "manual")

    def test_breakpoint_timeout_releases_current_automatic_result(self):
        self.sync([self.rule(mock={"status": 200, "headers": {}, "body": "automatic"}, breakpoint={"response": True, "timeout": 10})])
        started = time.monotonic()
        status, _, body = self.request(timeout=20)
        self.assertEqual((status, body), (200, b"automatic"))
        self.assertGreaterEqual(time.monotonic() - started, 9)
        self.assertEqual(self.control.event("breakpoint.resolved")["reason"], "timeout")

    def test_disconnect_releases_waiting_breakpoint_and_reconnects(self):
        self.sync([self.rule(mock={"status": 200, "headers": {}, "body": "released"}, breakpoint={"request": True, "timeout": 60})])
        with concurrent.futures.ThreadPoolExecutor() as pool:
            future = pool.submit(self.request)
            self.control.event("breakpoint")
            self.control.drop()
            self.assertEqual(future.result(timeout=10)[2], b"released")
        health = self.control.rpc("health")
        self.assertTrue(health["ready"])
        self.assertFalse(health["interactive"])
        self.assertEqual(self.request("/after-reconnect", timeout=5)[2], b"released")

    def test_large_binary_and_sse_bodies_are_forwarded_without_editing(self):
        self.sync([self.rule(response={"body": "MUST NOT REPLACE"})])
        for path, expected in (("/large", b"a" * (2 * 1024 * 1024)), ("/binary", bytes(range(256)) * 1000), ("/stream", b"data: one\n\ndata: two\n\n")):
            with self.subTest(path=path):
                self.control.rpc("history.clear")
                self.assertEqual(self.request(path)[2], expected)
                entry = self.latest()
                self.assertFalse(entry["response"]["editable"])
                if path == "/large":
                    self.assertTrue(entry["response"]["truncated"])
                    self.assertLessEqual(len(entry["response"]["body"]), 1024 * 1024)

    def test_proxy_pause_keeps_history_available_and_restart_reopens_listener(self):
        self.request()
        self.latest()
        stopped = self.control.rpc("proxy.stop")
        self.assertFalse(stopped["proxyActive"])
        self.assertEqual(self.control.rpc("history.list")["total"], 1)
        with socket.socket() as sock:
            self.assertNotEqual(sock.connect_ex(("127.0.0.1", self.port)), 0)
        self.assertTrue(self.control.rpc("proxy.start")["proxyActive"])
        self.assertEqual(self.request()[0], 200)

    def test_invalid_sync_does_not_replace_active_rules(self):
        self.sync([self.rule(mock={"status": 200, "headers": {}, "body": "valid"})])
        with self.assertRaises(ValueError):
            self.sync([self.rule(response={"status": 999})])
        self.assertEqual(self.request()[2], b"valid")

    def test_concurrent_breakpoints_can_be_released_individually(self):
        self.sync([self.rule(mock={"status": 200, "headers": {}, "body": "auto"}, breakpoint={"response": True, "timeout": 10})])
        with concurrent.futures.ThreadPoolExecutor() as pool:
            futures = [pool.submit(self.request, "/one"), pool.submit(self.request, "/two")]
            breakpoints = [self.control.event("breakpoint"), self.control.event("breakpoint")]
            self.assertEqual(self.control.rpc("health")["pendingBreakpoints"], 2)
            for index, bp in enumerate(breakpoints):
                self.control.rpc("breakpoint.resolve", {"id": bp["id"], "action": "resume", "patch": {"body": "manual-%s" % index}})
            self.assertEqual({future.result()[2] for future in futures}, {b"manual-0", b"manual-1"})

    def test_abort_breakpoint_prevents_upstream_and_invalidates_queue_item(self):
        self.sync([self.rule(breakpoint={"request": True, "timeout": 10})])
        with concurrent.futures.ThreadPoolExecutor() as pool:
            future = pool.submit(self.request)
            bp = self.control.event("breakpoint")
            self.control.rpc("breakpoint.resolve", {"id": bp["id"], "action": "abort"})
            with self.assertRaises((http.client.RemoteDisconnected, ConnectionResetError)):
                future.result()
        self.assertEqual(Origin.calls, [])
        with self.assertRaises(ValueError):
            self.control.rpc("breakpoint.resolve", {"id": bp["id"], "action": "resume"})

    def test_multipart_upload_body_is_preserved(self):
        self.sync([self.rule(request={"body": "MUST NOT REPLACE", "headers": {"X-Upload": "yes"}})])
        body = "--boundary\r\nContent-Disposition: form-data; name=\"file\"; filename=\"test.txt\"\r\n\r\nhello\r\n--boundary--\r\n"
        status, _, response = self.request(method="POST", body=body, headers={"Content-Type": "multipart/form-data; boundary=boundary"})
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(response)["body"], body)
        entry = self.latest()
        self.assertFalse(entry["request"]["editable"])

    def test_client_cancel_invalidates_waiting_breakpoint(self):
        self.sync([self.rule(breakpoint={"request": True, "timeout": 10})])
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=15)
        conn.request("GET", "http://127.0.0.1:%s/cancel" % self.origin.server_port)
        bp = self.control.event("breakpoint")
        conn.close()
        resolved = self.control.event("breakpoint.resolved", timeout=5)
        self.assertEqual(resolved["id"], bp["id"])
        self.assertEqual(resolved["reason"], "client-cancelled")
        with self.assertRaises(ValueError):
            self.control.rpc("breakpoint.resolve", {"id": bp["id"], "action": "resume"})

    def test_gzip_json_can_be_edited_and_compressed_bomb_is_bounded(self):
        self.sync([self.rule(response={"body": '{"结果":"修改成功"}'})])
        status, headers, body = self.request("/gzip")
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body), {"结果": "修改成功"})
        self.assertNotIn("Content-Encoding", headers)
        self.control.rpc("history.clear")
        status, headers, body = self.request("/gzip-bomb")
        self.assertEqual(status, 200)
        self.assertEqual(len(gzip.decompress(body)), 16 * 1024 * 1024)
        entry = self.latest()
        self.assertFalse(entry["response"]["editable"])
        self.assertTrue(entry["response"]["truncated"])
        self.assertEqual(len(entry["response"]["body"]), 1024 * 1024)


if __name__ == "__main__":
    unittest.main()
