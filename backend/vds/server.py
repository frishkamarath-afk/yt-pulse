#!/usr/bin/env python3
import json
import hashlib
import os
import secrets
import sqlite3
import threading
import urllib.error
import urllib.request
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse


def telegram_username(value):
    return str(value or "").strip().lstrip("@").lower()


HOST = os.getenv("YT_VALHALLA_HOST", "127.0.0.1")
PORT = int(os.getenv("YT_VALHALLA_PORT", "8787"))
ADMIN_KEY = os.environ["YT_VALHALLA_ADMIN_KEY"]
CLIENT_KEY = os.environ["YT_VALHALLA_CLIENT_KEY"]
DEFAULT_ALLOWED_ORIGIN = os.getenv(
    "YT_VALHALLA_ALLOWED_ORIGIN",
    "https://frishkamarath-afk.github.io",
)
ALLOWED_ORIGINS = {
    origin.strip().rstrip("/")
    for origin in os.getenv("YT_VALHALLA_ALLOWED_ORIGINS", DEFAULT_ALLOWED_ORIGIN).split(",")
    if origin.strip()
}
ALLOW_ANY_HTTPS_ORIGIN = os.getenv(
    "YT_VALHALLA_ALLOW_ANY_HTTPS_ORIGIN",
    "false",
).lower() in ("1", "true", "yes")
DB_PATH = Path(os.getenv("YT_VALHALLA_DB", "/var/lib/yt-valhalla/mod-control.db"))
DEFAULT_DISABLED_MESSAGE = "Мод временно отключён администратором."
CHECK_INTERVAL_SECONDS = int(os.getenv("YT_VALHALLA_CHECK_INTERVAL_SECONDS", "5"))
TELEGRAM_BOT_TOKEN = os.getenv("YT_VALHALLA_TELEGRAM_BOT_TOKEN", "").strip()
TELEGRAM_ADMIN_CHAT_ID = os.getenv("YT_VALHALLA_TELEGRAM_ADMIN_CHAT_ID", "").strip()
TELEGRAM_MODERATOR_CHAT_ID = os.getenv("YT_VALHALLA_TELEGRAM_MODERATOR_CHAT_ID", "").strip()
TELEGRAM_ADMIN_USERNAME = telegram_username(
    os.getenv("YT_VALHALLA_TELEGRAM_ADMIN_USERNAME", "zzshka_dz")
)
TELEGRAM_MODERATOR_USERNAME = telegram_username(
    os.getenv("YT_VALHALLA_TELEGRAM_MODERATOR_USERNAME", "STEPASHIK1")
)
TELEGRAM_CODE_TTL_SECONDS = int(os.getenv("YT_VALHALLA_TELEGRAM_CODE_TTL_SECONDS", "300"))
TELEGRAM_SESSION_TTL_SECONDS = int(
    os.getenv("YT_VALHALLA_TELEGRAM_SESSION_TTL_SECONDS", "43200")
)
TELEGRAM_REQUIRED = os.getenv("YT_VALHALLA_TELEGRAM_REQUIRED", "true").lower() not in (
    "0",
    "false",
    "no",
)
MAX_LOGS = 1000
LOG_PAGE_SIZE = 200
SESSION_LIST_SIZE = 120
ACTIVE_WINDOW_SECONDS = 45

DB_PATH.parent.mkdir(parents=True, exist_ok=True)
DB_LOCK = threading.Lock()


