"""Rule semantics are tested without requiring a mitmproxy installation."""
import copy
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "proxy"))
from rules import matches, resolve_redirect_url, select_rule, validate_rules


class RuleTests(unittest.TestCase):
    def setUp(self):
        self.rule = {"id": "one", "name": "测试规则", "enabled": True, "priority": 10, "match": {"method": "get", "host": "api.example.com", "path": "/users/*", "headers": {"X-Env": "test"}, "query": {"page": "2"}}, "mock": {"status": 200, "headers": {}, "body": "{}"}}
        self.snapshot = {"method": "GET", "url": "https://api.example.com/users/123?page=1&page=2", "headers": [["x-env", "test"]]}

    def test_matches_method_host_glob_query_and_case_insensitive_headers(self):
        self.assertTrue(matches(self.rule, self.snapshot))
        for key, value in (("url", "https://other.example.com/users/123?page=2"), ("method", "POST"), ("headers", [["X-ENV", "prod"]])):
            with self.subTest(key=key):
                snap = dict(self.snapshot, **{key: value})
                self.assertFalse(matches(self.rule, snap))

    def test_priority_is_descending_and_equal_priority_is_stable(self):
        lower = dict(self.rule, id="lower", priority=0)
        equal = dict(self.rule, id="equal")
        self.assertEqual(select_rule([lower, self.rule, equal], self.snapshot, "request")["id"], "one")
        self.assertEqual(select_rule([lower, equal, self.rule], self.snapshot, "request")["id"], "equal")

    def test_stages_select_independently_and_skip_disabled(self):
        disabled = dict(self.rule, id="disabled", priority=100, enabled=False)
        response = dict(self.rule, id="response", response={"status": 201})
        response.pop("mock")
        bp = dict(self.rule, id="bp", breakpoint={"response": True})
        bp.pop("mock")
        rules = [disabled, response, bp, self.rule]
        self.assertEqual(select_rule(rules, self.snapshot, "request")["id"], "one")
        self.assertEqual(select_rule(rules, self.snapshot, "response")["id"], "response")
        self.assertEqual(select_rule(rules, self.snapshot, "breakpoint.response")["id"], "bp")
        self.assertIsNone(select_rule(rules, self.snapshot, "breakpoint.request"))

    def test_validation_returns_isolated_copy(self):
        result = validate_rules({"version": 1, "rules": [self.rule]})
        result[0]["mock"]["body"] = "changed"
        self.assertEqual(self.rule["mock"]["body"], "{}")

    def test_redirect_resolves_paths_without_losing_query_encoding(self):
        current = "https://api.example.com:8443/old?a=1&a=2&token=x%2Fy+z"
        cases = [
            ("/private/new", "https://api.example.com:8443/private/new?a=1&a=2&token=x%2Fy+z"),
            ("/private/new?b=%2F&b=2", "https://api.example.com:8443/private/new?b=%2F&b=2"),
            ("/private/new?", "https://api.example.com:8443/private/new?"),
            ("http://other.test/new", "http://other.test/new"),
        ]
        for target, expected in cases:
            with self.subTest(target=target):
                rule = dict(self.rule, redirect={"url": target})
                rule.pop("mock")
                validate_rules({"version": 1, "rules": [rule]})
                self.assertEqual(resolve_redirect_url(target, current), expected)

    def test_redirect_rejects_ambiguous_targets(self):
        for target in ("", "relative/path", "//other.test/path", "/a\\b", "/a b", "/a#fragment", "/a\x00b", "/a\x7fb", "https://other.test/a#fragment", "file:///tmp/a"):
            with self.subTest(target=target), self.assertRaises(ValueError):
                resolve_redirect_url(target, self.snapshot["url"])

    def test_invalid_documents_are_rejected_before_sync(self):
        mutations = [
            lambda rule: rule.update(priority=float("nan")),
            lambda rule: rule.update(redirect={"url": "file:///etc/passwd"}),
            lambda rule: rule.update(redirect={"url": "https://user:secret@example.com"}),
            lambda rule: rule.update(response={"status": 900}),
            lambda rule: rule.update(request={"headers": {"X-Test": "ok\r\nInjected: value"}}),
            lambda rule: rule.update(breakpoint={"request": True, "timeout": 1}),
            lambda rule: rule.update(mock={"status": 200, "body": {}}),
            lambda rule: rule.update(match={"headers": None}),
            lambda rule: rule.update(request={"query": None}),
        ]
        for mutate in mutations:
            rule = copy.deepcopy(self.rule)
            mutate(rule)
            with self.subTest(rule=rule), self.assertRaises(ValueError):
                validate_rules({"version": 1, "rules": [rule]})
        with self.assertRaises(ValueError):
            validate_rules({"version": 1, "rules": [self.rule, self.rule]})


if __name__ == "__main__":
    unittest.main()
