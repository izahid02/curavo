"""
Regression test: APP UPDATES - who is offered which version, and the uploads.

Run:  python3 backend/scripts/test_updates.py
Runs the cloud server and the shop app in this one process on throwaway
folders.  (The desktop shell's part - downloading, checking ARZ's update
signature and installing - is Rust and is tested on a real Windows PC; see
the testing list in the plan.)

What it holds the system to:
  * A new version reaches PILOT shops first; everyone only after "Send to
    everyone"; nobody while PAUSED.
  * A shop is only ever offered something NEWER than what it runs (no
    downgrades), and 0.3.0 counts as newer than 0.3.0-beta.2.
  * The reply has exactly the fields the Tauri updater reads.
  * Uploads: only the build's own file names, no duplicates, no tiny files,
    only ARZ (or the GitHub build's token) may upload.
  * The shop app tells its shell where to look - and nothing at all while the
    cloud is switched off; cloud_url.txt points a test PC at a test cloud.
"""
import os, shutil, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sandbox = Path(os.path.expanduser("~")) / ".hcc_test_updates"
shutil.rmtree(sandbox, ignore_errors=True)
(sandbox / "shop").mkdir(parents=True)
(sandbox / "cloud").mkdir(parents=True)
os.environ["HCC_DATA_DIR"] = str(sandbox / "shop")
os.environ["CURAVO_CLOUD_DATA"] = str(sandbox / "cloud")
os.environ["CURAVO_ADMIN_PASSWORD"] = "test-panel-password"
os.environ["CURAVO_RELEASE_TOKEN"] = "test-release-token"
os.environ["CURAVO_PUBLIC_URL"] = "https://cloud.example.test"
os.environ.pop("CURAVO_CLOUD_URL", None)
sys.path.insert(0, str(ROOT / "backend"))
sys.path.insert(0, str(ROOT / "cloud" / "server"))

from fastapi.testclient import TestClient            # noqa: E402
from app.main import app as shop_app                 # noqa: E402
from app.services import cloud_agent                 # noqa: E402
from curavo_cloud.main import app as cloud_app       # noqa: E402
from curavo_cloud.routers.updates import version_key  # noqa: E402

FAILS = []

def check(label, got, want):
    ok = got == want
    print(f"  {'PASS' if ok else 'FAIL'}  {label}" + ("" if ok else f"\n        got:  {got!r}\n        want: {want!r}"))
    if not ok:
        FAILS.append(label)

FAKE_EXE = b"MZ" + b"\0" * (2 * 1024 * 1024)
SIG = "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVU" * 2