def now_iso():
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def now_seconds():
    return int(datetime.now(timezone.utc).timestamp())


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

            CREATE TABLE IF NOT EXISTS active_sessions (
                install_id TEXT PRIMARY KEY,
                player_name TEXT NOT NULL,
                public_ip TEXT NOT NULL,
                os_name TEXT NOT NULL,
                os_version TEXT NOT NULL,
                os_arch TEXT NOT NULL,
                java_version TEXT NOT NULL,
                processors INTEGER NOT NULL,
                max_memory_mb INTEGER NOT NULL,
                mod_version TEXT NOT NULL,
                minecraft_version TEXT NOT NULL,
                started_at TEXT NOT NULL,
                last_seen TEXT NOT NULL,
                force_disabled INTEGER NOT NULL DEFAULT 0
            );

            CREATE INDEX IF NOT EXISTS active_sessions_last_seen_idx
                ON active_sessions(last_seen DESC);

            CREATE TABLE IF NOT EXISTS telegram_config (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                chat_id TEXT NOT NULL,
                username TEXT NOT NULL DEFAULT '',
                first_name TEXT NOT NULL DEFAULT '',
                configured_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS telegram_codes (
                request_id TEXT PRIMARY KEY,
                role TEXT NOT NULL DEFAULT 'admin',
                code_hash TEXT NOT NULL,
                expires_at INTEGER NOT NULL,
                attempts INTEGER NOT NULL DEFAULT 0,
                consumed INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                public_ip TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS telegram_sessions (
                token_hash TEXT PRIMARY KEY,
                role TEXT NOT NULL DEFAULT 'admin',
                expires_at INTEGER NOT NULL,
                created_at TEXT NOT NULL,
                public_ip TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS telegram_chat_bindings (
                role TEXT PRIMARY KEY,
                chat_id TEXT NOT NULL,
                username TEXT NOT NULL DEFAULT '',
                first_name TEXT NOT NULL DEFAULT '',
                configured_at TEXT NOT NULL
            );
            """
        )
        for table in ("telegram_codes", "telegram_sessions"):
            columns = {
                row["name"]
                for row in connection.execute(f"PRAGMA table_info({table})").fetchall()
            }
            if "role" not in columns:
                connection.execute(
                    f"ALTER TABLE {table} ADD COLUMN role TEXT NOT NULL DEFAULT 'admin'"
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


def origin_is_allowed(origin):
    normalized = str(origin or "").strip().rstrip("/")
    if not normalized:
        return False
    if "*" in ALLOWED_ORIGINS or normalized in ALLOWED_ORIGINS:
        return True
    if ALLOW_ANY_HTTPS_ORIGIN and normalized.startswith("https://"):
        return True
    if (
        os.getenv("YT_VALHALLA_ALLOW_LOCALHOST", "false") == "true"
        and normalized.startswith(("http://localhost:", "http://127.0.0.1:"))
    ):
        return True
    return False


def secret_hash(value):
    payload = f"{ADMIN_KEY}:{value}".encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


def normalize_telegram_role(value):
    role = clean(value, 24).lower()
    if role in ("moderator", "moder", "mod"):
        return "moderator"
    return "admin"


def telegram_role_target(role):
    role = normalize_telegram_role(role)
    if role == "moderator":
        return TELEGRAM_MODERATOR_CHAT_ID, TELEGRAM_MODERATOR_USERNAME
    return TELEGRAM_ADMIN_CHAT_ID, TELEGRAM_ADMIN_USERNAME


def save_telegram_chat(role, chat_id, meta):
    with DB_LOCK, connect_db() as connection:
        connection.execute(
            """
            INSERT OR REPLACE INTO telegram_chat_bindings(role, chat_id, username, first_name, configured_at)
            VALUES (?, ?, ?, ?, ?)
            """,
            (role, chat_id, meta["username"], meta["first_name"], now_iso()),
        )
        if role == "admin":
            connection.execute(
                """
                INSERT OR REPLACE INTO telegram_config(id, chat_id, username, first_name, configured_at)
                VALUES (1, ?, ?, ?, ?)
                """,
                (chat_id, meta["username"], meta["first_name"], now_iso()),
            )


def cleanup_telegram_auth():
    current = now_seconds()
    with DB_LOCK, connect_db() as connection:
        connection.execute(
            "DELETE FROM telegram_codes WHERE expires_at < ? OR consumed = 1",
            (current,),
        )
        connection.execute(
            "DELETE FROM telegram_sessions WHERE expires_at < ?",
            (current,),
        )


def telegram_api(method, payload):
    if not TELEGRAM_BOT_TOKEN:
        raise ApiError(
            503,
            "TELEGRAM_NOT_CONFIGURED",
            "Telegram bot token is not configured on the server",
        )

    request = urllib.request.Request(
        f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/{method}",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            body = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        try:
            body = json.loads(error.read().decode("utf-8"))
        except Exception:
            body = {"description": "Telegram API error"}
        raise ApiError(
            502,
            "TELEGRAM_API_ERROR",
            clean(body.get("description") or "Telegram API error", 240),
        )
    except Exception:
        raise ApiError(502, "TELEGRAM_API_ERROR", "Telegram API is unavailable")

    if not body.get("ok"):
        raise ApiError(
            502,
            "TELEGRAM_API_ERROR",
            clean(body.get("description") or "Telegram API error", 240),
        )
    return body.get("result")


def configured_telegram_chat(role="admin"):
    role = normalize_telegram_role(role)
    explicit_chat_id, target_username = telegram_role_target(role)
    if explicit_chat_id:
        return str(explicit_chat_id)

    with DB_LOCK, connect_db() as connection:
        if target_username:
            row = connection.execute(
                """
                SELECT chat_id
                FROM telegram_chat_bindings
                WHERE role = ? AND lower(username) = ?
                """,
                (role, target_username),
            ).fetchone()
        else:
            row = connection.execute(
                "SELECT chat_id FROM telegram_chat_bindings WHERE role = ?",
                (role,),
            ).fetchone()
            if not row and role == "admin":
                row = connection.execute(
                    "SELECT chat_id FROM telegram_config WHERE id = 1"
                ).fetchone()
        if row:
            return row["chat_id"]

    updates = telegram_api(
        "getUpdates",
        {"limit": 20, "timeout": 0, "allowed_updates": ["message"]},
    )
    chats = {}
    for update in updates or []:
        message = update.get("message") or {}
        chat = message.get("chat") or {}
        if chat.get("type") != "private" or chat.get("id") is None:
            continue
        chat_id = str(chat["id"])
        chats[chat_id] = {
            "username": clean(chat.get("username"), 80),
            "first_name": clean(chat.get("first_name"), 80),
        }

    if not chats:
        raise ApiError(
            409,
            "TELEGRAM_SETUP_REQUIRED",
            "Open the Telegram bot and send /start, then request the code again",
        )

    if target_username:
        matching = [
            (chat_id, meta)
            for chat_id, meta in chats.items()
            if meta["username"].lower() == target_username
        ]
        if not matching:
            raise ApiError(
                409,
                "TELEGRAM_USER_NOT_FOUND",
                f"Telegram user @{target_username} did not write /start to the bot",
            )
        chat_id, meta = matching[-1]
        save_telegram_chat(role, chat_id, meta)
        return chat_id

    if len(chats) > 1:
        raise ApiError(
            409,
            "TELEGRAM_CHAT_AMBIGUOUS",
            "Several Telegram chats wrote to the bot. Set YT_VALHALLA_TELEGRAM_ADMIN_CHAT_ID on the server",
        )

    chat_id, meta = next(iter(chats.items()))
    save_telegram_chat(role, chat_id, meta)
    return chat_id


def create_telegram_code(public_ip, role="admin"):
    cleanup_telegram_auth()
    role = normalize_telegram_role(role)
    chat_id = configured_telegram_chat(role)
    request_id = secrets.token_urlsafe(18)
    code = f"{secrets.randbelow(1000000):06d}"
    expires_at = now_seconds() + TELEGRAM_CODE_TTL_SECONDS
    with DB_LOCK, connect_db() as connection:
        connection.execute(
            """
            INSERT INTO telegram_codes(request_id, role, code_hash, expires_at, attempts, consumed, created_at, public_ip)
            VALUES (?, ?, ?, ?, 0, 0, ?, ?)
            """,
            (request_id, role, secret_hash(f"{request_id}:{code}"), expires_at, now_iso(), public_ip),
        )

    telegram_api(
        "sendMessage",
        {
            "chat_id": chat_id,
            "text": (
                f"YT Valhalla {role} code: "
                f"{code}\n\n"
                f"Expires in {TELEGRAM_CODE_TTL_SECONDS // 60} min.\n"
                f"IP: {public_ip}"
            ),
            "disable_web_page_preview": True,
        },
    )
    return request_id


def verify_telegram_code(request_id, code, public_ip):
    cleanup_telegram_auth()
    clean_request_id = clean(request_id, 80)
    clean_code = "".join(char for char in str(code or "") if char.isdigit())[:8]
    if not clean_request_id or len(clean_code) != 6:
        raise ApiError(400, "BAD_REQUEST", "Six-digit code is required")

    with DB_LOCK, connect_db() as connection:
        row = connection.execute(
            """
            SELECT code_hash, role, expires_at, attempts, consumed
            FROM telegram_codes
            WHERE request_id = ?
            """,
            (clean_request_id,),
        ).fetchone()
        if not row or row["consumed"]:
            raise ApiError(401, "INVALID_CODE", "Invalid or expired code")
        if row["expires_at"] < now_seconds():
            connection.execute(
                "DELETE FROM telegram_codes WHERE request_id = ?",
                (clean_request_id,),
            )
            raise ApiError(410, "CODE_EXPIRED", "Code expired")
        if row["attempts"] >= 5:
            raise ApiError(429, "TOO_MANY_ATTEMPTS", "Too many attempts")

        connection.execute(
            "UPDATE telegram_codes SET attempts = attempts + 1 WHERE request_id = ?",
            (clean_request_id,),
        )
        expected = row["code_hash"]
        actual = secret_hash(f"{clean_request_id}:{clean_code}")
        if not constant_time_equal(actual, expected):
            raise ApiError(401, "INVALID_CODE", "Invalid code")

        token = secrets.token_urlsafe(32)
        expires_at = now_seconds() + TELEGRAM_SESSION_TTL_SECONDS
        connection.execute(
            "UPDATE telegram_codes SET consumed = 1 WHERE request_id = ?",
            (clean_request_id,),
        )
        connection.execute(
            """
            INSERT INTO telegram_sessions(token_hash, role, expires_at, created_at, public_ip)
            VALUES (?, ?, ?, ?, ?)
            """,
            (secret_hash(token), row["role"], expires_at, now_iso(), clean(public_ip, 64)),
        )
    return token, expires_at


def validate_telegram_session(value, allowed_roles=("admin",)):
    cleanup_telegram_auth()
    token = clean(value, 256)
    if not token:
        return False
    roles = tuple(normalize_telegram_role(role) for role in (allowed_roles or ()))
    with DB_LOCK, connect_db() as connection:
        row = connection.execute(
            "SELECT role, expires_at FROM telegram_sessions WHERE token_hash = ?",
            (secret_hash(token),),
        ).fetchone()
    return bool(row and row["expires_at"] >= now_seconds() and (not roles or row["role"] in roles))


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


def client_state_for_install(install_id):
    state = read_state()
    force_disabled = False
    if install_id:
        with DB_LOCK, connect_db() as connection:
            row = connection.execute(
                "SELECT force_disabled FROM active_sessions WHERE install_id = ?",
                (install_id,),
            ).fetchone()
            force_disabled = bool(row["force_disabled"]) if row else False

    enabled = state["enabled"] and not force_disabled
    message = state["disabledMessage"]
    if force_disabled:
        message = "Функции мода отключены администратором для этой сессии."
    return {
        "ok": True,
        "enabled": enabled,
        "disabledMessage": message,
        "checkIntervalSeconds": CHECK_INTERVAL_SECONDS,
        "serverTime": now_iso(),
        "forceDisabled": force_disabled,
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


def read_sessions():
    with DB_LOCK, connect_db() as connection:
        rows = connection.execute(
            """
            SELECT install_id, player_name, public_ip, os_name, os_version, os_arch,
                   java_version, processors, max_memory_mb, mod_version,
                   minecraft_version, started_at, last_seen, force_disabled,
                   CASE
                     WHEN datetime(last_seen) >= datetime('now', ?) THEN 1
                     ELSE 0
                   END AS is_active
            FROM active_sessions
            WHERE datetime(last_seen) >= datetime('now', '-15 minutes')
               OR force_disabled = 1
            ORDER BY is_active DESC, datetime(last_seen) DESC
            LIMIT ?
            """,
            (f"-{ACTIVE_WINDOW_SECONDS} seconds", SESSION_LIST_SIZE),
        ).fetchall()
    return [
        {
            "installId": row["install_id"],
            "playerName": row["player_name"],
            "publicIp": row["public_ip"],
            "osName": row["os_name"],
            "osVersion": row["os_version"],
            "osArch": row["os_arch"],
            "javaVersion": row["java_version"],
            "processors": row["processors"],
            "maxMemoryMb": row["max_memory_mb"],
            "modVersion": row["mod_version"],
            "minecraftVersion": row["minecraft_version"],
            "startedAt": row["started_at"],
            "lastSeen": row["last_seen"],
            "active": bool(row["is_active"]) and not bool(row["force_disabled"]),
            "forceDisabled": bool(row["force_disabled"]),
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


def upsert_session(payload, public_ip, launch=False):
    install_id = clean(payload.get("installId"), 80)
    if not install_id:
        raise ApiError(400, "BAD_REQUEST", "installId is required")

    current_time = now_iso()
    player_name = clean(payload.get("playerName"), 48) or "unknown"
    with DB_LOCK, connect_db() as connection:
        existing = connection.execute(
            "SELECT started_at, force_disabled FROM active_sessions WHERE install_id = ?",
            (install_id,),
        ).fetchone()
        started_at = current_time if launch or not existing else existing["started_at"]
        force_disabled = int(existing["force_disabled"]) if existing else 0
        connection.execute(
            """
            INSERT OR REPLACE INTO active_sessions(
                install_id, player_name, public_ip, os_name, os_version, os_arch,
                java_version, processors, max_memory_mb, mod_version,
                minecraft_version, started_at, last_seen, force_disabled
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                install_id,
                player_name,
                clean(public_ip, 64),
                clean(payload.get("osName"), 80),
                clean(payload.get("osVersion"), 80),
                clean(payload.get("osArch"), 40),
                clean(payload.get("javaVersion"), 80),
                bounded_int(payload.get("processors"), 0, 1024),
                bounded_int(payload.get("maxMemoryMb"), 0, 1048576),
                clean(payload.get("modVersion"), 32),
                clean(payload.get("minecraftVersion"), 32),
                started_at,
                current_time,
                force_disabled,
            ),
        )
    return install_id


def set_session_disabled(install_id, force_disabled):
    clean_install_id = clean(install_id, 80)
    if not clean_install_id:
        raise ApiError(400, "BAD_REQUEST", "installId is required")
    with DB_LOCK, connect_db() as connection:
        row = connection.execute(
            "SELECT 1 FROM active_sessions WHERE install_id = ?",
            (clean_install_id,),
        ).fetchone()
        if not row:
            raise ApiError(404, "NOT_FOUND", "Session not found")
        connection.execute(
            """
            UPDATE active_sessions
            SET force_disabled = ?
            WHERE install_id = ?
            """,
            (1 if force_disabled else 0, clean_install_id),
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
        if origin_is_allowed(origin):
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
        self.send_header(
            "Access-Control-Allow-Headers",
            "Authorization, Content-Type, X-Telegram-Session",
        )
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
                install_id = clean(params.get("installId", [""])[0], 80)
                return self.respond(200, client_state_for_install(install_id))
            if parsed.path == "/api/v1/admin/state":
                self.require_admin()
                return self.respond(
                    200,
                    {
                        "ok": True,
                        "state": read_state(),
                        "logs": read_logs(),
                        "sessions": read_sessions(),
                    },
                )
            if parsed.path == "/api/v1/admin/telegram/session":
                params = parse_qs(parsed.query)
                role = normalize_telegram_role(params.get("role", ["admin"])[0])
                session = self.headers.get("X-Telegram-Session", "")
                if not validate_telegram_session(session, (role,)):
                    raise ApiError(401, "TELEGRAM_REQUIRED", "Telegram verification required")
                return self.respond(200, {"ok": True})
            raise ApiError(404, "NOT_FOUND", "Route not found")
        except ApiError as error:
            self.respond(error.status, {"ok": False, "code": error.code, "error": str(error)})
        except Exception:
            self.respond(500, {"ok": False, "code": "INTERNAL", "error": "Internal error"})

    def do_POST(self):
        try:
            path = urlparse(self.path).path
            if path == "/api/v1/admin/telegram/request":
                body = self.read_json()
                role = normalize_telegram_role(body.get("role"))
                request_id = create_telegram_code(client_ip(self), role)
                return self.respond(
                    200,
                    {
                        "ok": True,
                        "role": role,
                        "requestId": request_id,
                        "expiresInSeconds": TELEGRAM_CODE_TTL_SECONDS,
                    },
                )
            if path == "/api/v1/admin/telegram/verify":
                body = self.read_json()
                token, expires_at = verify_telegram_code(
                    body.get("requestId"),
                    body.get("code"),
                    client_ip(self),
                )
                return self.respond(
                    200,
                    {
                        "ok": True,
                        "sessionToken": token,
                        "expiresAt": expires_at,
                        "expiresInSeconds": TELEGRAM_SESSION_TTL_SECONDS,
                    },
                )
            if path not in ("/api/v1/launch", "/api/v1/heartbeat"):
                raise ApiError(404, "NOT_FOUND", "Route not found")
            body = self.read_json()
            self.require_client(body.get("clientKey"))
            if body.get("consent") is not True:
                raise ApiError(400, "CONSENT_REQUIRED", "Telemetry consent is required")
            public_ip = client_ip(self)
            if path == "/api/v1/launch":
                append_launch(body, public_ip)
            install_id = upsert_session(body, public_ip, launch=path == "/api/v1/launch")
            self.respond(200, client_state_for_install(install_id))
        except ApiError as error:
            self.respond(error.status, {"ok": False, "code": error.code, "error": str(error)})
        except Exception:
            self.respond(500, {"ok": False, "code": "INTERNAL", "error": "Internal error"})

    def do_PATCH(self):
        try:
            path = urlparse(self.path).path
            if path == "/api/v1/admin/session":
                self.require_admin()
                body = self.read_json()
                set_session_disabled(body.get("installId"), bool(body.get("forceDisabled")))
                return self.respond(
                    200,
                    {
                        "ok": True,
                        "state": read_state(),
                        "sessions": read_sessions(),
                    },
                )
            if path != "/api/v1/admin/state":
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
        if TELEGRAM_REQUIRED:
            session = self.headers.get("X-Telegram-Session", "")
            if not validate_telegram_session(session, ("admin", "moderator")):
                raise ApiError(401, "TELEGRAM_REQUIRED", "Telegram verification required")

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
