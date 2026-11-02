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

## Going live (not done yet)

1. Rent a small server in India (Ubuntu), point a domain at it (e.g. `cloud.curavo.in`), HTTPS via Caddy or nginx.
2. Run the server as a service with `CURAVO_CLOUD_DATA` on a disk that is itself backed up.
3. Set `DEFAULT_CLOUD_URL` in `backend/app/services/cloud_agent.py` to the HTTPS address and ship an app update.
   Until then the cloud helper is switched off in every shop and nothing changes for them.

Guard test (runs shop + cloud together, no network): `python backend/scripts/test_cloud.py`
