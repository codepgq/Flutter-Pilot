"""Stateful fixtures preserve causal ordering and isolate each test run."""
import copy
import importlib.util
import json
import os
import sys
import types
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "proxy"))
from rules import advance_scenario, matches, select_rule, sync_scenarios, validate_rules
import test_integration as integration


def fixtures(run_id="run-one"):
    def rule(id, method, when, body, next_state=None):
        scenario = {"id": run_id, "initial": "empty", "when": when}
        if next_state is not None:
            scenario["next"] = next_state
        return {"id": id, "name": id, "enabled": True, "priority": 0,
                "match": {"method": method, "path": "/orders"}, "scenario": scenario,
                "mock": {"status": 200, "headers": {}, "body": json.dumps(body)}}
    return [rule("empty", "GET", "empty", []),
            rule("submit", "POST", "empty", {"orderId": "current"}, "pending"),
            rule("pending", "GET", "pending", [{"orderId": "current", "status": "pending"}])]


class StatefulRuleTests(unittest.TestCase):
    def test_only_the_current_state_matches_and_normal_rules_are_unchanged(self):
        rules = validate_rules({"version": 1, "rules": fixtures()})
        state = {}
        request = {"url": "https://example.test/orders", "method": "GET"}
        self.assertEqual(select_rule(rules, request, "request", state)["id"], "empty")
        submit = select_rule(rules, dict(request, method="POST"), "request", state)
        self.assertEqual(state, {})
        advance_scenario(submit, state)
        self.assertEqual(select_rule(rules, request, "request", state)["id"], "pending")
        plain = copy.deepcopy(rules[0])
        plain.pop("scenario")
        self.assertTrue(matches(plain, request, state))

    def test_sync_retains_surviving_scopes_and_prunes_removed_runs(self):
        state = {"run-one": "pending", "removed": "pending"}
        sync_scenarios(fixtures(), state)
        self.assertEqual(state, {"run-one": "pending"})
        sync_scenarios(fixtures("run-two"), state)
        self.assertEqual(state, {})
        self.assertEqual(select_rule(fixtures("run-two"), {"url": "https://example.test/orders", "method": "GET"}, "request", state)["id"], "empty")

    def test_transition_is_explicit_and_never_inferred_from_status(self):
        mock = fixtures()[1]
        mock["scenario"].pop("next")
        state = {}
        advance_scenario(mock, state)
        self.assertEqual(state, {})
        mock["mock"]["status"] = 400
        mock["scenario"]["next"] = "denied"
        advance_scenario(mock, state)
        self.assertEqual(state, {"run-one": "denied"})

    def test_invalid_runtime_scenarios_are_rejected_before_mutation(self):
        for mutation in (
            lambda rule: rule.update(scenario={}),
            lambda rule: rule["scenario"].update(extra=True),
            lambda rule: rule["scenario"].update(id=""),
            lambda rule: rule["scenario"].update(when="\n"),
            lambda rule: rule.update(request={"body": "changed"}),
            lambda rule: rule.update(response={"body": "changed"}),
            lambda rule: rule.update(breakpoint={"request": True}),
            lambda rule: rule.pop("mock"),
        ):
            rule = fixtures()[0]
            mutation(rule)
            with self.subTest(rule=rule), self.assertRaises(ValueError):
                validate_rules({"version": 1, "rules": [rule]})
        rules = fixtures()
        rules[1]["scenario"]["initial"] = "other"
        with self.assertRaisesRegex(ValueError, "initial"):
            validate_rules({"version": 1, "rules": rules})


