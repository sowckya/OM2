# OM2 — Operation Million Mark

Content operations platform for a network of X (and later Instagram) accounts.
Requirements and development guidelines live in [`CLAUDE.md`](CLAUDE.md).

**Status:** project scaffold only — no business features yet.

## Structure

```
OM2/
├── frontend/      React + TypeScript + Vite + Tailwind CSS v4
├── backend/       Django 5.2 + Django REST Framework
│   ├── config/    Django project settings and URLs
│   ├── manage.py
│   └── .env.example  Backend env vars (copy to backend/.env)
├── .env.example   Overview of environment variables
├── .gitignore
├── CLAUDE.md      Product requirements & development guide
└── README.md
```

Frontend and backend are independent and run as separate processes.

## Prerequisites

- Node.js 20.19+ (or 22.12+) and npm
- Python 3.12+
- PostgreSQL 16 server, running locally (in WSL: `sudo service postgresql start`)

## Environment

Each app reads its own env file; the root `.env.example` is an overview only.
For the backend, copy `backend/.env.example` to `backend/.env` and set
`DJANGO_SECRET_KEY` and the `POSTGRES_*` values (no SQLite fallback).

```powershell
Copy-Item backend\.env.example backend\.env
```

## Backend (PowerShell)

```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
python manage.py migrate
python manage.py runserver
```

Runs at http://127.0.0.1:8000 (Django admin at `/admin/`).

If PowerShell blocks `Activate.ps1`, run once:
`Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`.

On macOS/Linux, activate with `source .venv/bin/activate`.

## Frontend (PowerShell)

```powershell
cd frontend
npm install
npm run dev
```

Runs at http://localhost:5173.

Other scripts: `npm run build`, `npm run lint`, `npm run preview`.

## Checks

```powershell
# backend
python manage.py check
# frontend
npm run lint
npm run build
```
