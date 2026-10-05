import os
import re
import json
import html
import base64
import string
import random
import asyncio
import logging
import secrets
import binascii
import urllib.parse
import aiohttp
from aiohttp import web

# ---------------- LOGGING ----------------
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger("bot")

# ---------------- CONFIG ----------------
BOT_TOKEN = os.environ.get("BOT_TOKEN", "")

WORKER_BASE_URL = os.environ.get("WORKER_BASE_URL", "https://my-worker.dev")
RENDER_APP_BASE_URL = os.environ.get("RENDER_APP_BASE_URL", "https://my-render-app.onrender.com")
PORT = int(os.environ.get("PORT", "8080"))

# shrinkme.io URL shortener API key
SHRINKME_API_KEY = os.environ.get("SHRINKME_API_KEY", "")
SHRINKME_API_URL = "https://shrinkme.io/api"

# Secret used both to build an unguessable webhook path AND as Telegram's
# secret_token header, so random POSTs to /webhook/* can't spoof updates.
WEBHOOK_SECRET = os.environ.get("WEBHOOK_SECRET", secrets.token_urlsafe(24))
WEBHOOK_PATH = f"/webhook/{WEBHOOK_SECRET}"

TG_API = f"https://api.telegram.org/bot{BOT_TOKEN}"

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DL_HTML_PATH = os.path.join(BASE_DIR, "dl.html")
SETTINGS_PATH = os.path.join(BASE_DIR, "settings.json")

URL_REGEX = re.compile(r"^https?://\S+$", re.IGNORECASE)

# Matches any /watch/<id> link regardless of domain, plus an optional query string.
# Group 1 = domain, Group 2 = short id, Group 3 = query string (without "?") or None.
FILETOLINK_URL_REGEX = re.compile(r"https?://([a-zA-Z0-9.-]+)/watch/([A-Za-z0-9_-]+)(?:\?(\S*))?")

# Only characters that can legitimately appear in a hostname (same set the
# FILETOLINK_URL_REGEX domain group allows).
DOMAIN_REGEX = re.compile(r"[a-zA-Z0-9.-]+")

DEFAULT_FALLBACK_FILENAME = "Video.mkv"

# ---------------- SETTINGS / CLEANER CONFIG ----------------
SETTINGS_BUTTON_TEXT = "⚙️ Settings"
MAIN_REPLY_KEYBOARD = {
    "keyboard": [[{"text": SETTINGS_BUTTON_TEXT}]],
    "resize_keyboard": True,
    "is_persistent": True,
}

CB_SET_PREFIX = "set_prefix"
CB_SET_BLACKLIST = "set_blacklist"
CB_CLEAR_PREFIX = "clear_prefix"
CB_REMOVE_BLACKLIST_WORD = "remove_blacklist_word"

STATE_AWAIT_PREFIX = "await_prefix"
STATE_AWAIT_BLACKLIST = "await_blacklist"
STATE_AWAIT_REMOVE_BLACKLIST = "await_remove_blacklist"

MAX_PREFIX_LEN = 100
MAX_BLACKLIST_ENTRIES = 50
MAX_BLACKLIST_ENTRY_LEN = 40

CLEAR_WORDS = {"none", "clear", "off", "remove", "delete", "-"}

# Any word starting with @ (e.g. @123_321, @kirankiss). Not matched when glued
# to a preceding letter/digit (emails like a@b.com) or to a "/" (URLs like
# medium.com/@user), so those are left alone. Used on FILE NAMES only.
USERNAME_REGEX = re.compile(r"(?<![A-Za-z0-9/])@[A-Za-z0-9_]+")

# Empty bracket pairs left behind after a removal, e.g. "[@user]" -> "[]".
EMPTY_BRACKETS_REGEX = re.compile(r"\[[\s_.\-]*\]|\([\s_.\-]*\)|\{[\s_.\-]*\}")

# Decides if a blacklist entry is URL/domain-like or a plain word (plain words
# are removed on word boundaries).
URLISH_REGEX = re.compile(r"^(?:https?://|www\.)|/|^[^\s/]+\.[A-Za-z]{2,}$", re.IGNORECASE)

