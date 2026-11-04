"""
Settings for the Curavo cloud server, read from environment variables.

  CURAVO_CLOUD_DATA        folder for the database (if SQLite), the uploaded
                           backups and the auto-made signing secret.
                           Default: ./cloud-data
  CURAVO_CLOUD_DB_URL      SQLAlchemy URL.  Default: SQLite inside the data
                           folder - plenty for the pilot.  Postgres when it grows:
                           postgresql://user:pass@host/curavo
  CURAVO_ADMIN_USER        the first control-panel login (default "arz")
  CURAVO_ADMIN_PASSWORD    its password - REQUIRED the first time the server
                           starts; ignored once the account exists (change it
                           from the panel after that).
  CURAVO_BACKUP_DAYS       how many days of backups to keep per shop (30)
  CURAVO_MAX_BACKUP_MB     largest single upload accepted (500)
  CURAVO_PUBLIC_URL        the address shops reach this server at, e.g.
                           https://cloud.curavo.in - used in update download
                           links.  Default: whatever address the request came to.
  CURAVO_RELEASE_TOKEN     lets the GitHub build upload a new release without
                           a panel login.  Unset = only the panel can upload.
  CURAVO_SITE_ORIGINS      the website addresses allowed to send the demo form,
                           comma-separated.  Default: curavo.in and curavo.com
                           (with and without www).
  CURAVO_SITE_URL          the website, used in links inside emails
                           (default https://curavo.in)
  CURAVO_GOOGLE_CLIENT_IDS the "Sign in with Google" client id(s) from Google's
                           console, comma-separated.  Unset = Google sign-in off.
  CURAVO_MAIL_FROM         sender of account emails, e.g.
                           "Curavo <support@curavo.in>"
  CURAVO_MAIL_REPLY_TO     where replies go (a real inbox), e.g. the CEO's email
  CURAVO_SMTP_HOST/PORT/USER/PASSWORD
                           the email-sending service.  Unset = emails are
                           written to <data>/outbox/ instead of sent (testing).
"""
import os
import secrets
from pathlib import Path


class Settings:
    def __init__(self):
        self.data_dir = Path(os.environ.get("CURAVO_CLOUD_DATA", "cloud-data")).resolve()
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.db_url = os.environ.get("CURAVO_CLOUD_DB_URL") or f"sqlite:///{self.data_dir / 'cloud.db'}"
        self.backup_dir = self.data_dir / "backups"
        self.backup_dir.mkdir(exist_ok=True)
        self.admin_user = os.environ.get("CURAVO_ADMIN_USER", "arz")
        self.admin_password = os.environ.get("CURAVO_ADMIN_PASSWORD", "")
        self.backup_days = int(os.environ.get("CURAVO_BACKUP_DAYS", "30"))
        self.max_backup_bytes = int(os.environ.get("CURAVO_MAX_BACKUP_MB", "500")) * 1024 * 1024
        self.release_dir = self.data_dir / "releases"
        self.release_dir.mkdir(exist_ok=True)
        self.public_url = os.environ.get("CURAVO_PUBLIC_URL", "").rstrip("/")
        self.release_token = os.environ.get("CURAVO_RELEASE_TOKEN", "")
        self.site_origins = [o.strip().rstrip("/") for o in os.environ.get(
            "CURAVO_SITE_ORIGINS",
            "https://curavo.in,https://www.curavo.in,https://curavo.com,https://www.curavo.com",
        ).split(",") if o.strip()]
        self.site_url = os.environ.get("CURAVO_SITE_URL", "https://curavo.in").rstrip("/")
        self.google_client_ids = [c.strip() for c in os.environ.get("CURAVO_GOOGLE_CLIENT_IDS", "").split(",") if c.strip()]
        self.mail_from = os.environ.get("CURAVO_MAIL_FROM", "Curavo <support@curavo.in>")
        # Where a customer's reply goes (a real inbox), e.g. the CEO's email.
        self.mail_reply_to = os.environ.get("CURAVO_MAIL_REPLY_TO", "")
        # Who hears about a new plan request (default: the reply-to inbox).
        self.sales_email = os.environ.get("CURAVO_SALES_EMAIL", "") or self.mail_reply_to
        self.smtp_host = os.environ.get("CURAVO_SMTP_HOST", "")
        self.smtp_port = int(os.environ.get("CURAVO_SMTP_PORT", "587"))
        self.smtp_user = os.environ.get("CURAVO_SMTP_USER", "")
        self.smtp_password = os.environ.get("CURAVO_SMTP_PASSWORD", "")
        self.outbox_dir = self.data_dir / "outbox"
        self.secret = self._secret()
        self.account_secret = self._secret("account_secret.txt")

    def _secret(self, name: str = "panel_secret.txt") -> str:
        """
        A signing secret (panel logins; customer account sessions use their
        own).  Made once and kept in the data folder, so it is never in the
        code and survives restarts (a new one would log everybody out).
        """
        path = self.data_dir / name
        if not path.exists():
            path.write_text(secrets.token_urlsafe(48))
            try:
                os.chmod(path, 0o600)
            except OSError:
                pass
        return path.read_text().strip()


settings = Settings()
