"""Dates as the shop sees them: India (IST, UTC+5:30), whatever the server's own clock zone."""
from datetime import date, datetime, timedelta


def today_ist() -> date:
    return (datetime.utcnow() + timedelta(hours=5, minutes=30)).date()


def add_months(d: date, n: int) -> date:
    """Same day n months later; the 31st becomes the month's last day (31 Jan + 1 = 28/29 Feb)."""
    y, m = divmod(d.month - 1 + n, 12)
    y, m = d.year + y, m + 1
    nxt = date(y + (m == 12), m % 12 + 1, 1)
    return min(d.replace(year=y, month=m, day=1) + timedelta(days=d.day - 1), nxt - timedelta(days=1))
