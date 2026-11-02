# Curavo Cloud

Two parts, both owned by ARZ Solutions:

| Folder | What it is |
|---|---|
| `server/` | The Curavo cloud server (FastAPI). Shop PCs check in here, upload their **locked** daily backup and send error reports. |
| `admin/`  | **Curavo Control**, the ARZ control panel (React). The server serves its built files at `/`. |

The shop side lives in the desktop app: `backend/app/services/cloud_agent.py` (check-ins, backups),
`backup_crypto.py` (locking) and `error_reports.py` (crash reports).

## How a backup stays private

Each backup is locked **on the shop PC** before upload (AES-256-GCM). The key that opens it is itself
locked twice: once for **ARZ** (the recovery key, whose secret half is only on Zahid's Mac in
`~/Projects/ARZ-licence-keys/arz_backup_recovery_private.pem`) and once for **the shop** (its own key,
kept in its database). This server stores only the locked files; it cannot open them.

To restore a shop: download the backup from its page in Curavo Control, then on the Mac:

    python3 tools/cloud/curavo_recovery.py open SHOPCODE_xxx.cbk --out ~/Desktop/restore

and put `pharmacy.db` + `branding/` on the shop's PC by the restore steps in CLAUDE.md section 11.

## Run it locally

    cd cloud/admin && npm install && npm run build          # the panel's screens
    cd ../server && pip install -r requirements.txt
    CURAVO_ADMIN_PASSWORD='a-long-password' CURAVO_CLOUD_DATA=./cloud-data \
        uvicorn curavo_cloud.main:app --port 8100

Open http://localhost:8100 and sign in as `arz`. Point a shop's backend at it with
`CURAVO_CLOUD_URL=http://127.0.0.1:8100`.

## App updates

Curavo Control -> **App updates**: upload `Curavo_X.Y.Z_x64-setup.exe` plus its `.exe.sig` (both come out
of the GitHub build; once the cloud is live the build uploads them itself). A new version starts as
**Pilot shops** only; press **Send to everyone** when the pilots are happy, or **Pause** to hold it back.
Mark pilot shops on their own page. Shops check every 6 hours, download quietly and install when Curavo
is closed. The website's Download button can point at `/download/windows` (newest version for everyone).

### Testing updates on a real Windows PC (no server needed)

1. On the Mac: `CURAVO_PUBLIC_URL=http://<mac-ip>:8100 ... uvicorn curavo_cloud.main:app --host 0.0.0.0 --port 8100`
2. On GitHub: run the build by hand twice with **test_build** ticked, e.g. `0.3.0-beta.1` and `0.3.0-beta.2`
   (needs the `TAURI_SIGNING_PRIVATE_KEY` secret).
3. Install beta.1 on the Windows PC. Create `%APPDATA%\HCC\cloud_url.txt` containing `http://<mac-ip>:8100`
   and restart Curavo: it registers and appears in Curavo Control. Tick **Pilot shop**.
4. Upload beta.2 (exe + sig) in **App updates**. Within ~2 minutes of the next Curavo start the banner
   says "Curavo 0.3.0-beta.2 is ready". Close Curavo -> it installs; open it -> the panel shows beta.2.
5. Also try: **Install now**; a beta.3 uploaded then **Paused** (must not arrive); an installer whose `.sig`
   is from another build (must be refused).

## Going live (not done yet)

1. Rent a small server in India (Ubuntu), point a domain at it (e.g. `cloud.curavo.in`), HTTPS via Caddy or nginx.
2. Run the server as a service with `CURAVO_CLOUD_DATA` on a disk that is itself backed up.
3. Set `DEFAULT_CLOUD_URL` in `backend/app/services/cloud_agent.py` to the HTTPS address and ship an app update.
   Until then the cloud helper is switched off in every shop and nothing changes for them.

Guard test (runs shop + cloud together, no network): `python backend/scripts/test_cloud.py`