# In-memory state: user_id -> pending URL waiting for a filename
pending_urls = {}

# In-memory state: user_id -> which settings input the bot is waiting for
user_states = {}

_session: aiohttp.ClientSession | None = None


async def get_session() -> aiohttp.ClientSession:
    global _session
    if _session is None or _session.closed:
        _session = aiohttp.ClientSession()
    return _session


async def tg_call(method: str, payload: dict) -> dict:
    session = await get_session()
    async with session.post(
        f"{TG_API}/{method}", json=payload, timeout=aiohttp.ClientTimeout(total=20)
    ) as resp:
        data = await resp.json()
        if not data.get("ok"):
            logger.warning(f"[TG API] {method} failed: {data}")
        return data


async def send_message(chat_id: int, text: str, reply_markup: dict | None = None):
    payload = {"chat_id": chat_id, "text": text, "parse_mode": "HTML"}
    if reply_markup:
        payload["reply_markup"] = reply_markup
    return await tg_call("sendMessage", payload)


async def edit_message(chat_id: int, message_id: int, text: str, reply_markup: dict | None = None):
    payload = {"chat_id": chat_id, "message_id": message_id, "text": text, "parse_mode": "HTML"}
    if reply_markup:
        payload["reply_markup"] = reply_markup
    return await tg_call("editMessageText", payload)


async def copy_message(
    chat_id: int,
    from_chat_id: int,
    message_id: int,
    caption: str | None = None,
    reply_markup: dict | None = None,
):
    payload = {
        "chat_id": chat_id,
        "from_chat_id": from_chat_id,
        "message_id": message_id,
        "parse_mode": "HTML",
    }
    # Omitting "caption" tells Telegram to keep the original caption, so we
    # only include it when we actually have a (possibly rewritten) one.
    if caption is not None:
        payload["caption"] = caption
    if reply_markup:
        payload["reply_markup"] = reply_markup
    return await tg_call("copyMessage", payload)


def gen_short_id(length: int = 8) -> str:
    chars = string.ascii_letters + string.digits
    return "".join(random.choice(chars) for _ in range(length))


async def set_webhook():
    webhook_url = f"{RENDER_APP_BASE_URL}{WEBHOOK_PATH}"
    result = await tg_call(
        "setWebhook",
        {
            "url": webhook_url,
            "secret_token": WEBHOOK_SECRET,
            "drop_pending_updates": True,
            "allowed_updates": ["message", "channel_post", "callback_query"],
        },
    )
    logger.info(f"[SET WEBHOOK] url={webhook_url} result={result}")

    info = await tg_call("getWebhookInfo", {})
    logger.info(f"[WEBHOOK INFO] {info}")


# ---------------- URL SHORTENING ----------------

async def shrink_url(long_url: str) -> str:
    """Call shrinkme.io and return the shortened URL, or the original URL on failure."""
    if not SHRINKME_API_KEY:
        logger.warning("[SHRINKME] No API key configured, skipping shortening")
        return long_url

    params = {"api": SHRINKME_API_KEY, "url": long_url}
    session = await get_session()
    try:
        async with session.get(
            SHRINKME_API_URL, params=params, timeout=aiohttp.ClientTimeout(total=15)
        ) as resp:
            data = await resp.json(content_type=None)
    except Exception as e:
        logger.warning(f"[SHRINKME] Request failed: {e}")
        return long_url

    shortened = data.get("shortenedUrl")
    if not shortened:
        logger.warning(f"[SHRINKME] Unexpected response: {data}")
        return long_url

    return shortened


# ---------------- STEALTH MODE (BASE64 DOMAIN) ----------------

def encode_domain(domain: str) -> str:
    """URL-safe base64 of the domain, with '=' padding stripped (re-added on decode)."""
    return base64.urlsafe_b64encode(domain.encode("utf-8")).decode("ascii").rstrip("=")


