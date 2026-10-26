"""
Regression test: THE SCHEDULE H1 LIST AND HOW MEDICINES MATCH IT.

Run:  python3 backend/scripts/test_drug_schedules.py

This guards a LEGAL register.  A drug that silently stops matching means sales
that should have been recorded are not, and the pharmacy carries that.  So the
checks below are about the ways matching quietly goes wrong:

  - a drug dropping off the list
  - a date boundary (pregabalin commences 9 November 2026)
  - brand-only matching, which would catch MOXIKIND and miss ULTRACET
  - the spellings Indian packs actually use, which are not the schedule's

The product names used here are real ones from the pharmacy's own stock, so a
failure names something the shop actually sells.
"""
import sys
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.services.drug_schedules import (  # noqa: E402
    SCHEDULE_H1,
    match_schedule_h1,
    schedule_h1_drugs,
    unverified_entries,
)

FAILS = []


def check(label, got, want):
    ok = got == want
    print(f"  {'PASS' if ok else 'FAIL'}  {label}: got {got!r}, want {want!r}")
    if not ok:
        FAILS.append(label)


def main():
    today = date(2026, 10, 24)

    print("[1] The list itself")
    check("51 entries in total", len(SCHEDULE_H1), 51)
    check("46 of them from the 2013 notification",
          sum(1 for d in SCHEDULE_H1 if d.in_force == date(2014, 3, 1)), 46)
    check("no duplicate drug names",
          len({d.name for d in SCHEDULE_H1}), len(SCHEDULE_H1))
    # All 51 are confirmed as of 26 Oct 2026.  The mechanism stays for future
    # additions: anything taken from a secondary source goes in verified=False
    # until someone checks it, and this asserts none are sitting unchecked.
    check("nothing left unverified", len(unverified_entries()), 0)

    print("\n[2] Pregabalin commences 9 November 2026 - not before")
    check("not regulated on 24 Oct 2026",
          match_schedule_h1("Pregabalin 75mg", on=date(2026, 10, 24)), None)
    got = match_schedule_h1("Pregabalin 75mg", on=date(2026, 11, 9))
    check("regulated on the day itself", got.name if got else None, "pregabalin")
    check("50 drugs in force before that date",
          len(schedule_h1_drugs(on=date(2026, 10, 24))), 50)
    check("51 from that date",
          len(schedule_h1_drugs(on=date(2026, 11, 9))), 51)

    print("\n[3] Real stock from this pharmacy matches on its generic name")
    for generic, product, want in (
        ("Tramadol + Paracetamol",      "ULTRACET TAB",      "tramadol"),
        ("Levofloxacin 500mg",          "LEVOMAC 500 TAB",   "levofloxacin"),
        ("Ceftriaxone + Sulbactam",     "MONOCEF SB 1.5 GM INJ", "ceftriaxone"),
        ("Cefpodoxime Proxetil 200mg",  "ZEDOCEF 200 TAB",   "cefpodoxime"),
        ("Chlordiazepoxide + Amitriptyline", "AMIXIDE H TAB", "chlordiazepoxide"),
        ("Moxifloxacin 0.5%",           "VISMOX E/D",        "moxifloxacin"),
        ("Faropenem 300mg",             "MEROSURE O ER 300 TAB", "faropenem"),
        ("Cefixime 200mg",              "TAXIM O 200 TAB",   "cefixime"),
    ):
        got = match_schedule_h1(generic, product, on=today)
        check(f"{product}", got.name if got else None, want)

    print("\n[4] Spellings that differ from the schedule's own")
    for generic, want in (
        ("Feropenem 200mg",                 "faropenem"),      # schedule's spelling
        ("Ethambutol Hydrochloride 800mg",  "ethambutol"),
        ("Thioacetazone",                   "thiacetazone"),   # pack spelling
        ("Sodium Para-Aminosalicylate",     "aminosalicyl"),
        ("PAS Sodium (para aminosalicylate)", "aminosalicyl"),
    ):
        got = match_schedule_h1(generic, on=today)
        check(f"{generic}", got.name if got else None, want)

    print("\n[5] What must NOT match")
    # Ofloxacin is NOT on Schedule H1 - only certain fluoroquinolones are.  The
    # pharmacy stocks 18 ofloxacin products; flagging them would force full
    # patient details on sales that do not need them.
    for generic, product in (
        ("Ofloxacin 200mg",          "O2 SYP"),
        ("Ofloxacin + Ornidazole",   "DIOF DS SYP"),
        ("Paracetamol 650mg",        "DOLO 650 TAB"),
        ("Pantoprazole + Domperidone", "PANTOCID DSR"),
        ("",                         "PREGA NEWS TEST KIT"),   # a test, not a drug
    ):
        check(f"{product} stays unregulated",
              match_schedule_h1(generic, product, on=today), None)

    print("\n[6] A medicine with no generic name cannot be matched")
    # This is why the 205 products with a blank generic name matter: the match
    # has nothing to read.  MIFEGEST KIT is one of them, and is flagged as MTP
    # on the product record instead of by drug name.
    check("blank generic, unrelated brand", match_schedule_h1("", "MIFEGEST KIT"), None)
    check("None generic", match_schedule_h1(None, None), None)

    print("\n" + "=" * 62)
    if FAILS:
        print(f"{len(FAILS)} CHECK(S) FAILED: {FAILS}")
        return 1
    print("ALL CHECKS PASSED")
    return 0


if __name__ == "__main__":
    sys.exit(main())
