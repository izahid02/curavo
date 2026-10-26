"""
Schedule H1 — the drugs whose sale must be written into a register.

WHY THIS FILE EXISTS
--------------------
Rule 65(11)(d) of the Drugs and Cosmetics Rules requires a pharmacy to record
every sale of a Schedule H1 drug in a bound register, keep it for three years,
and produce it for inspection.  The app writes that register automatically, so
something has to decide which medicines are in scope.  That decision is here,
in one place, and nowhere else.

SCHEDULE H1 NAMES DRUGS, NOT BRANDS
-----------------------------------
The notification lists molecules: "Tramadol", not "ULTRACET".  So matching runs
against a product's GENERIC NAME, never its brand name.  A pharmacy's shelf is
all brands, which is why a medicine with no generic name recorded is invisible
to this match — see missing_generic_names() in the inventory service.

IN-FORCE DATES ARE PART OF THE DATA
-----------------------------------
The list has grown since 2013 and will grow again.  Each entry therefore
carries the date it came into force, and schedule_h1_drugs(on=...) answers
"what was regulated on this date".  Two consequences, both deliberate:

  - Pregabalin was notified on 13 May 2026 and commences 180 days later.  It
    is in this list now, with its own date, and starts being enforced on that
    day without anyone remembering to edit anything.
  - A register entry written last year is not retrospectively wrong because a
    drug was added this year.

SOURCES AND THEIR RELIABILITY — read before adding anything
-----------------------------------------------------------
Entries 1-46 are the original notification G.S.R. 588(E) of 30 August 2013 and
are not in doubt.  Entry 51 (pregabalin) was widely reported in the national
press alongside the ministry's own announcement.  Entries 47-50 were first
taken from a compiled industry list citing gazette numbers, and were confirmed
by the pharmacy on 26 October 2026.

`verified=False` is how an entry says "taken from a secondary source and not
yet confirmed".  Keep using it for anything added in future: unverified_entries()
exists so the app can show which lines are still only probably right.

A draft notification of 19 August 2026 proposes further additions.  Draft is
not law: do not add them until they commence.
"""
from datetime import date
from typing import NamedTuple, Optional


class ScheduleDrug(NamedTuple):
    """One entry on Schedule H1."""
    name:      str           # the drug (INN), lower case, as it is matched
    in_force:  date          # the day it became enforceable
    notified:  str           # the gazette notification, for the audit trail
    verified:  bool = True   # False = taken from a secondary source, unchecked
    aliases:   tuple = ()    # other spellings that appear on Indian packaging


# The original 46 — G.S.R. 588(E), 30 August 2013, in force 1 March 2014.
_2013 = date(2014, 3, 1)
_GSR_588 = "G.S.R. 588(E) dated 30.08.2013"

