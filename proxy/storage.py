"""Private workspace history with bounded retention and immutable flow snapshots."""
from __future__ import annotations

import json
import os
import time
from pathlib import Path

try:
    if os.environ.get("FLUTTER_PILOT_SQLITE_CLI") == "1":
        raise ImportError("CLI backend requested")
    import sqlite3
except ImportError:
    import sqlite_cli as sqlite3


class HistoryStore:
    def __init__(self, folder, retention_days=7, max_records=10000):
        self.folder = Path(folder)
        self.folder.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.chmod(self.folder, 0o700)
        self.retention_days = retention_days
        self.max_records = max_records
        self.path = self.folder / "history.sqlite3"
        self.db = sqlite3.connect(str(self.path))
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("CREATE TABLE IF NOT EXISTS history (id TEXT PRIMARY KEY, started REAL NOT NULL, method TEXT NOT NULL, host TEXT NOT NULL, path TEXT NOT NULL, status INTEGER, mocked INTEGER NOT NULL, request_rule TEXT, response_rule TEXT, note TEXT NOT NULL DEFAULT '', tags TEXT NOT NULL DEFAULT '[]', payload TEXT NOT NULL)")
        self.db.execute("CREATE INDEX IF NOT EXISTS history_started ON history(started DESC)")
        self.db.execute("CREATE INDEX IF NOT EXISTS history_api ON history(method, host, path)")
        self.db.execute("CREATE TABLE IF NOT EXISTS api_catalog (method TEXT NOT NULL, host TEXT NOT NULL, path TEXT NOT NULL, calls INTEGER NOT NULL, first_at REAL NOT NULL, last_at REAL NOT NULL, PRIMARY KEY(method,host,path))")
        self.db.execute("CREATE INDEX IF NOT EXISTS api_catalog_last ON api_catalog(last_at DESC)")
        self.db.execute("CREATE TABLE IF NOT EXISTS api_catalog_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
        # Seed an existing database once, before history retention can prune it.
        # Re-running the seed after a crash overwrites aggregates, never adds them.
        migrated = self.db.execute("SELECT value FROM api_catalog_state WHERE key='history_migration_v1'").fetchone()
        if not migrated:
            self.db.execute("INSERT OR REPLACE INTO api_catalog SELECT method,host,path,count(*),min(started),max(started) FROM history GROUP BY method,host,path")
            self.db.execute("INSERT OR REPLACE INTO api_catalog_state VALUES ('history_migration_v1','done')")
        self.db.commit()
        os.chmod(self.path, 0o600)
        self.prune()

    def put(self, entry):
        previous = self.db.execute("SELECT note,tags FROM history WHERE id=?", (entry["id"],)).fetchone()
        note, tags = previous if previous else (entry.get("note", ""), json.dumps(entry.get("tags", []), ensure_ascii=False))
        payload = dict(entry, note=note, tags=json.loads(tags))
        self.db.execute("INSERT OR REPLACE INTO history VALUES (?,?,?,?,?,?,?,?,?,?,?,?)", (entry["id"], entry["startedAt"], entry["method"], entry["host"], entry["path"], entry.get("response", {}).get("status"), int(entry.get("mocked", False)), entry.get("requestRuleId"), entry.get("responseRuleId"), note, tags, json.dumps(payload, ensure_ascii=False)))
        # Updating an already stored flow must not inflate discovery counts.
        if previous is None:
            self.db.execute("INSERT INTO api_catalog (method,host,path,calls,first_at,last_at) VALUES (?,?,?,?,?,?) ON CONFLICT(method,host,path) DO UPDATE SET calls=calls+1, first_at=min(first_at,excluded.first_at), last_at=max(last_at,excluded.last_at)", (entry["method"], entry["host"], entry["path"], 1, entry["startedAt"], entry["startedAt"]))
        self.db.commit()
        self.prune()

    def prune(self):
        cutoff = (time.time() - self.retention_days * 86400) * 1000
        self.db.execute("DELETE FROM history WHERE started < ?", (cutoff,))
        self.db.execute("DELETE FROM history WHERE id IN (SELECT id FROM history ORDER BY started DESC LIMIT -1 OFFSET ?)", (self.max_records,))
        self.db.commit()

    def get(self, entry_id):
        row = self.db.execute("SELECT payload FROM history WHERE id=?", (entry_id,)).fetchone()
        if row is None:
            raise ValueError("历史记录不存在或已被清理")
        return json.loads(row[0])

    def list(self, params, summary=False):
        where, args = [], []
        if params.get("search"):
            where.append("(host LIKE ? ESCAPE '\\' OR path LIKE ? ESCAPE '\\' OR note LIKE ? ESCAPE '\\' OR json_extract(payload,'$.url') LIKE ? ESCAPE '\\' OR json_extract(payload,'$.targetUrl') LIKE ? ESCAPE '\\' OR tags LIKE ? ESCAPE '\\')")
            value = str(params["search"]).replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
            args.extend(["%" + value + "%"] * 6)
        for key, column in (("method", "method"), ("host", "host"), ("path", "path"), ("status", "status"), ("mocked", "mocked")):
            if key in params and params[key] not in (None, ""):
                where.append(column + "=?")
                args.append(int(params[key]) if key in ("status", "mocked") else str(params[key]).upper() if key == "method" else str(params[key]))
        if params.get("ruleId"):
            where.append("(request_rule=? OR response_rule=?)")
            args.extend([params["ruleId"]] * 2)
        for key, op in (("from", ">="), ("to", "<=")):
            if params.get(key) is not None:
                where.append("started" + op + "?")
                args.append(float(params[key]))
        condition = " WHERE " + " AND ".join(where) if where else ""
        total = self.db.execute("SELECT count(*) FROM history" + condition, args).fetchone()[0]
        limit = max(1, min(200, int(params.get("limit", 50))))
        offset = max(0, int(params.get("offset", 0)))
        projection = "json_set(json_remove(payload,'$.originalRequest','$.automaticRequest','$.request','$.originalResponse','$.automaticResponse','$.response'),'$.status',status)" if summary else "payload"
        rows = self.db.execute("SELECT " + projection + " FROM history" + condition + " ORDER BY started DESC LIMIT ? OFFSET ?", args + [limit, offset]).fetchall()
        return {"items": [json.loads(row[0]) for row in rows], "total": total}

    def apis(self, params):
        condition, args = "", []
        if params.get("search"):
            condition = " WHERE host LIKE ? ESCAPE '\\' OR path LIKE ? ESCAPE '\\' OR method LIKE ? ESCAPE '\\'"
            value = str(params["search"]).replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
            args = ["%" + value + "%"] * 3
        rows = self.db.execute("SELECT method,host,path,calls,last_at,first_at FROM api_catalog" + condition + " ORDER BY last_at DESC,method,host,path", args).fetchall()
        return {"items": [dict(zip(("method", "host", "path", "count", "lastAt", "firstAt"), row)) for row in rows]}

    def delete_api(self, method, host, path):
        if not all(isinstance(value, str) and value for value in (method, host, path)):
            raise ValueError("API method、host、path 必须为非空字符串")
        before = self.db.total_changes
        self.db.execute("DELETE FROM api_catalog WHERE method=? AND host=? AND path=?", (method, host, path))
        self.db.commit()
        return {"deleted": self.db.total_changes - before}

    def clear_apis(self):
        self.db.execute("DELETE FROM api_catalog")
        self.db.commit()
        return {"ok": True}

    def delete(self, ids):
        if not isinstance(ids, list) or not all(isinstance(item, str) for item in ids):
            raise ValueError("ids 必须为字符串数组")
        before = self.db.total_changes
        self.db.executemany("DELETE FROM history WHERE id=?", [(item,) for item in ids])
        self.db.commit()
        return {"deleted": self.db.total_changes - before}

    def clear(self):
        self.db.execute("DELETE FROM history")
        self.db.commit()
        self.db.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        return {"ok": True}

    def update(self, entry_id, note, tags):
        if not isinstance(note, str) or len(note) > 20000:
            raise ValueError("备注必须为字符串，最多 20000 字符")
        if not isinstance(tags, list) or len(tags) > 100 or not all(isinstance(tag, str) and len(tag) <= 200 for tag in tags):
            raise ValueError("标签必须为字符串数组")
        entry = self.get(entry_id)
        entry.update(note=note, tags=tags)
        self.db.execute("UPDATE history SET note=?, tags=?, payload=? WHERE id=?", (note, json.dumps(tags, ensure_ascii=False), json.dumps(entry, ensure_ascii=False), entry_id))
        self.db.commit()
        return entry

    def close(self):
        self.db.close()