with TestClient(cloud_app) as cloud, TestClient(shop_app) as shop:
    A = {"Authorization": "Bearer " + cloud.post("/admin/api/login", json={
        "username": "arz", "password": "test-panel-password"}).json()["token"]}

    def up(name, body=FAKE_EXE, headers=A, notes="", critical=False):
        return cloud.post("/admin/api/releases", headers=headers,
                          files={"installer": (name, body, "application/octet-stream")},
                          data={"signature": SIG, "notes": notes, "critical": str(critical).lower()})

    def offer(current, code=""):
        r = cloud.get(f"/updates/windows/x86_64/{current}", headers={"X-Shop-Code": code} if code else {})
        return r.json() if r.status_code == 200 else r.status_code

    def set_status(rid, status):
        return cloud.patch(f"/admin/api/releases/{rid}", headers=A, json={"status": status})

    # Two shops: one pilot, one not
    toks = {}
    for code, name in (("PLTSHP23", "Pilot Pharmacy"), ("NRMSHP45", "Normal Medicos")):
        toks[code] = cloud.post("/agent/v1/register", json={"shop_code": code, "shop_name": name,
                                                            "app_version": "0.2.0"}).json()["device_token"]
    cloud.patch("/admin/api/shops/PLTSHP23", headers=A, json={"pilot": True})

    print("[1] Version order")
    check("0.3.0 > 0.3.0-beta.2", version_key("0.3.0") > version_key("0.3.0-beta.2"), True)
    check("0.10.0 > 0.9.9 (numbers, not text)", version_key("0.10.0") > version_key("0.9.9"), True)
    check("v-prefix accepted", version_key("v0.3.0") == version_key("0.3.0"), True)
    check("nonsense is lowest", version_key("banana") < version_key("0.0.1"), True)

    print("[2] Nothing uploaded yet")
    check("no update offered", offer("0.2.0", "PLTSHP23"), 204)
    check("website download: no link -> refused", cloud.get("/download/windows", follow_redirects=False).status_code, 403)

    print("[3] Uploads")
    check("wrong file name refused", up("setup.exe").status_code, 400)
    check("tiny file refused", up("Curavo_0.3.0_x64-setup.exe", body=b"MZ").status_code, 400)
    check("no login refused", up("Curavo_0.3.0_x64-setup.exe", headers={}).status_code, 401)
    r = up("Curavo_0.3.0_x64-setup.exe", notes="Faster search", critical=False)
    check("ARZ upload accepted", r.status_code, 201)
    rel = r.json()
    check("starts as PILOT", rel["status"], "PILOT")
    check("same version twice refused", up("Curavo_0.3.0_x64-setup.exe").status_code, 409)
    check("GitHub build token accepted",
          up("Curavo_0.3.1-beta.1_x64-setup.exe", headers={"X-Release-Token": "test-release-token"}).status_code, 201)
    check("wrong build token refused",
          up("Curavo_0.3.2_x64-setup.exe", headers={"X-Release-Token": "nope"}).status_code, 401)
    rels = {x["version"]: x for x in cloud.get("/admin/api/releases", headers=A).json()["releases"]}
    beta_id = rels["0.3.1-beta.1"]["id"]
    set_status(beta_id, "PAUSED")

    print("[4] PILOT: pilot shops only")
    o = offer("0.2.0", "PLTSHP23")
    check("pilot shop offered 0.3.0", o.get("version") if isinstance(o, dict) else o, "0.3.0")
    check("reply has the updater's fields",
          sorted(o) if isinstance(o, dict) else o, ["critical", "notes", "pub_date", "signature", "url", "version"])
    check("download link uses the public address",
          o["url"], "https://cloud.example.test/updates/files/Curavo_0.3.0_x64-setup.exe")
    check("signature passed through untouched", o["signature"], SIG)
    check("pub_date is RFC 3339 UTC", o["pub_date"].endswith("Z") and "T" in o["pub_date"], True)
    check("normal shop: nothing yet", offer("0.2.0", "NRMSHP45"), 204)
    check("unknown caller: nothing", offer("0.2.0"), 204)
    check("not offered to Mac/Linux", cloud.get("/updates/darwin/aarch64/0.2.0").status_code, 204)

    print("[5] Send to everyone")
    set_status(rel["id"], "ALL")
    check("normal shop now offered 0.3.0", offer("0.2.0", "NRMSHP45").get("version"), "0.3.0")
    check("already on 0.3.0: nothing", offer("0.3.0", "NRMSHP45"), 204)
    check("on a newer build: no downgrade", offer("0.4.0", "NRMSHP45"), 204)
    check("beta 0.3.0-beta.2 -> 0.3.0 offered", offer("0.3.0-beta.2", "NRMSHP45").get("version"), "0.3.0")
    got = cloud.get("/updates/files/Curavo_0.3.0_x64-setup.exe")
    check("installer downloads intact", got.content == FAKE_EXE, True)
    # The website's Download button needs the 15-minute link My account gives an ACTIVE account.
    from curavo_cloud.config import settings as _cs
    from jose import jwt as _jwt
    from datetime import datetime as _dt, timedelta as _td
    _t = _jwt.encode({"sub": "1", "aud": "curavo-download", "exp": _dt.utcnow() + _td(minutes=15)}, _cs.account_secret, algorithm="HS256")
    check("website download without a link -> refused", cloud.get("/download/windows", follow_redirects=False).status_code, 403)
    check("website download -> newest for everyone",
          cloud.get(f"/download/windows?t={_t}", follow_redirects=False).headers.get("location"),
          "/updates/files/Curavo_0.3.0_x64-setup.exe")
    check("only installer names are served", cloud.get("/updates/files/cloud.db").status_code, 404)
    check("no walking out of the folder", cloud.get("/updates/files/..%2Fcloud.db").status_code != 200, True)

    print("[6] A newer pilot version, then paused")
    set_status(beta_id, "PILOT")
    check("pilot shop on 0.3.0 offered the beta", offer("0.3.0", "PLTSHP23").get("version"), "0.3.1-beta.1")
    check("normal shop still on 0.3.0 only", offer("0.3.0", "NRMSHP45"), 204)
    set_status(beta_id, "PAUSED")
    check("paused: pilot shop offered nothing newer", offer("0.3.0", "PLTSHP23"), 204)
    check("paused: a pilot on 0.2.0 still gets 0.3.0", offer("0.2.0", "PLTSHP23").get("version"), "0.3.0")
    check("bad status refused", set_status(beta_id, "MAYBE").status_code, 400)

    print("[7] Disabled shops get nothing")
    cloud.patch("/admin/api/shops/NRMSHP45", headers=A, json={"disabled": True})
    check("disabled shop: nothing", offer("0.2.0", "NRMSHP45"), 204)
    cloud.patch("/admin/api/shops/NRMSHP45", headers=A, json={"disabled": False})

    print("[8] The panel's view")
    d = cloud.get("/admin/api/releases", headers=A).json()
    check("newest first", [r["version"] for r in d["releases"]], ["0.3.1-beta.1", "0.3.0"])
    check("versions in use", d["versions_in_use"], [["0.2.0", 2]])
    check("one pilot shop", d["pilot_shops"], 1)
    acts = {a["action"] for a in cloud.get("/admin/api/audit", headers=A).json()}
    check("uploads and status changes audited",
          {"upload_release", "release_all", "release_paused", "pilot_on"} <= acts, True)

    print("[9] The shop app tells its shell where to look")
    tok = shop.post("/api/auth/login", json={"username": "admin", "password": "admin123"}).json()["token"]["access_token"]
    H = {"Authorization": f"Bearer {tok}"}
    cloud_agent.agent.url = ""
    check("cloud off: no updates at all", shop.get("/api/cloud/update-info", headers=H).json(), {"enabled": False})
    cloud_agent.agent.url = "http://192.168.1.20:8100"
    info = shop.get("/api/cloud/update-info", headers=H).json()
    check("endpoint for the Tauri updater", info["endpoint"],
          "http://192.168.1.20:8100/updates/{{target}}/{{arch}}/{{current_version}}")
    check("with this shop's code", len(info["shop_code"]), 8)
    check("needs a login", shop.get("/api/cloud/update-info").status_code, 401)
    cloud_agent.agent.url = ""
    (sandbox / "shop" / "cloud_url.txt").write_text("http://192.168.1.20:8100/\n")
    check("cloud_url.txt points a test PC at a test cloud", cloud_agent.cloud_url(), "http://192.168.1.20:8100")
    (sandbox / "shop" / "cloud_url.txt").write_text("not a url")
    check("a junk cloud_url.txt is ignored (from source: cloud off)", cloud_agent.cloud_url(), "")
    # The installed app (PyInstaller sets sys.frozen) falls back to the real cloud;
    # code run from source - every test and a dev Mac - never does.
    import sys as _sys
    _sys.frozen = True
    try:
        check("installed app: junk file -> the real cloud", cloud_agent.cloud_url(), "https://cloud.curavo.in")
        (sandbox / "shop" / "cloud_url.txt").unlink()
        check("installed app: no file -> the real cloud", cloud_agent.cloud_url(), "https://cloud.curavo.in")
        _os_env = __import__("os").environ
        _os_env["CURAVO_CLOUD_URL"] = ""
        check("installed app: CURAVO_CLOUD_URL='' switches it off", cloud_agent.cloud_url(), "")
        del _os_env["CURAVO_CLOUD_URL"]
    finally:
        del _sys.frozen
    check("from source, no file: cloud off", cloud_agent.cloud_url(), "")

shutil.rmtree(sandbox, ignore_errors=True)
print("\n" + "=" * 58)
print("ALL PASSED" if not FAILS else f"{len(FAILS)} FAILED: {FAILS}")
sys.exit(1 if FAILS else 0)
