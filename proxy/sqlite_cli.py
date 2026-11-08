"""Small sqlite3 DB-API subset for standalone engines omitting Python sqlite3.

macOS ships /usr/bin/sqlite3. SQL is sent through stdin (never shell or argv),
parameters are encoded as SQL literals, and JSON output preserves Unicode.
"""
import json
import math
import subprocess


def _literal(value):
    if value is None:
        return "NULL"
    if isinstance(value, bool):
        return "1" if value else "0"
    if isinstance(value, (int, float)):
        if not math.isfinite(value):
            raise ValueError("Non-finite SQLite parameter")
        return str(value)
    if not isinstance(value, str):
        raise TypeError("Unsupported SQLite parameter")
    if "\x00" in value:
        return "CAST(X'%s' AS TEXT)" % value.encode("utf-8").hex()
    return "'" + value.replace("'", "''") + "'"


def _bind(sql, parameters):
    # Only placeholders in our own fixed SQL templates are substituted. User
    # strings are never reparsed as templates or concatenated as SQL fragments.
    parts = sql.split("?")
    if len(parts) != len(parameters) + 1:
        raise ValueError("Incorrect number of SQLite parameters")
    result = parts[0]
    for parameter, part in zip(parameters, parts[1:]):
        result += _literal(parameter) + part
    return result


class Cursor:
    def __init__(self, rows):
        self.rows = [tuple(row.values()) for row in rows]

    def fetchone(self):
        return self.rows.pop(0) if self.rows else None

    def fetchall(self):
        result, self.rows = self.rows, []
        return result


class Connection:
    def __init__(self, path):
        self.path = path
        self.total_changes = 0

    def _run(self, statements):
        script = ";\n".join(statements) + ";\nSELECT total_changes() AS __api_mocks_changes;\n"
        result = subprocess.run(["/usr/bin/sqlite3", "-batch", "-bail", "-json", "-cmd", ".timeout 5000", self.path], input=script, encoding="utf-8", stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False)
        if result.returncode:
            raise ValueError("SQLite 操作失败: " + result.stderr.strip())
        decoder = json.JSONDecoder()
        remainder = result.stdout.strip()
        blocks = []
        while remainder:
            block, end = decoder.raw_decode(remainder)
            blocks.append(block)
            remainder = remainder[end:].lstrip()
        if blocks:
            self.total_changes += blocks[-1][0]["__api_mocks_changes"]
        rows = blocks[-2] if len(blocks) >= 2 else []
        return Cursor(rows)

    def execute(self, sql, parameters=()):
        return self._run([_bind(sql, parameters)])

    def executemany(self, sql, parameters):
        statements = [_bind(sql, row) for row in parameters]
        if not statements:
            return Cursor([])
        return self._run(["BEGIN IMMEDIATE", *statements, "COMMIT"])

    def commit(self):
        pass

    def close(self):
        pass


def connect(path):
    return Connection(path)
