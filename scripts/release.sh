#!/bin/bash
# Cut a new release: bump every version file in lock-step, commit, and tag.
# Pushing the tag triggers .github/workflows/build-desktop.yml, which builds
# the Windows installer in the cloud.
#
# Usage: ./scripts/release.sh 0.1.0-beta
set -e

VERSION=$1
if [ -z "$VERSION" ]; then
    echo "Usage: $0 <version>"
    exit 1
fi

echo "Releasing version $VERSION..."

# 1) Tauri desktop config version (macOS/BSD sed needs the '' after -i).
sed -i '' "s/\"version\": \".*\"/\"version\": \"$VERSION\"/" \
    frontend/src-tauri/tauri.conf.json

# 2) Frontend package.json version.
cd frontend && npm version "$VERSION" --no-git-tag-version --allow-same-version && cd ..

# 3) Backend version module.
cat > backend/app/version.py <<EOF
"""
Single source of truth for the application's version string.
Rewritten by scripts/release.sh — edit the release script, not this file.
"""
VERSION = "$VERSION"
APP_NAME = "Health Care Centre ERP"
POWERED_BY = "ARZ Technologies"
EOF

# 4) Commit and tag.
git add -A
git commit -m "chore: release v$VERSION"
git tag "v$VERSION"

echo ""
echo "Done! Now run:"
echo "  git push && git push --tags"
echo ""
echo "GitHub Actions will build the Windows installer automatically."