def decode_domain(value: str) -> str | None:
    """Reverse of encode_domain. Returns None if the value isn't a valid hostname."""
    try:
        padded = value + "=" * (-len(value) % 4)
        decoded = base64.urlsafe_b64decode(padded.encode("ascii")).decode("utf-8")
    except (binascii.Error, UnicodeError, ValueError):
        return None

    decoded = decoded.strip()
    if decoded and DOMAIN_REGEX.fullmatch(decoded):
        return decoded
    return None


# ---------------- USER SETTINGS (settings.json) ----------------

_settings_cache: dict | None = None


def _load_settings() -> dict:
    global _settings_cache
    if _settings_cache is not None:
        return _settings_cache

    data: dict = {}
    try:
        with open(SETTINGS_PATH, "r", encoding="utf-8") as f:
            loaded = json.load(f)
        if isinstance(loaded, dict):
            data = loaded
    except FileNotFoundError:
        pass
    except (OSError, ValueError) as e:
        logger.warning(f"[SETTINGS] Could not read {SETTINGS_PATH}: {e}")

    _settings_cache = data
    return data


def _save_settings(data: dict) -> bool:
    tmp_path = SETTINGS_PATH + ".tmp"
    try:
        with open(tmp_path, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        os.replace(tmp_path, SETTINGS_PATH)
        return True
    except OSError as e:
        logger.error(f"[SETTINGS] Could not write {SETTINGS_PATH}: {e}")
        return False


def get_user_settings(user_id) -> dict:
    """Returns {"prefix": str, "blacklist": list[str]} for a user (safe defaults if unset)."""
    entry = _load_settings().get(str(user_id), {})
    if not isinstance(entry, dict):
        entry = {}

    prefix = entry.get("prefix", "")
    if not isinstance(prefix, str):
        prefix = ""

    raw_blacklist = entry.get("blacklist", [])
    if not isinstance(raw_blacklist, list):
        raw_blacklist = []
    blacklist = [w for w in raw_blacklist if isinstance(w, str) and w.strip()]

    return {"prefix": prefix.strip(), "blacklist": blacklist}


def update_user_settings(user_id, **changes) -> bool:
    """Updates a user's settings in memory and on disk. Returns False if the disk write failed."""
    data = _load_settings()
    entry = data.get(str(user_id))
    if not isinstance(entry, dict):
        entry = {}
    entry.update(changes)
    data[str(user_id)] = entry
    return _save_settings(data)


# ---------------- FILE NAME CLEANER ----------------

def remove_blacklisted(text: str, blacklist: list[str]) -> str:
    """
    Removes blacklisted words/URLs from a file name (case-insensitive).
    Plain words are matched on word boundaries, where "_", ".", "-" and spaces
    all count as boundaries (so "Movie_TamilMV_1080p" works). URL/domain-like
    entries are removed as the exact matched text.
    """
    for entry in sorted(blacklist, key=len, reverse=True):
        if not entry:
            continue
        escaped = re.escape(entry)
        if URLISH_REGEX.search(entry):
            pattern = escaped
        else:
            pattern = rf"(?<![^\W_]){escaped}(?![^\W_])"
        text = re.sub(pattern, "", text, flags=re.IGNORECASE)
    return text


def tidy_name(text: str) -> str:
    """Cleans leftovers (empty brackets, double spaces, doubled underscores) from a filename stem."""
    text = EMPTY_BRACKETS_REGEX.sub("", text)
    text = re.sub(r"[ _]{2,}", lambda m: "_" if "_" in m.group(0) else " ", text)
    text = re.sub(r"\.{2,}", ".", text)
    text = re.sub(r"\s{2,}", " ", text)
    return text.strip(" \t_.-")


def clean_file_name(file_name: str, settings: dict) -> str:
    """
    Pipeline for the file name:
      1) remove @usernames, 2) remove blacklisted words, 3) tidy leftovers,
      4) prepend the auto prefix. The extension is never touched.
    """
    name = file_name or ""
    stem, ext = name, ""
    root, suffix = os.path.splitext(name)
    if root and re.fullmatch(r"\.[A-Za-z0-9]{1,5}", suffix):
        stem, ext = root, suffix

    cleaned = USERNAME_REGEX.sub("", stem)
    cleaned = remove_blacklisted(cleaned, settings["blacklist"])
    if cleaned != stem:
        cleaned = tidy_name(cleaned)
    stem = cleaned

    prefix = re.sub(r'[\\/:*?"<>|\x00-\x1f]', "", settings["prefix"]).strip()
    if prefix:
        stem = f"{prefix} {stem}".strip()

    if not stem:
        stem = "Video"

    result = stem + ext
    # Path separators / control characters never belong in a file name.
    result = re.sub(r"[\\/\x00-\x1f]", "", result)
    return result or DEFAULT_FALLBACK_FILENAME


# ---------------- SETTINGS MENU UI ----------------

def is_settings_request(text: str) -> bool:
    normalized = text.replace("\ufe0f", "").strip().lower()
    return (
        normalized in {"⚙ settings", "settings", "/settings"}
        or normalized.startswith("/settings@")
    )


def parse_blacklist_input(raw: str) -> list[str]:
    """Comma/newline separated entries (phrases allowed); plain whitespace-separated if neither is used."""
    raw = raw.strip()
    if raw.lower() in CLEAR_WORDS:
        return []

    if re.search(r"[,\n]", raw):
        parts = re.split(r"[,\n]+", raw)
    else:
        parts = raw.split()

    seen = set()
    entries = []
    for part in parts:
        part = part.strip()[:MAX_BLACKLIST_ENTRY_LEN]
        if not part:
            continue
        key = part.lower()
        if key in seen:
            continue
        seen.add(key)
        entries.append(part)
        if len(entries) >= MAX_BLACKLIST_ENTRIES:
            break
    return entries


async def send_settings_menu(chat_id: int, user_id: int):
    settings = get_user_settings(user_id)

    prefix_display = html.escape(settings["prefix"]) if settings["prefix"] else "<i>not set</i>"

    if settings["blacklist"]:
        joined = ", ".join(settings["blacklist"])
        if len(joined) > 700:
            joined = joined[:700] + "…"
        blacklist_display = html.escape(joined)
    else:
        blacklist_display = "<i>not set</i>"

    text = (
        "⚙️ <b>Settings</b>\n\n"
        f"<b>Auto Prefix:</b> {prefix_display}\n"
        f"<b>Blacklist:</b> {blacklist_display}"
    )
    reply_markup = {
        "inline_keyboard": [
            [{"text": "Set Auto Prefix", "callback_data": CB_SET_PREFIX}],
            [{"text": "Set Blacklist Words", "callback_data": CB_SET_BLACKLIST}],
            [{"text": "🗑 Clear Auto Prefix", "callback_data": CB_CLEAR_PREFIX}],
            [{"text": "➖ Remove Blacklist Word", "callback_data": CB_REMOVE_BLACKLIST_WORD}],
        ]
    }
    await send_message(chat_id, text, reply_markup)


async def handle_callback_query(callback_query: dict):
    callback_id = callback_query.get("id")
    user_id = (callback_query.get("from") or {}).get("id")
    data = callback_query.get("data")
    chat_id = ((callback_query.get("message") or {}).get("chat") or {}).get("id")

    # Always acknowledge, otherwise the button shows a loading spinner.
    if callback_id:
        await tg_call("answerCallbackQuery", {"callback_query_id": callback_id})

    if user_id is None or chat_id is None:
        return

    if data == CB_SET_PREFIX:
        pending_urls.pop(user_id, None)
        user_states[user_id] = STATE_AWAIT_PREFIX
        await send_message(
            chat_id,
            "Send me the text to use as <b>Auto Prefix</b> (added to the start of file names).\n\n"
            "Send <code>none</code> to remove it, or /cancel to keep the current one.",
        )
    elif data == CB_SET_BLACKLIST:
        pending_urls.pop(user_id, None)
        user_states[user_id] = STATE_AWAIT_BLACKLIST
        await send_message(
            chat_id,
            "Send me the <b>Blacklist words/URLs</b> to remove from file names, "
            "separated by commas or new lines.\n\n"
            "This replaces your current list. Send <code>none</code> to clear it, or /cancel to keep it.",
        )
    elif data == CB_CLEAR_PREFIX:
        saved = update_user_settings(user_id, prefix="")
        reply = "✅ Auto Prefix cleared."
        if not saved:
            reply += "\n\n⚠️ Couldn't write to disk, so this may be lost when the bot restarts."
        await send_message(chat_id, reply)
    elif data == CB_REMOVE_BLACKLIST_WORD:
        pending_urls.pop(user_id, None)
        user_states[user_id] = STATE_AWAIT_REMOVE_BLACKLIST
        await send_message(
            chat_id,
            "Send the exact word/URL you want to remove from your blacklist.",
        )


async def handle_settings_input(chat_id: int, user_id: int, state: str, text: str):
    if state == STATE_AWAIT_PREFIX:
        value = " ".join(text.split())
        if value.lower() in CLEAR_WORDS:
            saved = update_user_settings(user_id, prefix="")
            reply = "✅ Auto Prefix removed."
        else:
            trimmed = len(value) > MAX_PREFIX_LEN
            value = value[:MAX_PREFIX_LEN].strip()
            saved = update_user_settings(user_id, prefix=value)
            reply = f"✅ Auto Prefix saved: <b>{html.escape(value)}</b>"
            if trimmed:
                reply += f"\n(Trimmed to {MAX_PREFIX_LEN} characters.)"
    elif state == STATE_AWAIT_BLACKLIST:
        entries = parse_blacklist_input(text)
        saved = update_user_settings(user_id, blacklist=entries)
        if entries:
            shown = ", ".join(entries)
            if len(shown) > 700:
                shown = shown[:700] + "…"
            reply = f"✅ Blacklist saved ({len(entries)}): {html.escape(shown)}"
        else:
            reply = "✅ Blacklist cleared."
    elif state == STATE_AWAIT_REMOVE_BLACKLIST:
        target = text.strip()
        target_display = html.escape(target[:100])
        current = get_user_settings(user_id)["blacklist"]
        remaining = [w for w in current if w.lower() != target.lower()]

        if len(remaining) == len(current):
            await send_message(chat_id, f"❌ <b>{target_display}</b> was not found in your blacklist.")
            return

        saved = update_user_settings(user_id, blacklist=remaining)
        reply = f"✅ Removed <b>{target_display}</b> from your blacklist."
    else:
        return

    if not saved:
        reply += "\n\n⚠️ Couldn't write to disk, so this may be lost when the bot restarts."

    await send_message(chat_id, reply)


# ---------------- FILE-TO-LINK MESSAGE HANDLING ----------------

def extract_media_file_name(message: dict) -> str | None:
    """Pull the original file name straight from the media's own metadata."""
    document = message.get("document")
    if document and document.get("file_name"):
        return document["file_name"]

    video = message.get("video")
    if video and video.get("file_name"):
        return video["file_name"]

    return None


def has_media(message: dict) -> bool:
    return bool(
        message.get("document") or message.get("video") or message.get("photo")
    )


async def handle_filetolink_message(message: dict):
    """
    Processes a message/caption that contains one or more /watch/<id> links:
      - cleans ONLY the file name (@usernames, blacklist, auto prefix) used to
        build the watch URL,
      - builds a fresh watch URL using that file name (or a fallback for plain
        text), hiding the external domain as base64,
      - preserves any original query string (e.g. ?hash=...) of the link,
      - shortens it via shrinkme.io,
      - swaps ONLY the matched link for the shortened URL; the rest of the
        caption/message text is kept exactly as received (no cleaning),
      - reposts the payload (copying media, or sending plain text) with an
        inline "Watch online & Download" button.
    """
    chat = message.get("chat", {})
    chat_id = chat.get("id")
    message_id = message.get("message_id")
    if chat_id is None or message_id is None:
        return

    is_media = has_media(message)
    original_text = message.get("caption") if is_media else message.get("text")
    original_text = original_text or ""

    match = FILETOLINK_URL_REGEX.search(original_text)
    if not match:
        return

    extracted_domain = match.group(1)
    short_id = match.group(2)

    user_id = (message.get("from") or {}).get("id")
    settings = get_user_settings(user_id)

    # --- File name cleaning (usernames -> blacklist -> tidy -> prefix) ---
    raw_file_name = extract_media_file_name(message) or DEFAULT_FALLBACK_FILENAME
    file_name = clean_file_name(raw_file_name, settings)
    encoded_name = urllib.parse.quote_plus(file_name)

    # Stealth mode: the external domain is never sent in plain text.
    b64_domain = encode_domain(extracted_domain)

    # External domain Workers don't run the /watch/ HTML proxy themselves, so
    # the link points at the central proxy worker (WORKER_BASE_URL), passing
    # the (base64-hidden) external domain through explicitly so Render can
    # build a /dl/ link back to it.
    orig_query = match.group(3) or ""

    base_url = f"{WORKER_BASE_URL}/watch/{short_id}?name={encoded_name}&b64_domain={b64_domain}"
    if orig_query:
        base_url += f"&orig_query={urllib.parse.quote_plus(orig_query)}"

    shortened_url = await shrink_url(base_url)

    # The caption/message text is NOT cleaned or modified in any way. Only the
    # matched link is replaced by the shortened URL. The text before and after
    # the link is HTML-escaped (required by parse_mode HTML so stray < or &
    # don't break the message) but otherwise kept exactly as received.
    before_link = html.escape(original_text[: match.start()])
    after_link = html.escape(original_text[match.end():])
    new_text = f"{before_link}{html.escape(shortened_url, quote=False)}{after_link}"

    reply_markup = {
        "inline_keyboard": [[{"text": "Watch online & Download", "url": base_url}]]
    }

    if is_media:
        await copy_message(
            chat_id=chat_id,
            from_chat_id=chat_id,
            message_id=message_id,
            caption=new_text,
            reply_markup=reply_markup,
        )
    else:
        await send_message(chat_id, new_text, reply_markup)


# ---------------- UPDATE HANDLING ----------------

async def handle_message(message: dict):
    chat = message.get("chat", {})
    chat_id = chat.get("id")
    from_user = message.get("from", {})
    user_id = from_user.get("id")
    text = (message.get("text") or "").strip()
    caption = (message.get("caption") or "").strip()

    if chat_id is None or user_id is None:
        return

    logger.info(f"[MESSAGE] user_id={user_id} text={text!r}")

    # Route messages/captions that already contain a /watch/<id> link to the
    # dedicated file-to-link handler, regardless of domain.
    if FILETOLINK_URL_REGEX.search(text) or FILETOLINK_URL_REGEX.search(caption):
        # The user moved on from any pending settings prompt.
        user_states.pop(user_id, None)
        await handle_filetolink_message(message)
        return

    command = ""
    if text.startswith("/"):
        command = text.split(maxsplit=1)[0].split("@")[0].lower()

    # Settings menu (reply keyboard button or /settings)
    if is_settings_request(text):
        pending_urls.pop(user_id, None)
        user_states.pop(user_id, None)
        await send_settings_menu(chat_id, user_id)
        return

    if text.startswith("/start"):
        pending_urls.pop(user_id, None)
        user_states.pop(user_id, None)
        await send_message(
            chat_id,
            "Send me a direct URL to begin.\n\nUse <b>⚙️ Settings</b> to set an auto prefix and blacklist words.",
            MAIN_REPLY_KEYBOARD,
        )
        return

    if command == "/cancel":
        had_state = user_states.pop(user_id, None) is not None
        had_pending = pending_urls.pop(user_id, None) is not None
        await send_message(chat_id, "Cancelled." if (had_state or had_pending) else "Nothing to cancel.")
        return

    # Waiting for a settings value (prefix / blacklist)
    state = user_states.get(user_id)
    if state and text:
        user_states.pop(user_id, None)
        await handle_settings_input(chat_id, user_id, state, text)
        return

    # Case 1: user is replying with a filename for a previously sent URL
    if user_id in pending_urls:
        url = pending_urls.pop(user_id)
        filename = text.strip()

        if not filename:
            pending_urls[user_id] = url
            await send_message(chat_id, "Filename can't be empty. Please enter a valid filename (with extension).")
            return

        # Apply the user's cleaners (@usernames, blacklist) and Auto Prefix to
        # the manually typed filename before it is registered / URL-encoded.
        settings = get_user_settings(user_id)
        filename = clean_file_name(filename, settings)

        status = await send_message(chat_id, "Registering your link, please wait...")
        status_message_id = status.get("result", {}).get("message_id")

        try:
            short_id = await register_link(url, filename)
        except Exception as e:
            if status_message_id:
                await edit_message(chat_id, status_message_id, f"Failed to register link: {e}")
            else:
                await send_message(chat_id, f"Failed to register link: {e}")
            return

        encoded_name = urllib.parse.quote_plus(filename)
        # The Worker now proxies /watch/ (fetching dl.html from Render
        # server-side), so the link handed to the user is the Worker's own
        # domain — Render is never exposed to the browser.
        watch_url = f"{WORKER_BASE_URL}/watch/{short_id}?name={encoded_name}"

        # The shortened link is used ONLY in the message text. The inline
        # button below keeps the direct Worker watch_url.
        shortened_url = await shrink_url(watch_url)

        reply_markup = {
            "inline_keyboard": [[{"text": "▶️ Watch / Download", "url": watch_url}]]
        }

        final_text = f"Your link is ready!\n\n<b>Filename:</b> {html.escape(filename)}\n<b>Link:</b> {shortened_url}"
        if status_message_id:
            await edit_message(chat_id, status_message_id, final_text, reply_markup)
        else:
            await send_message(chat_id, final_text, reply_markup)
        return

    # Case 2: user is sending a fresh URL
    if URL_REGEX.match(text):
        pending_urls[user_id] = text
        await send_message(chat_id, "Please enter the custom filename (with extension).")
        return

    # Case 3: not a URL, and no pending state
    await send_message(chat_id, "Please send a valid direct URL to begin.")


async def register_link(url: str, name: str) -> str:
    endpoint = f"{WORKER_BASE_URL}/api/add"
    payload = {"url": url, "name": name}

    session = await get_session()
    async with session.post(endpoint, json=payload, timeout=aiohttp.ClientTimeout(total=20)) as resp:
        if resp.status != 200:
            body = await resp.text()
            raise RuntimeError(f"Worker returned {resp.status}: {body}")
        data = await resp.json()
        short_id = data.get("id")
        if not short_id:
            raise RuntimeError(f"Worker response missing 'id': {data}")
        return short_id


# ---------------- WEB SERVER ----------------

async def webhook_handler(request: web.Request) -> web.Response:
    # Verify the secret token Telegram sends back, so only real Telegram
    # requests (matching what we set in setWebhook) are processed.
    incoming_secret = request.headers.get("X-Telegram-Bot-Api-Secret-Token")
    if incoming_secret != WEBHOOK_SECRET:
        logger.warning("[WEBHOOK] Rejected request with bad/missing secret token")
        return web.Response(status=403, text="Forbidden")

    try:
        update = await request.json()
    except Exception:
        return web.Response(status=400, text="Bad Request")

    logger.info(f"[UPDATE RECEIVED] {update.get('update_id')}")

    callback_query = update.get("callback_query")
    if callback_query:
        try:
            await handle_callback_query(callback_query)
        except Exception as e:
            logger.exception(f"[HANDLE_CALLBACK ERROR] {e}")

    message = update.get("message") or update.get("channel_post")
    if message:
        try:
            await handle_message(message)
        except Exception as e:
            logger.exception(f"[HANDLE_MESSAGE ERROR] {e}")

    # Always 200 quickly, or Telegram will retry/backoff this update.
    return web.Response(status=200, text="OK")


async def watch_handler(request: web.Request) -> web.Response:
    short_id = request.match_info.get("id", "")

    if not short_id:
        return web.Response(status=400, text="Missing ID")

    raw_name = request.query.get("name", "Video.mp4")
    filename = urllib.parse.unquote_plus(raw_name)

    try:
        with open(DL_HTML_PATH, "r", encoding="utf-8") as f:
            template = f.read()
    except FileNotFoundError:
        return web.Response(status=500, text="dl.html template not found on server")

    # Stealth mode: the external domain arrives base64-encoded (b64_domain).
    # The old plain "domain" param is still accepted so links already posted
    # keep working. Either way the value must be a valid hostname.
    target_domain = None
    b64_domain = request.query.get("b64_domain")
    if b64_domain:
        target_domain = decode_domain(b64_domain)
        if not target_domain:
            return web.Response(status=400, text="Invalid domain parameter")
    else:
        legacy_domain = request.query.get("domain")
        if legacy_domain:
            if not DOMAIN_REGEX.fullmatch(legacy_domain):
                return web.Response(status=400, text="Invalid domain parameter")
            target_domain = legacy_domain

    if target_domain:
        # Forwarded links now go THROUGH our Worker (/ext/), so the Worker can
        # force the custom filename via Content-Disposition. The external
        # domain stays hidden (base64) and the original query string (e.g.
        # hash=...) is passed along as "oq".
        orig_query = (request.query.get("orig_query") or "").lstrip("?").strip()

        ext_base = f"{WORKER_BASE_URL}/ext/{encode_domain(target_domain)}/{short_id}"
        common = f"?name={urllib.parse.quote_plus(filename)}"
        if orig_query:
            common += f"&oq={urllib.parse.quote_plus(orig_query)}"

        stream_url = f"{ext_base}{common}"
        download_url = f"{ext_base}{common}&dl=1"
    else:
        # Manual registered links use /stream/ for streaming, and ?dl=1 to
        # force a download disposition instead of inline playback.
        stream_url = f"{WORKER_BASE_URL}/stream/{short_id}"
        download_url = f"{WORKER_BASE_URL}/stream/{short_id}?dl=1"

    try:
        # Values are HTML-escaped so a crafted ?name= can't inject markup.
        rendered = template % (
            html.escape(filename),
            html.escape(filename),
            html.escape(stream_url),
            html.escape(download_url),
            "Download",
        )
    except TypeError as e:
        return web.Response(status=500, text=f"Template formatting error: {e}")

    return web.Response(text=rendered, content_type="text/html")


async def health_handler(request: web.Request) -> web.Response:
    return web.Response(text="OK")


def build_web_app() -> web.Application:
    app = web.Application()
    app.router.add_post(WEBHOOK_PATH, webhook_handler)
    app.router.add_get("/watch/{id}", watch_handler)
    app.router.add_get("/health", health_handler)
    return app


async def run_web_server():
    app = build_web_app()
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "0.0.0.0", PORT)
    await site.start()
    logger.info(f"Web server running on port {PORT}")


async def keepalive_loop():
    await asyncio.sleep(15)
    url = f"{RENDER_APP_BASE_URL}/health"
    session = await get_session()
    while True:
        try:
            async with session.get(url, timeout=aiohttp.ClientTimeout(total=15)) as resp:
                logger.info(f"[KEEPALIVE] pinged {url} -> {resp.status}")
        except Exception as e:
            logger.warning(f"[KEEPALIVE] ping failed: {e}")
        await asyncio.sleep(600)


async def main():
    await run_web_server()
    await set_webhook()
    logger.info("Webhook set. Waiting for updates...")
    asyncio.create_task(keepalive_loop())
    while True:
        await asyncio.sleep(3600)


if __name__ == "__main__":
    asyncio.run(main())
