#!/bin/bash
# Health Care Centre ERP — Mac double-click launcher
#
# On macOS, files ending in .command can be double-clicked in Finder
# and will open in Terminal automatically. This file simply delegates
# to start.sh so there is only one place to maintain the logic.

# Change to the folder containing this file, then run start.sh.
cd "$(dirname "$0")"
./start.sh
