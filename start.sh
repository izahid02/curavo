#!/bin/bash
# Health Care Centre ERP — Start Script
# Run this to start the system. It activates the Python environment,
# launches the backend server (which also serves the React app), and
# opens the browser automatically after 2 seconds.

echo "============================================"
echo "  Health Care Centre ERP"
echo "============================================"

# Resolve the directory where this script lives, regardless of where
# you call it from.
DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"

# Activate the Python virtual environment created during setup.
source "$DIR/backend/venv/bin/activate"

# Move into the backend folder so relative imports work correctly.
cd "$DIR/backend"

echo "Starting server on http://localhost:8000 ..."
echo "(Browser will open automatically in 2 seconds)"
echo ""
echo "Press Ctrl+C to stop the server."
echo ""

# Open the browser after a short delay so the server has time to start.
# The '&' runs this in the background so it doesn't block the server.
(sleep 2 && open "http://localhost:8000") &

# Start the FastAPI server.
# --host 0.0.0.0  allows access from other devices on the same network
#                 (useful if you want to open the app on a phone/tablet).
# --port 8000     standard port for this project.
uvicorn app.main:app --host 0.0.0.0 --port 8000
