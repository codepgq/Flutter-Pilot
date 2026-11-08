import os
import sys
import tempfile
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "proxy"))
from storage import HistoryStore


class StorageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.store = HistoryStore(self.temp.name, retention_days=7, max_records=3)

    def tearDown(self):
        self.store.close()
        self.temp.cleanup()

    def entry(self, entry_id, **kwargs):
        return dict({"id": entry_id, "startedAt": time.time() * 1000, "method": "GET", "host": "api.test", "path": "/users", "url": "https://api.test/users", "targetUrl": "https://api.test/users", "mocked": False, "originalRequest": {"body": "original"}, "request": {"body": "modified"}, "response": {"status": 200}, "note": "", "tags": []}, **kwargs)

    def test_note_update_does_not_change_actual_flow(self):
        entry = self.entry("1")
        self.store.put(entry)
        updated = self.store.update("1", "登录失败场景", ["login", "400"])
        self.assertEqual(updated["originalRequest"], entry["originalRequest"])
        self.assertEqual(updated["request"], entry["request"])
        self.store.put(entry)
        self.assertEqual(self.store.get("1")["note"], "登录失败场景")
        self.assertEqual(self.store.list({"search": "登录"})["total"], 1)

    def test_filters_pagination_delete_and_restart(self):
        self.store.put(self.entry("1", mocked=True, requestRuleId="rule"))
        self.store.put(self.entry("2", method="POST", response={"status": 401}))
        self.assertEqual(self.store.list({"mocked": True, "ruleId": "rule"})["total"], 1)
        self.assertEqual(self.store.list({"method": "post", "status": 401})["items"][0]["id"], "2")
        self.assertEqual(len(self.store.list({"limit": 1})["items"]), 1)
        self.store.close()
        self.store = HistoryStore(self.temp.name)
        self.assertEqual(self.store.list({})["total"], 2)
        self.assertEqual(self.store.delete(["1"]), {"deleted": 1})
        self.store.clear()
        self.assertEqual(self.store.list({})["total"], 0)

    def test_retention_count_and_private_permissions(self):
        self.store.put(self.entry("expired", startedAt=(time.time() - 8 * 86400) * 1000))
        self.assertEqual(self.store.list({})["total"], 0)
        for i in range(5):
            self.store.put(self.entry(str(i), startedAt=time.time() * 1000 + i))
        self.assertEqual(self.store.list({})["total"], 3)
        with self.assertRaises(ValueError):
            self.store.get("0")
        if os.name != "nt":
            self.assertEqual(os.stat(self.store.path).st_mode & 0o777, 0o600)

    def test_search_treats_sql_wildcards_as_literals(self):
        self.store.put(self.entry("1", path="/users_1"))
        self.store.put(self.entry("2", path="/usersA1"))
        self.assertEqual(self.store.list({"search": "users_1"})["total"], 1)

    def test_search_includes_original_and_forwarded_query_string(self):
        self.store.put(self.entry("1", url="https://api.test/users?filter=active", targetUrl="https://local.test/users?mode=preview"))
        self.assertEqual(self.store.list({"search": "filter=active"})["total"], 1)
        self.assertEqual(self.store.list({"search": "mode=preview"})["total"], 1)

    def test_summary_and_api_groups_exclude_large_snapshots(self):
        self.store.put(self.entry("1", method="POST"))
        self.store.put(self.entry("2", method="POST"))
        self.store.put(self.entry("3", path="/other"))
        result = self.store.list({"method": "POST", "host": "api.test", "path": "/users"}, summary=True)
        self.assertEqual(result["total"], 2)
        self.assertEqual(result["items"][0]["status"], 200)
        self.assertNotIn("originalRequest", result["items"][0])
        grouped = self.store.apis({"search": "users"})
        self.assertEqual(grouped["items"][0]["count"], 2)

    def test_catalog_survives_pruning_history_delete_clear_and_restart(self):
        now = time.time() * 1000
        self.store.put(self.entry("expired-api", path="/expired", startedAt=now - 8 * 86400000))
        self.store.put(self.entry("one", startedAt=now))
        self.store.put(self.entry("two", startedAt=now + 1))
        self.store.delete(["one"])
        self.store.clear()
        self.assertEqual(self.store.list({})["total"], 0)
        groups = {item["path"]: item for item in self.store.apis({})["items"]}
        self.assertEqual(groups["/users"]["count"], 2)
        self.assertEqual(groups["/users"]["firstAt"], now)
        self.assertEqual(groups["/users"]["lastAt"], now + 1)
        self.assertIn("/expired", groups)
        self.store.close()
        self.store = HistoryStore(self.temp.name)
        self.assertEqual(self.store.apis({})["items"], sorted(groups.values(), key=lambda item: -item["lastAt"]))

    def test_catalog_flow_updates_do_not_increment_calls(self):
        entry = self.entry("same")
        self.store.put(entry)
        self.store.put(dict(entry, response={"status": 202}))
        self.store.update("same", "changed", ["tag"])
        self.assertEqual(self.store.apis({})["items"][0]["count"], 1)

    def test_deleted_catalog_entry_does_not_return_on_restart_but_new_call_rediscovers(self):
        self.store.put(self.entry("one"))
        self.assertEqual(self.store.delete_api("GET", "api.test", "/users"), {"deleted": 1})
        self.assertEqual(self.store.list({})["total"], 1)
        self.store.close()
        self.store = HistoryStore(self.temp.name)
        self.assertEqual(self.store.apis({})["items"], [])
        self.store.put(self.entry("two"))
        self.assertEqual(self.store.apis({})["items"][0]["count"], 1)

    def test_catalog_migrates_legacy_history_once_before_retention(self):
        now = time.time() * 1000
        self.store.put(self.entry("one", startedAt=now))
        self.store.put(self.entry("two", startedAt=now + 1))
        self.store.db.execute("DROP TABLE api_catalog")
        self.store.db.execute("DROP TABLE api_catalog_state")
        self.store.db.commit()
        self.store.close()
        self.store = HistoryStore(self.temp.name)
        item = self.store.apis({})["items"][0]
        self.assertEqual((item["count"], item["firstAt"], item["lastAt"]), (2, now, now + 1))
        self.store.clear_apis()
        self.store.close()
        self.store = HistoryStore(self.temp.name)
        self.assertEqual(self.store.apis({})["items"], [])
        self.assertEqual(self.store.list({})["total"], 2)

    def test_catalog_search_and_delete_treat_inputs_as_data(self):
        path = "/users_1' ; DROP TABLE history;--"
        self.store.put(self.entry("one", path=path))
        self.store.put(self.entry("two", path="/usersA1"))
        self.assertEqual(self.store.apis({"search": "users_1"})["items"][0]["path"], path)
        self.assertEqual(self.store.delete_api("GET", "api.test", path), {"deleted": 1})
        self.assertEqual(self.store.list({})["total"], 2)
        with self.assertRaises(ValueError):
            self.store.delete_api(None, "api.test", "/users")

    def test_untrusted_strings_remain_data_in_cli_backend(self):
        entry = self.entry("quote'); DROP TABLE history;--", path="/quote'\n.shell touch /tmp/api-mocks-invalid\n")
        self.store.put(entry)
        note = "带引号 ' 中文\n.sql\n\x00 null"
        self.store.update(entry["id"], note, ["a'b"])
        self.assertEqual(self.store.get(entry["id"])["note"], note)
        self.assertEqual(self.store.list({})["total"], 1)


if __name__ == "__main__":
    unittest.main()
