# -*- mode: python ; coding: utf-8 -*-
#
# PyInstaller build recipe for the HCC ERP backend.
#
# Build it with:   pyinstaller hcc_backend.spec
# Output:          dist/hcc-backend.exe   (on Windows / GitHub Actions)
#                  dist/hcc-backend       (on macOS/Linux, for local testing)
#
# The frozen exe is launched by Tauri as a "sidecar" (see src-tauri/src/main.rs).
# It runs main_desktop.py, which starts uvicorn on a free port.

from PyInstaller.utils.hooks import collect_all, collect_submodules

block_cipher = None

# ---------------------------------------------------------------------------
# Data files / binaries / hidden imports
# ---------------------------------------------------------------------------
datas = []
binaries = []

# collect_all pulls in package metadata + data files that these libraries load
# at runtime via importlib.metadata (a classic source of "works in dev, breaks
# when frozen" bugs).  We extend datas/binaries/hiddenimports from each.
# openpyxl writes the Schedule H1 register export.  Without it here the frozen
# build falls back to CSV while the dev machine produces .xlsx -- the export
# still works, which is worse: the difference is silent and only shows up on
# the pharmacy's PC.
# cryptography checks Curavo licence keys (services/licence.py imports its
# Ed25519 module directly, which jose alone never pulls into the bundle).
for pkg in ("fastapi", "starlette", "pydantic", "pydantic_settings",
            "uvicorn", "sqlalchemy", "jose", "bcrypt", "openpyxl",
            "cryptography"):
    _d, _b, _h = collect_all(pkg)
    datas += _d
    binaries += _b

# THE FIX for "No module named 'app'".
# main_desktop.py starts the server with uvicorn.run("app.main:app"), i.e. it
# asks Python to import the package BY NAME at runtime.  Relying only on the
# modules PyInstaller compiled into the archive was not enough on Windows, so
# we also copy the whole app/ folder into the bundle as plain data files.
# At runtime PyInstaller unpacks the bundle to a temp dir and puts that dir on
# sys.path, so "app" is then findable as an ordinary package on disk.
datas += [('app', 'app')]

hiddenimports = [
    'uvicorn',
    'uvicorn.logging',
    'uvicorn.loops',
    'uvicorn.loops.auto',
    'uvicorn.loops.asyncio',
    'uvicorn.protocols',
    'uvicorn.protocols.http',
    'uvicorn.protocols.http.auto',
    'uvicorn.protocols.http.h11_impl',
    'uvicorn.protocols.websockets',
    'uvicorn.protocols.websockets.auto',
    'uvicorn.lifespan',
    'uvicorn.lifespan.on',
    'uvicorn.main',
    'sqlalchemy.dialects.sqlite',
    'sqlalchemy.sql.default_comparator',
    'sqlalchemy.ext.declarative',
    'fastapi',
    'fastapi.middleware',
    'fastapi.middleware.cors',
    'starlette',
    'starlette.middleware',
    'pydantic',
    'pydantic.v1',
    'bcrypt',
    'jose',
    'jose.jwt',
    'jose.exceptions',
    'multipart',
    'aiofiles',
    'h11',
    'anyio',
    'anyio.abc',
    'anyio._backends._asyncio',
    'email_validator',
    'httpx',
]

# Pull in EVERY module under app.* automatically so a newly-added router /
# service / model can never be silently left out of the frozen build.
# This is generated from the real folder contents, so it can never drift out of
# sync with the code the way a hand-typed list would.
hiddenimports += ['app', 'app.main', 'app.database']
hiddenimports += collect_submodules('app')

a = Analysis(
    ['main_desktop.py'],
    # './app' is here so PyInstaller can resolve "app" itself while analysing,
    # even if it is invoked from somewhere other than the backend/ folder.
    pathex=['.', './app'],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        'tkinter', 'matplotlib', 'numpy', 'pandas',
        'PIL', 'cv2', 'torch', 'tensorflow',
        'IPython', 'jupyter', 'notebook',
    ],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.zipfiles,
    a.datas,
    [],
    name='hcc-backend',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[],
    runtime_tmpdir=None,
    # console=False → no black terminal window pops up behind the Tauri
    # window on Windows.  Errors still go to the rotating hcc.log file.
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon=None,
)
