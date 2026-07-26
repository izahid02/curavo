"""
Single source of truth for the application's version string.

The release script (scripts/release.sh) rewrites this file so the number here,
in package.json and in tauri.conf.json always move together.  The /health
endpoint reads VERSION so the running backend can report exactly which build
is installed on a given pharmacy PC.
"""
VERSION = "0.1.0-beta"
APP_NAME = "Health Care Centre ERP"
POWERED_BY = "ARZ Technologies"
