"""Flutter Pilot' mitmproxy addon. Requires only the bundled engine and Python stdlib.

The IDE owns the loopback control listener. This process authenticates to it and
keeps proxy traffic, CA material and history isolated from the public UI channel.
"""
from __future__ import annotations

import asyncio
import base64
import copy
import json
import os
import sys
import time
import uuid
import zlib
from pathlib import Path
from urllib.parse import urlsplit

from mitmproxy import ctx, http

# mitmdump -s does not guarantee that an addon's siblings are importable.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from rules import select_rule, validate_rules, validate_url
from storage import HistoryStore

PROTOCOL_VERSION = 1
MAX_CONTROL_LINE = 64 * 1024 * 1024


def _now():
    return int(time.time() * 1000)


class FlutterPilotAddon:
    def __init__(self):
        self.rules = []
        self.revision = 0
        self.writer = None
        self.control_task = None
        self.pending = {}
        self.entries = {}
        self.ready = False
        self.stopping = False
        self.store = None
        self.settings = {}
        self.max_body = 1024 * 1024
        self.interactive = False

    def load(self, loader):
        raw = json.loads(os.environ.get("FLUTTER_PILOT_SETTINGS", "{}"))
        if not isinstance(raw, dict):
            raise ValueError("FLUTTER_PILOT_SETTINGS must be an object")
        self.settings = {
            "retentionDays": max(1, min(365, int(raw.get("retentionDays", 7)))),
            "maxRecords": max(1, min(100000, int(raw.get("maxRecords", 10000)))),
            "maxBodyBytes": max(1024, min(10 * 1024 * 1024, int(raw.get("maxBodyBytes", 1024 * 1024)))),
            "breakpointTimeout": max(10, min(300, float(raw.get("breakpointTimeout", 60)))),
        }
        self.max_body = self.settings["maxBodyBytes"]
        folder = os.environ.get("FLUTTER_PILOT_STORAGE")
        if not folder or not os.environ.get("FLUTTER_PILOT_CONTROL_TOKEN"):
            raise ValueError("Flutter Pilot requires private storage and control token")
        self.store = HistoryStore(folder, self.settings["retentionDays"], self.settings["maxRecords"])

    async def running(self):
        self.ready = True
        confdir = Path(ctx.options.confdir).expanduser()
        if confdir.exists():
            os.chmod(confdir, 0o700)
            for file in confdir.iterdir():
                if file.is_file():
                    os.chmod(file, 0o600)
        self.control_task = asyncio.create_task(self._control_loop())

    def done(self):
        self.stopping = True
        self._release_all("engine-stopped")
        if self.control_task:
            self.control_task.cancel()
        if self.writer:
            self.writer.close()
        if self.store:
            self.store.close()

    def emit(self, event, data):
        return self._send({"event": event, "data": data})

    def _send(self, value):
        if self.writer is not None and not self.writer.is_closing():
            payload = (json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8", errors="backslashreplace")
            limit = max(MAX_CONTROL_LINE, self.max_body * 10 + 1024 * 1024)
            if len(payload) > limit:
                if "id" in value:
                    payload = (json.dumps({"id": value["id"], "error": {"message": "该记录的 JSON 转义后体积超过控制帧上限，请减小正文保存上限后重新抓取"}}, ensure_ascii=False) + "\n").encode("utf-8")
                else:
                    ctx.log.warn("Flutter Pilot event exceeds the control frame limit")
                    return False
            self.writer.write(payload)
            return True
        return False

    async def _control_loop(self):
        delay = 0.25
        while not self.stopping:
            writer = None
            try:
                reader, writer = await asyncio.open_connection("127.0.0.1", int(os.environ["FLUTTER_PILOT_CONTROL_PORT"]), limit=max(MAX_CONTROL_LINE, self.max_body * 10 + 1024 * 1024))
                self.writer = writer
                self._send({"event": "hello", "protocolVersion": PROTOCOL_VERSION, "token": os.environ["FLUTTER_PILOT_CONTROL_TOKEN"]})
                self.emit("ready", self._health())
                await writer.drain()
                delay = 0.25
                while not self.stopping:
                    line = await reader.readline()
                    if not line:
                        break
                    request_id = None
                    try:
                        request = json.loads(line)
                        if not isinstance(request, dict) or "id" not in request or not isinstance(request.get("method"), str):
                            raise ValueError("Invalid JSON-RPC command")
                        request_id = request["id"]
                        params = request.get("params", {})
                        if not isinstance(params, dict):
                            raise ValueError("params 必须为对象")
                        result = await self._rpc(request["method"], params)
                        self._send({"id": request_id, "result": result})
                    except (ValueError, KeyError, TypeError) as exc:
                        self._send({"id": request_id, "error": {"message": str(exc)}})
                    except Exception as exc:
                        ctx.log.error("Flutter Pilot command error: %s" % exc)
                        self._send({"id": request_id, "error": {"message": str(exc)}})
                    await writer.drain()
            except asyncio.CancelledError:
                break
            except (OSError, ValueError, ConnectionError) as exc:
                ctx.log.debug("Flutter Pilot control reconnect: %s" % exc)
            finally:
                if self.writer is writer:
                    self.writer = None
                self.interactive = False
                self._release_all("control-disconnected")
                if writer:
                    writer.close()
                    try:
                        await writer.wait_closed()
                    except (OSError, ConnectionError):
                        pass
            await asyncio.sleep(delay)
            delay = min(delay * 2, 5)

    def _health(self):
        proxy = ctx.master.addons.get("proxyserver")
        addresses = proxy.listen_addrs() if proxy else []
        return {
            "ready": self.ready,
            "protocolVersion": PROTOCOL_VERSION,
            "proxyActive": bool(ctx.options.server and addresses),
            "proxyPort": addresses[0][1] if addresses else ctx.options.listen_port,
            "caCertPath": str(Path(ctx.options.confdir).expanduser() / "mitmproxy-ca-cert.pem"),
            "pendingBreakpoints": len(self.pending),
            "revision": self.revision,
            "interactive": self.interactive,
        }

    async def _rpc(self, method, params):
        if method == "health":
            return self._health()
        if method == "rules.sync":
            rules = validate_rules(params)
            self.rules = rules
            self.revision = params.get("revision", self.revision + 1)
            return {"revision": self.revision, "count": len(rules)}
        if method == "history.list":
            self.store.prune()
            # Full snapshots are fetched only for the selected row so a history
            # page never creates a multi-hundred-MiB control-channel frame.
            return self.store.list(params, summary=True)
        if method == "history.apis":
            self.store.prune()
            return self.store.apis(params)
        if method == "api.delete":
            result = self.store.delete_api(params.get("method"), params.get("host"), params.get("path"))
            self.emit("api.updated", {})
            return result
        if method == "api.clear":
            result = self.store.clear_apis()
            self.emit("api.updated", {})
            return result
        if method == "history.get":
            return self.store.get(params["id"])
        if method == "history.delete":
            return self.store.delete(params.get("ids", []))
        if method == "history.clear":
            return self.store.clear()
        if method == "history.update":
            current = self.store.get(params["id"])
            return self.store.update(params["id"], params.get("note", current["note"]), params.get("tags", current["tags"]))
        if method == "breakpoint.setInteractive":
            enabled = params.get("enabled")
            if not isinstance(enabled, bool):
                raise ValueError("enabled 必须为布尔值")
            self.interactive = enabled
            released = 0 if enabled else self._release_all("workbench-closed")
            return {"enabled": enabled, "released": released}
        if method == "breakpoint.resolve":
            return self._resolve(params)
        if method == "breakpoint.releaseAll":
            return {"released": self._release_all("workbench-closed")}
        if method in ("proxy.start", "proxy.stop"):
            if method == "proxy.stop":
                self._release_all("proxy-stopped")
            ctx.options.update(server=(method == "proxy.start"))
            proxy = ctx.master.addons.get("proxyserver")
            ok = await proxy.setup_servers()
            if not ok:
                ctx.options.update(server=False)
                await proxy.setup_servers()
                raise ValueError("代理端口无法监听，请重新启动以选择可用端口")
            health = self._health()
            self.emit("status", health)
            return health
        raise ValueError("未知命令: " + method)

    def _body(self, message, flow, stage):
        capture = flow.metadata.get("flutter_pilot.capture." + stage)
        streamed = capture is not None
        decoding_limitation = None
        undecoded = False
        if streamed:
            raw = bytes(capture["prefix"])
            total = capture["total"]
        else:
            # Never call mitmproxy's unbounded content decoder on a response
            # controlled by a server: a tiny gzip body may inflate to gigabytes.
            wire = message.raw_content or b""
            if len(wire) > self.max_body:
                raw = wire[: self.max_body]
                total = len(wire)
                undecoded = bool(message.headers.get("content-encoding"))
            else:
                encoding = message.headers.get("content-encoding", "identity").lower().strip()
                raw = wire
                if encoding in ("gzip", "deflate", "deflateraw") and wire:
                    try:
                        decompressor = zlib.decompressobj(47 if encoding == "gzip" else 15)
                        try:
                            raw = decompressor.decompress(wire, self.max_body + 1)
                        except zlib.error:
                            if encoding == "gzip":
                                raise
                            raw = zlib.decompressobj(-15).decompress(wire, self.max_body + 1)
                        if len(raw) > self.max_body:
                            decoding_limitation = "解压后的正文超过保存上限，保持直通（大小为下界）"
                    except zlib.error:
                        raw = wire
                        undecoded = True
                        decoding_limitation = "压缩正文无法解码，保持直通"
                elif encoding not in ("identity", "none", ""):
                    undecoded = True
                    decoding_limitation = "压缩编码 %s 首版保持直通" % encoding
                total = len(raw)
        truncated = total > self.max_body
        raw = raw[: self.max_body]
        kind = message.headers.get("content-type", "").split(";", 1)[0].strip().lower()
        textual = not kind or kind.startswith("text/") or kind in ("application/json", "application/javascript", "application/xml", "application/x-www-form-urlencoded") or kind.endswith("+json") or kind.endswith("+xml")
        limitation = decoding_limitation
        if streamed:
            limitation = "流式、上传或超限正文保持直通，仅支持编辑头部与地址"
        elif truncated:
            limitation = "正文超过记录上限，保持直通"
        elif not textual or kind.startswith("multipart/"):
            limitation = "二进制或上传文件正文保持直通"
        try:
            body = raw.decode(message.headers.get("content-type", "").split("charset=")[-1].split(";")[0].strip() if "charset=" in message.headers.get("content-type", "") else "utf-8") if textual and not undecoded and not (streamed and message.headers.get("content-encoding")) else None
        except (UnicodeError, LookupError):
            body = None
            limitation = limitation or "正文无法按文本解码"
        encoding = "text" if body is not None else "base64"
        if body is None:
            body = base64.b64encode(raw).decode("ascii")
        result = {"body": body, "bodyEncoding": encoding, "bodyBytes": total, "truncated": truncated, "editable": limitation is None}
        if limitation:
            result["limitation"] = limitation
        return result

    def _snapshot(self, message, flow, stage):
        snap = {"headers": [[key, value] for key, value in message.headers.items(multi=True)], **self._body(message, flow, stage)}
        if stage == "request":
            snap.update(method=message.method, url=message.pretty_url)
        else:
            snap.update(status=message.status_code)
        return snap

    def _ensure_entry(self, flow):
        if flow.id not in self.entries:
            original = self._snapshot(flow.request, flow, "request")
            parsed = urlsplit(original["url"])
            self.entries[flow.id] = {
                "id": flow.id, "startedAt": int(flow.request.timestamp_start * 1000),
                "duration": 0, "method": original["method"], "host": parsed.hostname or "", "path": parsed.path or "/",
                "url": original["url"], "targetUrl": original["url"],
                "originalRequest": original, "request": copy.deepcopy(original), "mocked": False, "note": "", "tags": [],
            }
        return self.entries[flow.id]

    def _stream_reason(self, message):
        kind = message.headers.get("content-type", "").split(";", 1)[0].lower()
        length = message.headers.get("content-length")
        too_large = False
        if length:
            try:
                too_large = int(length) > self.max_body
            except ValueError:
                pass
        known_binary = bool(kind) and not (kind.startswith("text/") or kind in ("application/json", "application/javascript", "application/xml", "application/x-www-form-urlencoded") or kind.endswith("+json") or kind.endswith("+xml"))
        unknown_response = length is None and isinstance(message, http.Response) and message.status_code not in (204, 304)
        unknown_upload = length is None and isinstance(message, http.Request) and message.method not in ("GET", "HEAD", "OPTIONS")
        return too_large or known_binary or "event-stream" in kind or bool(message.headers.get("transfer-encoding")) or unknown_response or unknown_upload

    def _set_stream(self, flow, message, stage):
        capture = {"prefix": bytearray(), "total": 0}
        flow.metadata["flutter_pilot.capture." + stage] = capture

        def capture_chunk(chunk):
            capture["total"] += len(chunk)
            remaining = self.max_body - len(capture["prefix"])
            if remaining > 0:
                capture["prefix"].extend(chunk[:remaining])
            return chunk

        message.stream = capture_chunk

    async def requestheaders(self, flow):
        # Buffer only bodies that can be edited; uploading and SSE must never be
        # held in memory until completion to make a debugging UI work.
        if self._stream_reason(flow.request):
            self._set_stream(flow, flow.request, "request")
            await self._process_request(flow)

    async def request(self, flow):
        if not flow.metadata.get("flutter_pilot.request_processed"):
            await self._process_request(flow)
        else:
            self._refresh_stream_snapshots(flow, "request")

    async def _process_request(self, flow):
        if flow.metadata.get("flutter_pilot.request_processed"):
            return
        flow.metadata["flutter_pilot.request_processed"] = True
        entry = self._ensure_entry(flow)
        if not ctx.options.server:
            flow.response = http.Response.make(503, b"Flutter Pilot proxy is paused. Disable the client proxy to connect directly.", {"Content-Type": "text/plain", "Connection": "close"})
            return
        rule = select_rule(self.rules, entry["originalRequest"], "request")
        if rule:
            entry["requestRuleId"] = rule["id"]
            patch = copy.deepcopy(rule.get("request", {}))
            if "redirect" in rule:
                patch["url"] = rule["redirect"]["url"]
            self._apply_patch(flow, "request", patch, automatic=True)
            if "mock" in rule:
                mock = rule["mock"]
                headers = dict(mock.get("headers", {}))
                if not any(key.lower() == "content-type" for key in headers):
                    headers["Content-Type"] = "application/json; charset=utf-8"
                flow.response = http.Response.make(mock["status"], mock["body"].encode("utf-8"), headers)
                entry["mocked"] = True
        entry["automaticRequest"] = self._snapshot(flow.request, flow, "request")
        entry["request"] = copy.deepcopy(entry["automaticRequest"])
        entry["targetUrl"] = flow.request.pretty_url
        await self._break(flow, "request")
        entry["request"] = self._snapshot(flow.request, flow, "request")
        entry["targetUrl"] = flow.request.pretty_url

    async def responseheaders(self, flow):
        if self._stream_reason(flow.response):
            self._set_stream(flow, flow.response, "response")
            await self._process_response(flow)

    async def response(self, flow):
        if not flow.metadata.get("flutter_pilot.response_processed"):
            await self._process_response(flow)
        else:
            self._refresh_stream_snapshots(flow, "response")
        self._finish(flow)

    async def _process_response(self, flow):
        if flow.metadata.get("flutter_pilot.response_processed") or not flow.response:
            return
        flow.metadata["flutter_pilot.response_processed"] = True
        entry = self._ensure_entry(flow)
        entry["originalResponse"] = self._snapshot(flow.response, flow, "response")
        rule = select_rule(self.rules, entry["originalRequest"], "response")
        if rule:
            entry["responseRuleId"] = rule["id"]
            self._apply_patch(flow, "response", rule["response"], automatic=True)
        entry["automaticResponse"] = self._snapshot(flow.response, flow, "response")
        entry["response"] = copy.deepcopy(entry["automaticResponse"])
        await self._break(flow, "response")
        entry["response"] = self._snapshot(flow.response, flow, "response")

    def _refresh_stream_snapshots(self, flow, stage):
        if "flutter_pilot.capture." + stage not in flow.metadata:
            return
        entry = self.entries.get(flow.id)
        if not entry:
            return
        message = flow.request if stage == "request" else flow.response
        if not message:
            return
        content = self._body(message, flow, stage)
        keys = ("originalRequest", "automaticRequest", "request") if stage == "request" else ("originalResponse", "automaticResponse", "response")
        for key in keys:
            if key in entry:
                entry[key].update(content)

    def _apply_patch(self, flow, stage, patch, automatic=False):
        message = flow.request if stage == "request" else flow.response
        if message is None or not patch:
            return
        if not isinstance(patch, dict):
            raise ValueError("编辑内容必须为对象")
        # The same schema validates manual edits before mutating a live flow.
        validate_rules({"version": 1, "rules": [{"id": "manual", "name": "编辑", "enabled": True, "match": {}, stage: patch}]})
        body_editable = self._snapshot(message, flow, stage)["editable"]
        if "body" in patch and not body_editable and not automatic:
            raise ValueError("该正文为上传、二进制、流式或超限内容，不能编辑")
        if "body" in patch and len(patch["body"].encode("utf-8")) > self.max_body:
            if not automatic:
                raise ValueError("编辑后的正文超过容量上限")
            body_editable = False
        if stage == "request":
            before = urlsplit(message.url)
            if "url" in patch:
                validate_url(patch["url"])
                message.url = patch["url"]
                after = urlsplit(message.url)
                before_origin = (before.scheme, before.hostname, before.port or (443 if before.scheme == "https" else 80))
                after_origin = (after.scheme, after.hostname, after.port or (443 if after.scheme == "https" else 80))
                if before_origin != after_origin:
                    for key in ("authorization", "cookie", "proxy-authorization"):
                        message.headers.pop(key, None)
                    message.headers["host"] = after.netloc
            if "method" in patch:
                message.method = patch["method"].upper()
            for key, value in patch.get("query", {}).items():
                if value is None:
                    message.query.pop(key, None)
                else:
                    message.query[key] = value
        elif "status" in patch:
            message.status_code = patch["status"]
        for key, value in patch.get("headers", {}).items():
            if value is None:
                message.headers.pop(key, None)
            else:
                message.headers[key] = value
        if "body" in patch and body_editable:
            message.headers.pop("content-encoding", None)
            message.headers.pop("transfer-encoding", None)
            message.headers.pop("etag", None)
            message.headers.pop("content-md5", None)
            message.content = patch["body"].encode("utf-8")

    async def _break(self, flow, stage):
        entry = self.entries[flow.id]
        rule = select_rule(self.rules, entry["originalRequest"], "breakpoint." + stage)
        if not rule or self.writer is None or not self.interactive:
            return
        timeout = rule["breakpoint"].get("timeout", self.settings["breakpointTimeout"])
        bp_id = str(uuid.uuid4())
        event = asyncio.Event()
        original = entry["originalRequest" if stage == "request" else "originalResponse"]
        current = entry["automaticRequest" if stage == "request" else "automaticResponse"]
        bp = {"id": bp_id, "flowId": flow.id, "stage": stage, "expiresAt": _now() + int(timeout * 1000), "original": copy.deepcopy(original), "current": copy.deepcopy(current)}
        self.pending[bp_id] = {"event": event, "flow": flow, "data": bp, "reason": None}
        if not self.emit("breakpoint", bp):
            self.pending.pop(bp_id, None)
            return
        try:
            await asyncio.wait_for(event.wait(), timeout=timeout)
        except asyncio.TimeoutError:
            item = self.pending.get(bp_id)
            if item:
                item["reason"] = "timeout"
        except asyncio.CancelledError:
            item = self.pending.get(bp_id)
            if item:
                item["reason"] = "cancelled"
            raise
        finally:
            item = self.pending.pop(bp_id, None)
            if item:
                self.emit("breakpoint.resolved", {"id": bp_id, "reason": item["reason"] or "resumed"})

    def _resolve(self, params):
        bp_id = params.get("id")
        item = self.pending.get(bp_id)
        if not item or item["event"].is_set():
            raise ValueError("该断点已放行、超时或失效")
        flow = item["flow"]
        if not flow.live or flow.error:
            item["reason"] = "client-cancelled"
            item["event"].set()
            raise ValueError("客户端已取消该请求")
        action = params.get("action")
        if action not in ("resume", "abort"):
            raise ValueError("断点动作必须为 resume 或 abort")
        if action == "abort":
            if flow.killable:
                flow.kill()
            item["reason"] = "aborted"
        else:
            if params.get("patch"):
                self._apply_patch(flow, item["data"]["stage"], params["patch"])
            item["reason"] = "edited" if params.get("patch") else "resumed"
        item["event"].set()
        return {"ok": True}

    def _release_all(self, reason):
        count = 0
        for item in self.pending.values():
            if not item["event"].is_set():
                item["reason"] = reason
                item["event"].set()
                count += 1
        return count

    def error(self, flow):
        self._ensure_entry(flow)
        for item in self.pending.values():
            if item["flow"].id == flow.id:
                item["reason"] = "client-cancelled" if "client" in str(flow.error).lower() else "failed"
                item["event"].set()
        self._finish(flow)

    def client_disconnected(self, client):
        for item in self.pending.values():
            if item["flow"].client_conn.id == client.id:
                item["reason"] = "client-cancelled"
                item["event"].set()

    def _finish(self, flow):
        entry = self.entries.get(flow.id)
        if entry is None:
            return
        self._refresh_stream_snapshots(flow, "request")
        self._refresh_stream_snapshots(flow, "response")
        self.entries.pop(flow.id, None)
        entry["duration"] = max(0, _now() - entry["startedAt"])
        entry["targetUrl"] = flow.request.pretty_url
        if flow.error:
            entry["error"] = str(flow.error)
        if flow.response:
            entry["response"] = self._snapshot(flow.response, flow, "response")
        self.store.put(entry)
        self.emit("history", {"id": flow.id})


addons = [FlutterPilotAddon()]
