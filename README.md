# 🏗️ Niagara Station Auto Backup

> Generic Niagara Station backup tool — SCRAM-SHA-256 auth → download `.dist` → NAS archive → email notification

Supports Niagara 4.10+ (including JACE-8000).

---

## Features

- ✅ SCRAM-SHA-256 3-step AJAX authentication (N4.10 / N4.14 compatible)
- ✅ Auto CSRF token extraction
- ✅ Download `.dist` backup files
- ✅ Local + NAS dual storage
- ✅ Email delivery with attachment (SMTP)
- ✅ Single-file script, zero external deps (Node.js built-ins + nodemailer)

---

## Quick Start

### 1. Clone / Download

```bash
git clone <your-repo-url>
cd niagara-station-backup
```

### 2. Install dependencies

```bash
npm install nodemailer
```

### 3. Configure environment

```bash
cp .env.example .env
```

Edit `.env` with your station and email credentials:

```ini
# Niagara Station
STATION_HOST=192.168.x.x
STATION_PORT=80
STATION_SSL=false
STATION_USER=admin
STATION_PASS=your_password
STATION_NAME=Your_Station_Name

# SMTP Email (for sending backups)
EMAIL_USER=your@email.com
EMAIL_PASS=your_smtp_password
EMAIL_HOST=smtp.exmail.qq.com
EMAIL_PORT=465
EMAIL_TO=your@email.com

# NAS backup path (optional)
NAS_PATH=\\\\nas-server\\share\\backup

# Local save directory (default ./backups)
SAVE_DIR=./backups
```

### 4. Run backup

```bash
# Full flow: backup + NAS + email
node niagara-backup.js

# Backup only, no email
node niagara-backup.js --no-email

# Custom save directory
node niagara-backup.js --dir /path/to/save
```

---

## Commands

| Command | Description |
|---------|-------------|
| `node niagara-backup.js` | Full backup with email |
| `--no-email` | Skip email sending |
| `--dir /path` | Custom save directory |
| `--dry-run` | Test authentication only |
| `--verbose` | Detailed logging |

---

## Scheduling

### Windows Task Scheduler

```
Trigger: Daily at 00:00, 12:00
Action:  node D:\scripts\niagara-backup.js
```

### Linux / macOS crontab

```cron
0 */12 * * * cd /home/user/niagara-station-backup && /usr/bin/node niagara-backup.js >> backup.log 2>&1
```

---

## Project Structure

```
niagara-station-backup/
├── niagara-backup.js     ← Main script
├── .env.example          ← Config template (no secrets)
├── README.md             ← This file
└── backups/              ← Backup output (auto-created)
```

---

## Tech Details

### Authentication Flow

```
POST /prelogin (username)
  → SCRAM step 1 AJAX (client-first-message)
  → SCRAM step 2 AJAX (client-final-message + proof)
  → Session cookie
  → GET BackupService page
  → Extract CSRF token
  → Trigger backup download
```

Niagara N4.10 uses a **3-step XHR-based SCRAM** (different from N4.14's data-attribute approach):
1. `action=sendClientFirstMessage` — send client nonce
2. Server responds with salt + iterations + server nonce
3. `action=sendClientFinalMessage` — send computed SCRAM proof
4. Server validates and redirects to set session cookie

### Backup File

`.dist` files are ZIP archives (PK header) containing:
- `niagara_home/` — platform files
- `niagara_user_home/stations/<Name>/shared/` — station shared data

> **Note:** `.dist` is a distribution backup. It does NOT include PX files created dynamically via StringToFile or Workbench.

---

## Security

- `.env` is in `.gitignore` — **never commit it**
- Use environment variables or a secrets manager in production
- Backup attachments are sent via email — consider encryption for sensitive data

---

## License

MIT
