"""Deterministic, side-effect free matching and schema validation."""
from __future__ import annotations

import copy
import fnmatch
import json
import math
import re
from urllib.parse import parse_qs, urlsplit

SCHEMA_VERSION = 1


def validate_rules(document):
    if not isinstance(document, dict) or document.get("version") != SCHEMA_VERSION:
        raise ValueError("规则文件必须使用 version: 1")
    rules = document.get("rules")
    if not isinstance(rules, list) or len(rules) > 5000:
        raise ValueError("rules 必须为数组，最多 5000 条")
    ids = set()
    for rule in rules:
        if not isinstance(rule, dict):
            raise ValueError("每条规则必须为对象")
        if not isinstance(rule.get("id"), str) or not rule["id"] or rule["id"] in ids:
            raise ValueError("规则 id 必须为非空且唯一的字符串")
        ids.add(rule["id"])
        if not isinstance(rule.get("name"), str) or not rule["name"].strip():
            raise ValueError("规则名称不能为空")
        if not isinstance(rule.get("enabled"), bool):
            raise ValueError("enabled 必须为布尔值")
        priority = rule.get("priority", 0)
        if isinstance(priority, bool) or not isinstance(priority, (float, int)) or not math.isfinite(priority):
            raise ValueError("priority 必须为有限数字")
        match = rule.get("match", {})
        if not isinstance(match, dict):
            raise ValueError("match 必须为对象")
        for key in ("method", "host", "path"):
            if key in match and not isinstance(match[key], str):
                raise ValueError("匹配条件 %s 必须为字符串" % key)
        for key in ("headers", "query"):
            if key in match:
                _string_map(match[key], nullable=False)
        if "bodyJson" in match:
            body = match["bodyJson"]
            if not isinstance(body, dict) or not body or not _valid_json(body):
                raise ValueError("match.bodyJson 必须是非空 JSON 对象，最多嵌套 32 层，数字必须有限")
        if "bodyRegex" in match:
            patterns = match["bodyRegex"]
            if not isinstance(patterns, dict) or not patterns:
                raise ValueError("match.bodyRegex 必须是非空 JSON 对象")
            for key, pattern in patterns.items():
                if not isinstance(key, str) or not isinstance(pattern, str):
                    raise ValueError("match.bodyRegex 的键和值必须是字符串")
                try:
                    _compile_regex(pattern)
                except re.error:
                    raise ValueError("match.bodyRegex 包含无效或代理不支持的正则") from None
        if not any(key in rule for key in ("request", "redirect", "mock", "response", "breakpoint")):
            raise ValueError("规则必须至少包含一个动作")
        for stage in ("request", "response"):
            action = rule.get(stage)
            if action is None:
                continue
            if not isinstance(action, dict):
                raise ValueError("%s 必须为对象" % stage)
            if "headers" in action:
                _string_map(action["headers"], nullable=True)
            if "body" in action and not isinstance(action["body"], str):
                raise ValueError("body 必须为字符串")
            if stage == "request":
                if "query" in action:
                    _string_map(action["query"], nullable=True)
                if "method" in action and (not isinstance(action["method"], str) or not action["method"].strip()):
                    raise ValueError("请求方法不能为空")
                if "url" in action:
                    validate_url(action["url"])
            elif "status" in action:
                _status(action["status"])
        if "redirect" in rule:
            if not isinstance(rule["redirect"], dict):
                raise ValueError("redirect 必须为对象")
            validate_redirect_url(rule["redirect"].get("url"))
        if "mock" in rule:
            mock = rule["mock"]
            if not isinstance(mock, dict):
                raise ValueError("mock 必须为对象")
            _status(mock.get("status"))
            _string_map(mock.get("headers", {}), nullable=False)
            if not isinstance(mock.get("body"), str):
                raise ValueError("mock.body 必须为字符串")
        if "scenario" in rule:
            scenario = rule["scenario"]
            if not isinstance(scenario, dict) or set(scenario) - {"id", "initial", "when", "next"}:
                raise ValueError("scenario 必须为对象且不能包含未知字段")
            for key in ("id", "initial", "when", "next"):
                if key == "next" and key not in scenario:
                    continue
                value = scenario.get(key)
                if not isinstance(value, str) or not value.strip() or len(value) > 128 or any(ord(char) < 32 or ord(char) == 127 for char in value):
                    raise ValueError("scenario.%s 必须为非空字符串，最多 128 字符且不能包含控制字符" % key)
            if "mock" not in rule or any(key in rule for key in ("request", "redirect", "response", "breakpoint")):
                raise ValueError("有状态规则仅支持直接 HTTP Mock")
        if "breakpoint" in rule:
            bp = rule["breakpoint"]
            if not isinstance(bp, dict) or not any(bp.get(k) is True for k in ("request", "response")):
                raise ValueError("断点必须选择请求或响应阶段")
            for key in ("request", "response"):
                if key in bp and not isinstance(bp[key], bool):
                    raise ValueError("断点阶段必须为布尔值")
            if "timeout" in bp and (isinstance(bp["timeout"], bool) or not isinstance(bp["timeout"], (int, float)) or not 10 <= bp["timeout"] <= 300):
                raise ValueError("断点等待时间必须为 10–300 秒")
    initial_states = {}
    for rule in rules:
        scenario = rule.get("scenario")
        if not scenario:
            continue
        if scenario["id"] in initial_states and initial_states[scenario["id"]] != scenario["initial"]:
            raise ValueError("同一 scenario 的 initial 必须一致")
        initial_states[scenario["id"]] = scenario["initial"]
    return copy.deepcopy(rules)


