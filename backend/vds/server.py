#!/usr/bin/env python3
import json
import os
import secrets
import sqlite3
import threading
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse


HOST = os.getenv("YT_VALHALLA_HOST", "127.0.0.1")
PORT = int(os.getenv("YT_VALHALLA_PORT", "8787"))
ADMIN_KEY = os.environ["YT_VALHALLA_ADMIN_KEY"]
CLIENT_KEY = os.environ["YT_VALHALLA_CLIENT_KEY"]
ALLOWED_ORIGIN = os.getenv(
    "YT_VALHALLA_ALLOWED_ORIGIN",
    "https://frishkamarath-afk.github.io",
)
DB_PATH = Path(os.getenv("YT_VALHALLA_DB", "/var/lib/yt-valhalla/mod-control.db"))
DEFAULT_DISABLED_MESSAGE = "Мод временно отключён администратором."
MAX_LOGS = 1000
LOG_PAGE_SIZE = 200

DB_PATH.parent.mkdir(parents=True, exist_ok=True)
DB_LOCK = threading.Lock()


def now_iso():
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def connect_db():
    connection = sqlite3.connect(str(DB_PATH), timeout=10)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA journal_mode=WAL")
    connection.execute("PRAGMA foreign_keys=ON")
    return connection


def initialize_db():
    with DB_LOCK, connect_db() as connection:
        connection.executescript(
            """
            CREATE TABLE IF NOT EXISTS settings (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                enabled INTEGER NOT NULL DEFAULT 1,
                disabled_message TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS launch_logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp TEXT NOT NULL,
                public_ip TEXT NOT NULL,
                install_id TEXT NOT NULL,
                os_name TEXT NOT NULL,
                os_version TEXT NOT NULL,
                os_arch TEXT NOT NULL,
                java_version TEXT NOT NULL,
                processors INTEGER NOT NULL,
                max_memory_mb INTEGER NOT NULL,
                mod_version TEXT NOT NULL,
                minecraft_version TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS launch_logs_timestamp_idx
                ON launch_logs(timestamp DESC);
            CREATE INDEX IF NOT EXISTS launch_logs_install_idx
                ON launch_logs(install_id, timestamp DESC);
            """
        )
        connection.execute(
            """
            INSERT OR IGNORE INTO settings(id, enabled, disabled_message, updated_at)
            VALUES (1, 1, ?, ?)
            """,
            (DEFAULT_DISABLED_MESSAGE, now_iso()),
        )


def clean(value, maximum):
    text = "" if value is None else str(value)
    text = "".join(" " if ord(char) < 32 or ord(char) == 127 else char for char in text)
    return text.strip()[:maximum]


def bounded_int(value, minimum, maximum):
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return minimum
    return max(minimum, min(maximum, parsed))


def constant_time_equal(left, right):
    return bool(left and right and secrets.compare_digest(str(left), str(right)))


def read_state():
    with DB_LOCK, connect_db() as connection:
        row = connection.execute(
            "SELECT enabled, disabled_message, updated_at FROM settings WHERE id = 1"
        ).fetchone()
        count = connection.execute("SELECT COUNT(*) FROM launch_logs").fetchone()[0]
    return {
        "enabled": bool(row["enabled"]),
        "disabledMessage": row["disabled_message"],
        "updatedAt": row["updated_at"],
        "logCount": count,
    }


def read_logs():
    with DB_LOCK, connect_db() as connection:
        rows = connection.execute(
            """
            SELECT timestamp, public_ip, install_id, os_name, os_version, os_arch,
                   java_version, processors, max_memory_mb, mod_version,
                   minecraft_version
            FROM launch_logs
            ORDER BY id DESC
            LIMIT ?
            """,
            (LOG_PAGE_SIZE,),
        ).fetchall()
    return [
        {
            "timestamp": row["timestamp"],
            "publicIp": row["public_ip"],
            "installId": row["install_id"],
            "osName": row["os_name"],
            "osVersion": row["os_version"],
            "osArch": row["os_arch"],
            "javaVersion": row["java_version"],
            "processors": row["processors"],
            "maxMemoryMb": row["max_memory_mb"],
            "modVersion": row["mod_version"],
            "minecraftVersion": row["minecraft_version"],
        }
        for row in rows
    ]


def set_state(enabled=None, disabled_message=None):
    current = read_state()
    next_enabled = current["enabled"] if enabled is None else bool(enabled)
    next_message = (
        current["disabledMessage"]
        if disabled_message is None
        else clean(disabled_message, 160) or DEFAULT_DISABLED_MESSAGE
    )
    with DB_LOCK, connect_db() as connection:
        connection.execute(
            """
            UPDATE settings
            SET enabled = ?, disabled_message = ?, updated_at = ?
            WHERE id = 1
            """,
            (1 if next_enabled else 0, next_message, now_iso()),
        )
    return read_state()


def client_ip(handler):
    forwarded = handler.headers.get("X-Forwarded-For", "")
    if forwarded:
        return clean(forwarded.split(",", 1)[0], 64)
    return clean(handler.client_address[0], 64)


