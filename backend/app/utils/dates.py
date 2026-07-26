"""
dates.py — IST-aware "today" helpers for the backend.

WHY THIS EXISTS (read before touching):
The database (SQLite) timestamps rows with CURRENT_TIMESTAMP, which is **UTC**.
The pharmacy, however, lives in India (IST = UTC+5:30). So "today's sales" means
"sales that happened on today's *IST* calendar day", and that IST day maps to a
UTC window shifted back 5½ hours.

Two traps this module removes:
  1. `date.today()` returns the *server's* local date. On the shop PC that is IST
     (fine), but on a dev Mac / UTC server it is wrong. Use `get_today_ist()`.
  2. Filtering a stored UTC timestamp with `func.date(ts) == date.today()` buckets
     a 10 PM-IST sale (which is the *previous* day in UTC) onto the wrong day.
     Use `ist_day_bounds_utc()` to get the correct UTC window to filter on.

- For plain DATE columns (due_date, expiry_date, registration_date) that already
  hold a calendar date, compare against `get_today_ist()` directly.
- For TIMESTAMP columns (invoice_date, created_at) stored in UTC, filter with the
  half-open UTC window from `ist_day_bounds_utc()`.
"""

from datetime import datetime, timezone, timedelta, date

# India Standard Time — UTC + 5 hours 30 minutes. India has no DST, so this
# fixed offset is always correct.
IST = timezone(timedelta(hours=5, minutes=30))


def get_today_ist() -> date:
    """Today's calendar date in IST (not the server's local date)."""
    return datetime.now(IST).date()


def ist_day_bounds_utc(day: date | None = None) -> tuple[datetime, datetime]:
    """
    Return the [start, end) UTC datetimes that bracket one IST calendar day.

    Stored timestamps are naive UTC, so the returned datetimes are naive UTC too
    (tzinfo stripped) — ready to drop straight into a SQLAlchemy filter:

        start, end = ist_day_bounds_utc()          # today in IST
        q.filter(Invoice.invoice_date >= start,
                 Invoice.invoice_date <  end)

    Example: IST day 2026-07-24 → UTC [2026-07-23 18:30:00, 2026-07-24 18:30:00).
    """
    if day is None:
        day = get_today_ist()
    # Midnight IST at the start of `day`, and midnight IST the next day.
    start_ist = datetime(day.year, day.month, day.day, tzinfo=IST)
    end_ist = start_ist + timedelta(days=1)
    # Convert to UTC and strip tzinfo so it matches the naive UTC values in the DB.
    start_utc = start_ist.astimezone(timezone.utc).replace(tzinfo=None)
    end_utc = end_ist.astimezone(timezone.utc).replace(tzinfo=None)
    return start_utc, end_utc


def ist_range_bounds_utc(date_from: date, date_to: date) -> tuple[datetime, datetime]:
    """
    UTC [start, end) window covering the inclusive IST date range date_from..date_to.
    Used by reports/dashboards that filter UTC timestamps by an IST date range.
    """
    start_utc, _ = ist_day_bounds_utc(date_from)
    _, end_utc = ist_day_bounds_utc(date_to)
    return start_utc, end_utc