def _valid_json(value, depth=0):
    if depth > 32:
        return False
    if value is None or isinstance(value, (str, bool)):
        return True
    if isinstance(value, (float, int)):
        try:
            return math.isfinite(value)
        except OverflowError:
            return False
    if isinstance(value, list):
        return all(_valid_json(item, depth + 1) for item in value)
    return isinstance(value, dict) and all(
        isinstance(key, str) and _valid_json(item, depth + 1) for key, item in value.items()
    )


def _compile_regex(pattern):
    # JavaScript and Dart use ASCII character classes for \d and \w.
    return re.compile(pattern, re.ASCII)


def _json_equal(actual, expected):
    if isinstance(expected, dict):
        return isinstance(actual, dict) and actual.keys() == expected.keys() and all(
            _json_equal(actual[key], value) for key, value in expected.items()
        )
    if isinstance(expected, list):
        return isinstance(actual, list) and len(actual) == len(expected) and all(
            _json_equal(item, value) for item, value in zip(actual, expected)
        )
    if type(expected) in (int, float):
        return type(actual) in (int, float) and float(actual) == float(expected)
    return type(actual) is type(expected) and actual == expected


def _reject_json_constant(_):
    raise ValueError("Invalid JSON number")


def _matches_body(match, snapshot):
    exact = match.get("bodyJson")
    patterns = match.get("bodyRegex")
    if exact is None and patterns is None:
        return True
    if not snapshot.get("editable") or snapshot.get("truncated") or snapshot.get("bodyEncoding") != "text":
        return False
    mime = next((value for name, value in snapshot.get("headers", []) if name.lower() == "content-type"), "")
    mime = mime.split(";", 1)[0].strip().lower()
    if mime not in ("application/json", "text/json") and not mime.endswith("+json"):
        return False
    try:
        actual = json.loads(snapshot["body"], parse_int=float, parse_constant=_reject_json_constant)
    except (ValueError, RecursionError):
        return False
    if not isinstance(actual, dict):
        return False
    return all(key in actual and _json_equal(actual[key], value) for key, value in (exact or {}).items()) and all(
        isinstance(value := actual.get(key), str) and _compile_regex(pattern).fullmatch(value) is not None
        for key, pattern in (patterns or {}).items()
    )