SCHEDULE_H1: tuple[ScheduleDrug, ...] = (
    ScheduleDrug("alprazolam",        _2013, _GSR_588),
    ScheduleDrug("balofloxacin",      _2013, _GSR_588),
    ScheduleDrug("buprenorphine",     _2013, _GSR_588),
    ScheduleDrug("capreomycin",       _2013, _GSR_588),
    ScheduleDrug("cefdinir",          _2013, _GSR_588),
    ScheduleDrug("cefditoren",        _2013, _GSR_588),
    ScheduleDrug("cefepime",          _2013, _GSR_588),
    ScheduleDrug("cefetamet",         _2013, _GSR_588),
    ScheduleDrug("cefixime",          _2013, _GSR_588),
    ScheduleDrug("cefoperazone",      _2013, _GSR_588),
    ScheduleDrug("cefotaxime",        _2013, _GSR_588),
    ScheduleDrug("cefpirome",         _2013, _GSR_588),
    ScheduleDrug("cefpodoxime",       _2013, _GSR_588),
    ScheduleDrug("ceftazidime",       _2013, _GSR_588),
    ScheduleDrug("ceftibuten",        _2013, _GSR_588),
    ScheduleDrug("ceftizoxime",       _2013, _GSR_588),
    ScheduleDrug("ceftriaxone",       _2013, _GSR_588),
    ScheduleDrug("chlordiazepoxide",  _2013, _GSR_588),
    ScheduleDrug("clofazimine",       _2013, _GSR_588),
    ScheduleDrug("codeine",           _2013, _GSR_588),
    ScheduleDrug("cycloserine",       _2013, _GSR_588),
    ScheduleDrug("diazepam",          _2013, _GSR_588),
    ScheduleDrug("diphenoxylate",     _2013, _GSR_588),
    ScheduleDrug("doripenem",         _2013, _GSR_588),
    ScheduleDrug("ertapenem",         _2013, _GSR_588),
    # The schedule says "Ethambutol Hydrochloride"; packs say plain Ethambutol.
    ScheduleDrug("ethambutol",        _2013, _GSR_588),
    ScheduleDrug("ethionamide",       _2013, _GSR_588),
    # The schedule spells it "Feropenem"; the modern INN is faropenem, and that
    # is what appears on Indian packs.  Both match.
    ScheduleDrug("faropenem",         _2013, _GSR_588, aliases=("feropenem",)),
    ScheduleDrug("gemifloxacin",      _2013, _GSR_588),
    ScheduleDrug("imipenem",          _2013, _GSR_588),
    ScheduleDrug("isoniazid",         _2013, _GSR_588),
    ScheduleDrug("levofloxacin",      _2013, _GSR_588),
    ScheduleDrug("meropenem",         _2013, _GSR_588),
    ScheduleDrug("midazolam",         _2013, _GSR_588),
    ScheduleDrug("moxifloxacin",      _2013, _GSR_588),
    ScheduleDrug("nitrazepam",        _2013, _GSR_588),
    ScheduleDrug("pentazocine",       _2013, _GSR_588),
    ScheduleDrug("prulifloxacin",     _2013, _GSR_588),
    ScheduleDrug("pyrazinamide",      _2013, _GSR_588),
    ScheduleDrug("rifabutin",         _2013, _GSR_588),
    ScheduleDrug("rifampicin",        _2013, _GSR_588),
    # Appears on packs as "sodium para-aminosalicylate", "PAS sodium", "para
    # aminosalicylic acid".  The distinctive fragment is aminosalicyl.
    ScheduleDrug("aminosalicyl",      _2013, _GSR_588,
                 aliases=("para-aminosalicylate", "para aminosalicylate")),
    ScheduleDrug("sparfloxacin",      _2013, _GSR_588),
    ScheduleDrug("thiacetazone",      _2013, _GSR_588, aliases=("thioacetazone",)),
    ScheduleDrug("tramadol",          _2013, _GSR_588),
    ScheduleDrug("zolpidem",          _2013, _GSR_588),

    # --- Added since 2013.  Confirmed by the pharmacy on 26 October 2026. ---
    ScheduleDrug("oxytocin",     date(2018, 8, 21),
                 "G.S.R. 795(E) dated 21.08.2018"),
    ScheduleDrug("tapentadol",   date(2021, 4, 7),
                 "G.S.R. 258(E) dated 07.04.2021"),
    ScheduleDrug("oseltamivir",  date(2024, 2, 5),
                 "G.S.R. 95(E) dated 05.02.2024"),
    ScheduleDrug("zanamivir",    date(2024, 2, 5),
                 "G.S.R. 95(E) dated 05.02.2024"),

    # Pregabalin: notified 13 May 2026, commencing 180 days after publication.
    # Listed now so it starts enforcing itself on the day, with no code change
    # and nobody having to remember.
    ScheduleDrug("pregabalin",   date(2026, 11, 9),
                 "G.S.R. 377(E) dated 13.05.2026"),
)

# A medicine can also be regulated without being a molecule on any list — the
# MTP (medical termination of pregnancy) kit is flagged on the product itself.
CATEGORY_H1  = "H1"
CATEGORY_MTP = "MTP"
REGISTER_CATEGORIES = (CATEGORY_H1, CATEGORY_MTP)

CATEGORY_LABELS = {
    CATEGORY_H1:  "Schedule H1",
    CATEGORY_MTP: "MTP kit",
}


def schedule_h1_drugs(on: Optional[date] = None) -> tuple[ScheduleDrug, ...]:
    """
    The drugs regulated ON a given date (default: today).

    Anything not yet in force is excluded, so pregabalin stays out until its
    commencement day and then appears without anyone touching the code.
    """
    when = on or date.today()
    return tuple(d for d in SCHEDULE_H1 if d.in_force <= when)


def match_schedule_h1(generic_name: Optional[str],
                      product_name: Optional[str] = None,
                      on: Optional[date] = None) -> Optional[ScheduleDrug]:
    """
    Which Schedule H1 drug, if any, this medicine contains.

    Matches on the GENERIC NAME, because that is what the schedule lists.  The
    brand name is checked only as a fallback, for the handful of brands that
    are named after their molecule, and never as the primary signal: matching
    brands would catch "MOXIKIND" while missing "ULTRACET".

    Substring matching is deliberate.  A generic name is written in a dozen
    ways on Indian packaging — "Levofloxacin 500mg", "Levofloxacin Hemihydrate
    IP", "Cefixime + Ofloxacin" — and the drug name sits inside all of them.
    The cost is that a combination product matches on its first regulated
    ingredient, which is correct: a combination containing a Schedule H1 drug
    is a Schedule H1 sale.

    Returns the matching entry, or None.  The caller CONFIRMS the match with
    the pharmacist rather than acting on it silently — a register built from
    guesses is worse than no register.
    """
    for field in (generic_name, product_name):
        if not field:
            continue
        hay = field.lower()
        for drug in schedule_h1_drugs(on):
            if drug.name in hay:
                return drug
            if any(alias in hay for alias in drug.aliases):
                return drug
    return None


def unverified_entries() -> tuple[ScheduleDrug, ...]:
    """Entries taken from a secondary source, for the settings screen to show."""
    return tuple(d for d in SCHEDULE_H1 if not d.verified)