def append_launch(payload, public_ip):
    install_id = clean(payload.get("installId"), 80)
    if not install_id:
        raise ApiError(400, "BAD_REQUEST", "installId is required")

    with DB_LOCK, connect_db() as connection:
        duplicate = connection.execute(
            """
            SELECT 1
            FROM launch_logs
            WHERE install_id = ?
              AND datetime(timestamp) >= datetime('now', '-5 minutes')
            LIMIT 1
            """,
            (install_id,),
        ).fetchone()
        if not duplicate:
            connection.execute(
                """
                INSERT INTO launch_logs(
                    timestamp, public_ip, install_id, os_name, os_version, os_arch,
                    java_version, processors, max_memory_mb, mod_version,
                    minecraft_version
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    now_iso(),
                    clean(public_ip, 64),
                    install_id,
                    clean(payload.get("osName"), 80),
                    clean(payload.get("osVersion"), 80),
                    clean(payload.get("osArch"), 40),
                    clean(payload.get("javaVersion"), 80),
                    bounded_int(payload.get("processors"), 0, 1024),
                    bounded_int(payload.get("maxMemoryMb"), 0, 1048576),
                    clean(payload.get("modVersion"), 32),
                    clean(payload.get("minecraftVersion"), 32),
                ),
            )
            connection.execute(
                """
                DELETE FROM launch_logs
                WHERE id NOT IN (
                    SELECT id FROM launch_logs ORDER BY id DESC LIMIT ?
                )
                """,
                (MAX_LOGS,),
            )


class ApiError(Exception):
    def __init__(self, status, code, message):
        super().__init__(message)
        self.status = status
        self.code = code


class Handler(BaseHTTPRequestHandler):
    server_version = "YTValhallaModControl/1.0"

    def log_message(self, fmt, *args):
        print(
            f'{self.address_string()} - [{self.log_date_time_string()}] {fmt % args}',
            flush=True,
        )

    def end_headers(self):
        origin = self.headers.get("Origin", "")
        if origin == ALLOWED_ORIGIN or (
            os.getenv("YT_VALHALLA_ALLOW_LOCALHOST", "false") == "true"
            and origin.startswith(("http://localhost:", "http://127.0.0.1:"))
        ):
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
        self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS")
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(204)
        self.end_headers()

    def do_GET(self):
        try:
            parsed = urlparse(self.path)
            if parsed.path == "/health":
                return self.respond(200, {"ok": True, "service": "yt-valhalla-mod-control"})
            if parsed.path == "/api/v1/status":
                params = parse_qs(parsed.query)
                self.require_client(params.get("clientKey", [""])[0])
                state = read_state()
                return self.respond(
                    200,
                    {
                        "ok": True,
                        "enabled": state["enabled"],
                        "disabledMessage": state["disabledMessage"],
                        "checkIntervalSeconds": 300,
                        "serverTime": now_iso(),
                    },
                )
            if parsed.path == "/api/v1/admin/state":
                self.require_admin()
                return self.respond(
                    200,
                    {"ok": True, "state": read_state(), "logs": read_logs()},
                )
            raise ApiError(404, "NOT_FOUND", "Route not found")
        except ApiError as error:
            self.respond(error.status, {"ok": False, "code": error.code, "error": str(error)})
        except Exception:
            self.respond(500, {"ok": False, "code": "INTERNAL", "error": "Internal error"})

    def do_POST(self):
        try:
            if urlparse(self.path).path != "/api/v1/launch":
                raise ApiError(404, "NOT_FOUND", "Route not found")
            body = self.read_json()
            self.require_client(body.get("clientKey"))
            if body.get("consent") is not True:
                raise ApiError(400, "CONSENT_REQUIRED", "Telemetry consent is required")
            append_launch(body, client_ip(self))
            state = read_state()
            self.respond(
                200,
                {
                    "ok": True,
                    "enabled": state["enabled"],
                    "disabledMessage": state["disabledMessage"],
                    "checkIntervalSeconds": 300,
                },
            )
        except ApiError as error:
            self.respond(error.status, {"ok": False, "code": error.code, "error": str(error)})
        except Exception:
            self.respond(500, {"ok": False, "code": "INTERNAL", "error": "Internal error"})

    def do_PATCH(self):
        try:
            if urlparse(self.path).path != "/api/v1/admin/state":
                raise ApiError(404, "NOT_FOUND", "Route not found")
            self.require_admin()
            body = self.read_json()
            state = set_state(
                body.get("enabled") if "enabled" in body else None,
                body.get("disabledMessage") if "disabledMessage" in body else None,
            )
            self.respond(200, {"ok": True, "state": state})
        except ApiError as error:
            self.respond(error.status, {"ok": False, "code": error.code, "error": str(error)})
        except Exception:
            self.respond(500, {"ok": False, "code": "INTERNAL", "error": "Internal error"})

    def do_DELETE(self):
        try:
            if urlparse(self.path).path != "/api/v1/admin/logs":
                raise ApiError(404, "NOT_FOUND", "Route not found")
            self.require_admin()
            with DB_LOCK, connect_db() as connection:
                connection.execute("DELETE FROM launch_logs")
            self.respond(200, {"ok": True})
        except ApiError as error:
            self.respond(error.status, {"ok": False, "code": error.code, "error": str(error)})
        except Exception:
            self.respond(500, {"ok": False, "code": "INTERNAL", "error": "Internal error"})

    def require_client(self, value):
        if not constant_time_equal(value, CLIENT_KEY):
            raise ApiError(401, "UNAUTHORIZED", "Invalid client key")

    def require_admin(self):
        authorization = self.headers.get("Authorization", "")
        value = authorization[7:] if authorization.startswith("Bearer ") else ""
        if not constant_time_equal(value, ADMIN_KEY):
            raise ApiError(401, "UNAUTHORIZED", "Invalid admin key")

    def read_json(self):
        length = bounded_int(self.headers.get("Content-Length"), 0, 65536)
        if length <= 0:
            return {}
        raw = self.rfile.read(length)
        try:
            value = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            raise ApiError(400, "BAD_JSON", "Invalid JSON")
        if not isinstance(value, dict):
            raise ApiError(400, "BAD_JSON", "JSON object required")
        return value

    def respond(self, status, value):
        payload = json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)


if __name__ == "__main__":
    initialize_db()
    print(f"YT Valhalla mod control listening on {HOST}:{PORT}", flush=True)
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
