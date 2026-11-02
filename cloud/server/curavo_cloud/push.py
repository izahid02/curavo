"""
Phone notifications through Expo's push service (free; it hands them to
Google's).  The text is decided by the shop PC and carries counts only - never
money - because a notification passes through Expo and Google readable.
Failures are ignored: a missed notification must never break a check-in.
"""
import json
import logging
import urllib.request

EXPO_URL = "https://exp.host/--/api/v2/push/send"
log = logging.getLogger("curavo.push")


def _send(messages: list):
    req = urllib.request.Request(EXPO_URL, data=json.dumps(messages).encode("utf-8"), method="POST",
                                 headers={"Content-Type": "application/json", "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=10) as r:
        r.read()


# Replaced by the guard test, so nothing leaves the machine there.
sender = _send


def notify(tokens: list, title: str, body: str):
    tokens = [t for t in tokens if t]
    if not tokens:
        return 0
    try:
        sender([{"to": t, "title": title[:80], "body": body[:180], "sound": "default"} for t in tokens])
        return len(tokens)
    except Exception as e:
        log.warning("Push failed: %s", type(e).__name__)
        return 0
