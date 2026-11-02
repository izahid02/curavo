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
        self.secret = self._secret()

    def _secret(self) -> str:
        """
        Signs control-panel logins.  Made once and kept in the data folder, so
        it is never in the code and survives restarts (a new one would log
        everybody out).
        """
        path = self.data_dir / "panel_secret.txt"
        if not path.exists():
            path.write_text(secrets.token_urlsafe(48))
            try:
                os.chmod(path, 0o600)
            except OSError:
                pass
        return path.read_text().strip()


settings = Settings()