class StatefulAddonTests(unittest.IsolatedAsyncioTestCase):
    @classmethod
    def setUpClass(cls):
        # Exercise the actual addon without requiring an installed proxy engine.
        fake = types.ModuleType("mitmproxy")
        cls.response_factory = types.SimpleNamespace(make=lambda status, body, headers: (status, body, headers))
        fake.ctx = types.SimpleNamespace(options=types.SimpleNamespace(server=True))
        fake.http = types.SimpleNamespace(Response=cls.response_factory)
        spec = importlib.util.spec_from_file_location("pilot_stateful_addon_test", Path(__file__).resolve().parents[2] / "proxy" / "addon.py")
        module = importlib.util.module_from_spec(spec)
        with patch.dict(sys.modules, {"mitmproxy": fake}):
            spec.loader.exec_module(module)
        cls.addon_type = module.FlutterPilotAddon

    async def asyncSetUp(self):
        self.addon = self.addon_type()
        self.rule_set = fixtures()
        await self.addon._rpc("rules.sync", {"version": 1, "rules": self.rule_set})
        self.entries = []
        self.at_delivery = []

        def ensure_entry(flow):
            original = {"method": flow.request.method, "url": flow.request.url}
            entry = {"originalRequest": original}
            self.entries.append(entry)
            return entry

        self.addon._ensure_entry = ensure_entry
        self.addon._apply_patch = lambda *args, **kwargs: None
        self.addon._snapshot = lambda message, flow, stage: {"method": message.method, "url": message.url}

        async def delivery_boundary(flow, stage):
            request = {"method": "GET", "url": flow.request.url}
            selected = select_rule(self.addon.rules, request, "request", self.addon.scenario_states)
            self.at_delivery.append(selected["id"] if selected else None)

        self.addon._break = delivery_boundary

    def flow(self, method):
        return types.SimpleNamespace(metadata={}, request=types.SimpleNamespace(method=method, url="https://example.test/orders", pretty_url="https://example.test/orders"), response=None)

    async def test_state_is_committed_before_first_delivery_boundary_and_survives_rule_sync(self):
        flow = self.flow("POST")
        await self.addon._process_request(flow)
        self.assertEqual(self.at_delivery, ["pending"])
        self.assertEqual(self.entries[0]["requestRuleId"], "submit")
        self.assertTrue(self.entries[0]["mocked"])
        self.assertEqual(json.loads(flow.response[1]), {"orderId": "current"})
        await self.addon._rpc("rules.sync", {"version": 1, "rules": self.rule_set})
        self.assertEqual(self.addon.scenario_states, {"run-one": "pending"})
        await self.addon._rpc("rules.sync", {"version": 1, "rules": fixtures("run-two")})
        self.assertEqual(self.addon.scenario_states, {})

    async def test_failed_mock_response_construction_does_not_commit_or_retry(self):
        flow = self.flow("POST")
        with patch.object(self.response_factory, "make", side_effect=ValueError("response construction failed")):
            with self.assertRaisesRegex(ValueError, "construction failed"):
                await self.addon._process_request(flow)
        self.assertEqual(self.addon.scenario_states, {})
        self.assertEqual(self.at_delivery, [])
        await self.addon._process_request(flow)
        self.assertIsNone(flow.response)
        self.assertEqual(len(self.entries), 1)

    async def test_list_read_without_submission_does_not_generate_pending(self):
        flow = self.flow("GET")
        await self.addon._process_request(flow)
        self.assertEqual(json.loads(flow.response[1]), [])
        self.assertEqual(self.at_delivery, ["empty"])
        self.assertEqual(self.addon.scenario_states, {})


@unittest.skipUnless(os.environ.get("MITMDUMP"), "设置 MITMDUMP 后运行真实有状态 HTTP 测试")
class StatefulProxyIntegrationTests(unittest.TestCase):
    # Reuse the existing real engine fixture without inheriting its test methods.
    setUpClass = classmethod(integration.ProxyIntegrationTests.setUpClass.__func__)
    tearDownClass = classmethod(integration.ProxyIntegrationTests.tearDownClass.__func__)
    setUp = integration.ProxyIntegrationTests.setUp
    sync = integration.ProxyIntegrationTests.sync
    request = integration.ProxyIntegrationTests.request

    def test_immediate_refresh_sees_pending_then_new_run_starts_empty(self):
        rules = fixtures()
        self.sync(rules)
        self.assertEqual(json.loads(self.request("/orders")[2]), [])
        self.assertEqual(json.loads(self.request("/orders", method="POST", body='{"price":"10","quantity":"2"}')[2]), {"orderId": "current"})
        pending = [{"orderId": "current", "status": "pending"}]
        self.assertEqual(json.loads(self.request("/orders")[2]), pending)
        self.sync(rules)
        self.assertEqual(json.loads(self.request("/orders")[2]), pending)
        rules = fixtures("run-two")
        self.sync(rules)
        self.assertEqual(json.loads(self.request("/orders")[2]), [])
        self.assertEqual(integration.Origin.calls, [])

    def test_business_rejection_does_not_transition_without_next(self):
        rules = fixtures()
        rules[1]["scenario"].pop("next")
        rules[1]["mock"]["body"] = '{"code":"INSUFFICIENT_BALANCE"}'
        self.sync(rules)
        response = self.request("/orders", method="POST", body="{}")
        self.assertEqual(response[0], 200)
        self.assertEqual(json.loads(response[2])["code"], "INSUFFICIENT_BALANCE")
        self.assertEqual(json.loads(self.request("/orders")[2]), [])


if __name__ == "__main__":
    unittest.main()
