#!/bin/sh
# Builds ~/Applications/Cutroom.app (native AppKit + WebKit window around server.py) from Cutroom.swift.
set -eu
cd "$(dirname "$0")"
APP="$HOME/Applications/Cutroom.app"
REPO="$(cd .. && pwd)"
PYTHON="$(command -v python3)"
BIN="$(mktemp -d)/Cutroom"

swiftc -O -target arm64-apple-macos14.0 Cutroom.swift -o "$BIN" # fails before the old bundle is touched

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
mv "$BIN" "$APP/Contents/MacOS/Cutroom"
cp Cutroom.icns "$APP/Contents/Resources/Cutroom.icns"
cat > "$APP/Contents/Info.plist" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Cutroom</string>
  <key>CFBundleDisplayName</key><string>Cutroom</string>
  <key>CFBundleIdentifier</key><string>com.marat.cutroom</string>
  <key>CFBundleExecutable</key><string>Cutroom</string>
  <key>CFBundleIconFile</key><string>Cutroom</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>LSApplicationCategoryType</key><string>public.app-category.video</string>
  <key>NSPrincipalClass</key><string>NSApplication</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSMicrophoneUsageDescription</key><string>Cutroom records voiceovers from your microphone.</string>
  <key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
  <key>CFBundleDocumentTypes</key>
  <array><dict>
    <key>CFBundleTypeName</key><string>Media</string>
    <key>CFBundleTypeRole</key><string>Viewer</string>
    <key>LSHandlerRank</key><string>Alternate</string>
    <key>LSItemContentTypes</key><array><string>public.movie</string><string>public.audio</string><string>public.image</string></array>
  </dict></array>
</dict>
</plist>
EOF
/usr/libexec/PlistBuddy -c "Add :CutroomRepo string $REPO" -c "Add :CutroomPython string $PYTHON" "$APP/Contents/Info.plist"
plutil -lint "$APP/Contents/Info.plist"
codesign --force --deep -s - "$APP"
# Re-read the new Info.plist (the old stub was LSUIElement) and icon.
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$APP"
echo "Built $APP"
