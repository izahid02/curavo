"""
Desktop entry point for the frozen HCC ERP backend.

When PyInstaller packages the backend into an .exe, this file is the
__main__ module — the program starts here instead of uvicorn's CLI.

What it does:
  1. Decides where to write logs and the port file (AppData on Windows,
     ~/Library/Application Support on macOS, ~/.local/share on Linux)
  2. Finds a free TCP port starting at 8000 (tries up to 8019)
  3. Writes the chosen port to port.txt so the Tauri frontend knows
     which localhost URL to open in its webview
  4. Starts the FastAPI app via uvicorn

Run this file directly during development to test the desktop startup:
    python main_desktop.py
"""

import os
import sys
import signal
import socket
import logging
import logging.handlers
import platform
from multiprocessing import freeze_support
from pathlib import Path


def get_app_data_dir() -> Path:
    """
    Return the OS-appropriate directory for log files and runtime data.
    The folder is created if it does not exist yet.

    Windows : C:/Users/<user>/AppData/Roaming/HCC/
    macOS   : ~/Library/Application Support/HCC/
    Linux   : ~/.local/share/HCC/
    """
    if platform.system() == "Windows":
        # .get() (not [...]) so a stripped-down Windows env without APPDATA
        # falls back to the home folder instead of raising KeyError on launch.
        base = Path(os.environ.get("APPDATA", Path.home()))
    elif platform.system() == "Darwin":
        base = Path.home() / "Library" / "Application Support"
    else:
        base = Path.home() / ".local" / "share"

    app_dir = base / "HCC"
    app_dir.mkdir(parents=True, exist_ok=True)
    return app_dir


def find_free_port(preferred: int = 8000) -> int:
    """
    Try the preferred port first, then scan 8001–8019.
    Returns the first port not already in use on 127.0.0.1.
    Raises RuntimeError if none are free (very unlikely in practice).
    """
    for port in [preferred] + list(range(8001, 8020)):
        with socket.socket() as s:
            try:
                s.bind(("127.0.0.1", port))
                return port
            except OSError:
                continue
    raise RuntimeError("No free port found in range 8000–8019")


if __name__ == "__main__":
    # Required for safe multiprocessing when the app is frozen by PyInstaller.
    # Must be the very first call inside __main__.
    freeze_support()

    app_dir = get_app_data_dir()

    # Rotating log: max 5 MB per file, keep the last 3 rotated files.
    # Total log footprint stays under ~15 MB on disk.
    log_file = app_dir / "hcc.log"
    handler = logging.handlers.RotatingFileHandler(
        log_file, maxBytes=5 * 1024 * 1024, backupCount=3,
        encoding="utf-8",  # logs may contain Assamese template text
    )
    logging.basicConfig(
        handlers=[handler],
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
    )

    port = find_free_port(8000)

    # Write the chosen port to a file so the Tauri frontend can read it
    # at startup and know which URL to load (http://127.0.0.1:<port>).
    (app_dir / "port.txt").write_text(str(port))

    # Also expose the port via an environment variable so the /port
    # endpoint inside app/main.py can return it to health-check callers.
    os.environ["HCC_PORT"] = str(port)

    logging.info(f"HCC backend starting on port {port}")

    # Graceful shutdown when Tauri sends SIGTERM (e.g. user closes the window)
    def _shutdown(sig, frame):
        logging.info("Shutting down")
        sys.exit(0)

    signal.signal(signal.SIGTERM, _shutdown)

    # Point SQLAlchemy at the per-user app-data folder.  app/database.py reads
    # HCC_DATA_DIR FIRST and only falls back to its own OS logic in web-dev
    # mode, so this single line is what redirects the DB into AppData when
    # running as the frozen desktop .exe.
    os.environ["HCC_DATA_DIR"] = str(app_dir)

    import uvicorn  # imported here so it is available when frozen

    uvicorn.run(
        "app.main:app",   # module path to the FastAPI application object
        host="127.0.0.1",
        port=port,
        log_level="info",
        access_log=False,  # keep the log file clean in production
    )
