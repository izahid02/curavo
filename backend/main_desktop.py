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

    # ---------------------------------------------------------------------
    # Windows safety net: give the process a usable stdout/stderr.
    #
    # hcc_backend.spec builds with console=False (no black terminal window).
    # In that "windowed" mode PyInstaller leaves sys.stdout and sys.stderr as
    # None, so ANY print() or library write to them raises AttributeError —
    # and because that happens before our own logging is involved, the process
    # dies without writing a single line to hcc.log.  That is exactly the
    # "starts, then nothing" symptom we are chasing.
    #
    # Pointing both at the log file (UTF-8) means stray output is captured
    # instead of fatal.  UTF-8 also matters because several startup messages
    # contain emoji / Assamese text, which the Windows default cp1252 console
    # encoding cannot encode (UnicodeEncodeError).
    _console_log = open(app_dir / "hcc_console.log", "a", encoding="utf-8",
                        errors="replace", buffering=1)
    if sys.stdout is None:
        sys.stdout = _console_log
    if sys.stderr is None:
        sys.stderr = _console_log

    port = find_free_port(8000)

    # Write the chosen port to a file so the Tauri frontend can read it
    # at startup and know which URL to load (http://127.0.0.1:<port>).
    (app_dir / "port.txt").write_text(str(port))

    # Also expose the port via an environment variable so the /port
    # endpoint inside app/main.py can return it to health-check callers.
    os.environ["HCC_PORT"] = str(port)

    # Startup diagnostics.  When the frozen .exe misbehaves on a user's Windows
    # PC these four lines are usually enough to tell whether Python started at
    # all, whether it picked the right data folder, and which port it chose.
    logging.info(f"Python version: {sys.version}")
    logging.info(f"Frozen: {getattr(sys, 'frozen', False)}")
    logging.info(f"App data dir: {app_dir}")
    logging.info(f"Database file will be: {app_dir / 'pharmacy.db'}")
    logging.info(f"Starting uvicorn on port {port}")

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

    # Everything below is wrapped so that a failure during import or startup
    # lands in hcc.log with a full traceback, instead of the process vanishing
    # silently (which is what "Starting uvicorn on port 8000 … then nothing"
    # in the Windows log means).
    try:
        # Import the FastAPI app OBJECT rather than passing uvicorn the string
        # "app.main:app".  A string makes uvicorn look the module up by name at
        # runtime, which PyInstaller cannot trace while analysing the code —
        # that is what produced "No module named 'app'" in the frozen Windows
        # build.  A real import statement is visible to PyInstaller, so the
        # module is guaranteed to be baked into the exe.
        #
        # NOTE: this import MUST stay below the HCC_DATA_DIR line above.
        # app/database.py reads that environment variable at import time to
        # decide where pharmacy.db lives; importing any earlier would point the
        # desktop build at the wrong folder.
        logging.info("Importing FastAPI app...")
        from app.main import app as fastapi_app
        logging.info("FastAPI app imported successfully")

        logging.info("Starting uvicorn...")
        uvicorn.run(
            fastapi_app,
            host="127.0.0.1",
            port=port,
            # "info" (not "warning") while we are diagnosing desktop startup —
            # this is what puts uvicorn's own "Application startup complete"
            # line into hcc.log, which proves the server finished booting.
            log_level="info",
            access_log=True,  # temporarily on while diagnosing startup
            # log_config=None tells uvicorn NOT to install its own logging
            # handlers.  Its default config writes to sys.stdout, which is a
            # dead end in a console=False Windows build — that is why uvicorn's
            # own "Application startup failed" traceback never reached hcc.log.
            # With no config of its own, uvicorn's loggers propagate up to the
            # root logger configured above, so everything lands in hcc.log.
            log_config=None,
        )
        # Reaching here means uvicorn shut down normally (or refused to serve).
        logging.info("uvicorn.run() returned — server has stopped")
    except Exception as e:
        import traceback
        logging.error(f"FATAL ERROR during startup: {e}")
        logging.error(traceback.format_exc())
        # Keep the process alive briefly so the log handler can flush to disk
        # before Windows tears the process down.
        import time
        time.sleep(5)
        sys.exit(1)
