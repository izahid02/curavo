# Health Care Centre ERP

Offline-first Pharmacy ERP & OPD Management System.
Stack: **FastAPI** (backend) · **PostgreSQL** (database) · **React** (frontend, coming next).

This README is written for a beginner. Follow it top to bottom.

---

## What we've built so far (Phase 1 — foundation)

```
hcc-erp/
├── database/
│   └── schema.sql          ← all the tables (run this once to set up the DB)
├── backend/
│   ├── app/
│   │   ├── main.py         ← the server (start here)
│   │   ├── config.py       ← reads settings from .env
│   │   └── database.py     ← connects to PostgreSQL
│   ├── requirements.txt    ← Python libraries to install
│   └── .env.example        ← copy to .env and fill in
└── README.md               ← you are here
```

---

## One-time setup

### 1. Install the tools (on the pharmacy Windows PC)
- **Python 3.11+** — from python.org (tick "Add Python to PATH" during install).
- **PostgreSQL 16** — from postgresql.org. During install it asks for a
  password for the `postgres` user — write it down.
- **Node.js** — from nodejs.org (needed later for the React frontend).

### 2. Create the database
Open "SQL Shell (psql)" (installed with PostgreSQL) and run:
```sql
CREATE USER hcc WITH PASSWORD 'hcc';
CREATE DATABASE hcc_erp OWNER hcc;
```
Then load our tables:
```
psql -U hcc -d hcc_erp -f database/schema.sql
```

### 3. Set up the backend
```
cd backend
python -m venv venv

# activate the virtual environment:
source venv/bin/activate         # on Mac (your dev machine)
venv\Scripts\activate            # on Windows (the pharmacy PC)

pip install -r requirements.txt

cp .env.example .env             # on Mac
copy .env.example .env           # on Windows
# then open .env and adjust if needed
```

### 3b. Set up the frontend
```
cd frontend
npm install
npm run dev                      # opens http://localhost:5173
```

### 4. Run the backend
```
uvicorn app.main:app --reload
```
Now open your browser to **http://localhost:8000/docs**
You should see the API explorer. Click `GET /health/db` → "Try it out" →
"Execute". If it says `{"database": "connected"}`, everything works. 🎉

---

## What's next
- **Inventory module** — add/edit medicines, receive stock into batches.
- **Billing/POS** — barcode billing, GST invoice, automatic stock deduction.
- **Patients** — registration, tags, departments.

We build these one at a time, test each, then move on.