def _string_map(value, nullable):
    if not isinstance(value, dict):
        raise ValueError("请求头或查询参数必须为对象")
    for key, item in value.items():
        if not isinstance(key, str) or not key or "\r" in key or "\n" in key:
            raise ValueError("参数名必须为非空字符串且不能含换行")
        if item is None and nullable:
            continue
        if not isinstance(item, str) or "\r" in item or "\n" in item:
            raise ValueError("参数值必须为字符串且不能含换行")


def _status(value):
    if isinstance(value, bool) or not isinstance(value, int) or not 100 <= value <= 599:
        raise ValueError("HTTP 状态码必须为 100–599 的整数")


def validate_url(value):
    if not isinstance(value, str):
        raise ValueError("目标地址必须为字符串")
    try:
        parsed = urlsplit(value)
        if parsed.scheme not in ("http", "https") or not parsed.hostname or parsed.username or parsed.password:
            raise ValueError()
        _ = parsed.port
        if any(char.isspace() for char in value):
            raise ValueError()
    except ValueError:
        raise ValueError("目标地址必须为不含凭证的完整 HTTP/HTTPS URL")


def validate_redirect_url(value):
    if not isinstance(value, str) or not value or any(char.isspace() or ord(char) < 32 or ord(char) == 127 for char in value) or "\\" in value or "#" in value:
        raise ValueError("转发地址必须为不含空白、控制字符、反斜杠和片段的路径或 HTTP/HTTPS URL")
    if value.startswith("/"):
        if value.startswith("//"):
            raise ValueError("转发路径不能以 // 开头")
        return
    validate_url(value)


def resolve_redirect_url(value, current):
    validate_redirect_url(value)
    if not value.startswith("/"):
        return value
    original = urlsplit(current)
    query = "" if "?" in value or not original.query else "?" + original.query
    return original.scheme + "://" + original.netloc + value + query


def matches(rule, snapshot, scenario_states=None):
    scenario = rule.get("scenario")
    if scenario and (scenario_states or {}).get(scenario["id"], scenario["initial"]) != scenario["when"]:
        return False
    match = rule.get("match", {})
    parsed = urlsplit(snapshot["url"])
    if match.get("method") not in (None, "", "*") and snapshot["method"].upper() != match["method"].upper():
        return False
    if match.get("host") not in (None, "", "*") and (parsed.hostname or "").lower() != match["host"].lower():
        return False
    if match.get("path") and not fnmatch.fnmatchcase(parsed.path or "/", match["path"]):
        return False
    query = parse_qs(parsed.query, keep_blank_values=True)
    for key, value in match.get("query", {}).items():
        if value not in query.get(key, []):
            return False
    headers = {}
    for key, value in snapshot.get("headers", []):
        headers.setdefault(key.lower(), []).append(value)
    for key, value in match.get("headers", {}).items():
        if value not in headers.get(key.lower(), []):
            return False
    return _matches_body(match, snapshot)


def select_rule(rules, snapshot, stage, scenario_states=None):
    for rule in sorted(rules, key=lambda item: -item.get("priority", 0)):
        if not rule.get("enabled") or not matches(rule, snapshot, scenario_states):
            continue
        if stage == "request" and any(key in rule for key in ("request", "redirect", "mock")):
            return rule
        if stage == "response" and "response" in rule:
            return rule
        if stage.startswith("breakpoint.") and rule.get("breakpoint", {}).get(stage.split(".")[1]):
            return rule
    return None


def sync_scenarios(rules, scenario_states):
    """Drop removed scopes while retaining every surviving run's current state."""
    live = {rule["scenario"]["id"] for rule in rules if "scenario" in rule}
    for key in list(scenario_states):
        if key not in live:
            del scenario_states[key]


def advance_scenario(rule, scenario_states):
    """Call only after constructing the mock response, before yielding delivery."""
    scenario = rule.get("scenario")
    if scenario and "next" in scenario:
        scenario_states[scenario["id"]] = scenario["next"]
