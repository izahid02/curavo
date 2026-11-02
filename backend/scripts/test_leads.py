"""
Regression test: DEMO BOOKINGS from the website -> Leads in Curavo Control.

Run:  python3 backend/scripts/test_leads.py
Runs only the cloud server, on a throwaway folder.

What it holds the system to:
  * A real booking is stored with exactly what the form asked; a +91 number
    is kept as 10 digits.
  * Bad bookings are refused with a plain reason; a bot (the hidden field
    filled) is quietly dropped.
  * One address cannot flood the list (5 an hour).
  * Only the Curavo website may send the form from a browser (CORS).
  * Only ARZ can read the list or move a lead along; every move is audited.
"""
import os, shutil, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sandbox = Path(os.path.expanduser("~")) / ".hcc_test_leads"
shutil.rmtree(sandbox, ignore_errors=True)
sandbox.mkdir(parents=True)
os.environ["CURAVO_CLOUD_DATA"] = str(sandbox)
os.environ["CURAVO_ADMIN_PASSWORD"] = "test-panel-password"
os.environ.pop("CURAVO_SITE_ORIGINS", None)
sys.path.insert(0, str(ROOT / "cloud" / "server"))

from fastapi.testclient import TestClient            # noqa: E402
from curavo_cloud.main import app                    # noqa: E402

FAILS = []

def check(label, got, want):
    ok = got == want
    print(f"  {'PASS' if ok else 'FAIL'}  {label}" + ("" if ok else f"\n        got:  {got!r}\n        want: {want!r}"))
    if not ok:
        FAILS.append(label)

GOOD = {"name": "Rupam Das", "phone": "+91 98640 12345", "shop": "Brahmaputra Pharmacy",
        "town": "Dhubri", "current": "Marg"}

with TestClient(app) as c:
    A = {"Authorization": "Bearer " + c.post("/admin/api/login", json={
        "username": "arz", "password": "test-panel-password"}).json()["token"]}

    def book(body, ip="203.0.113.1", origin=None):
        h = {"X-Forwarded-For": ip}
        if origin:
            h["Origin"] = origin
        return c.post("/public/leads", json=body, headers=h)

    print("[1] A real booking")
    check("accepted", book(GOOD).status_code, 201)
    leads = c.get("/admin/api/leads", headers=A).json()
    l = leads["leads"][0]
    check("stored as typed", (l["name"], l["shop"], l["town"], l["current_software"]),
          ("Rupam Das", "Brahmaputra Pharmacy", "Dhubri", "Marg"))
    check("+91 number kept as 10 digits", l["phone"], "9864012345")
    check("starts as NEW", l["status"], "NEW")
    check("overview counts it", c.get("/admin/api/overview", headers=A).json()["new_leads"], 1)

    print("[2] Bad bookings")
    check("short phone refused", book({**GOOD, "phone": "12345"}, ip="203.0.113.2").status_code, 422)
    r = book({**GOOD, "phone": "phone-number"}, ip="203.0.113.2")
    check("letters-only phone refused", r.status_code, 400)
    check("...with a plain reason", "10-digit" in r.json()["detail"], True)
    check("no shop name refused", book({**GOOD, "shop": ""}, ip="203.0.113.2").status_code, 422)
    check("a bot gets a normal reply", book({**GOOD, "website": "http://spam"}, ip="203.0.113.3").status_code, 201)
    check("...but nothing is stored", len(c.get("/admin/api/leads", headers=A).json()["leads"]), 1)

    print("[3] No flooding")
    codes = [book({**GOOD, "shop": f"Shop {i}"}, ip="198.51.100.9").status_code for i in range(7)]
    check("5 an hour from one address, then refused", codes, [201] * 5 + [429] * 2)
    check("another address still fine", book({**GOOD, "shop": "Other"}, ip="198.51.100.10").status_code, 201)

    print("[4] Only the Curavo website may send it from a browser")
    pre = c.options("/public/leads", headers={"Origin": "https://curavo.in", "Access-Control-Request-Method": "POST",
                                              "Access-Control-Request-Headers": "content-type"})
    check("curavo.in allowed", pre.headers.get("access-control-allow-origin"), "https://curavo.in")
    pre = c.options("/public/leads", headers={"Origin": "https://evil.example", "Access-Control-Request-Method": "POST"})
    check("other sites not allowed", pre.headers.get("access-control-allow-origin"), None)

    print("[5] Only ARZ sees and moves leads")
    check("list needs login", c.get("/admin/api/leads").status_code, 401)
    lid = l["id"]
    check("move to CONTACTED", c.patch(f"/admin/api/leads/{lid}", headers=A, json={"status": "CONTACTED", "notes": "Called Mon"}).json()["status"], "CONTACTED")
    check("unknown status refused", c.patch(f"/admin/api/leads/{lid}", headers=A, json={"status": "MAYBE"}).status_code, 400)
    check("filter by status", [x["id"] for x in c.get("/admin/api/leads?status=CONTACTED", headers=A).json()["leads"]], [lid])
    check("note kept", c.get("/admin/api/leads?status=CONTACTED", headers=A).json()["leads"][0]["notes"], "Called Mon")
    check("move is audited", any(a["action"] == "lead_status" for a in c.get("/admin/api/audit", headers=A).json()), True)

shutil.rmtree(sandbox, ignore_errors=True)
print("\n" + "=" * 58)
print("ALL PASSED" if not FAILS else f"{len(FAILS)} FAILED: {FAILS}")
sys.exit(1 if FAILS else 0)
