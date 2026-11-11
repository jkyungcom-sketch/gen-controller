#!/usr/bin/env python3
"""AndroidManifest.xml 에 BLE 권한 주입 (멱등)."""
import re, sys

path = sys.argv[1]
s = open(path, encoding="utf-8").read()

PERMS = """
    <uses-permission android:name="android.permission.BLUETOOTH_SCAN" android:usesPermissionFlags="neverForLocation" />
    <uses-permission android:name="android.permission.BLUETOOTH_CONNECT" />
    <uses-permission android:name="android.permission.BLUETOOTH" android:maxSdkVersion="30" />
    <uses-permission android:name="android.permission.BLUETOOTH_ADMIN" android:maxSdkVersion="30" />
    <uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" android:maxSdkVersion="30" />
    <uses-permission android:name="android.permission.WAKE_LOCK" />
    <uses-feature android:name="android.hardware.bluetooth_le" android:required="true" />
"""

if "BLUETOOTH_SCAN" not in s:
    s = re.sub(r"(<manifest[^>]*>)", lambda m: m.group(1) + "\n" + PERMS, s, count=1)
    print("permissions injected")

if "usesCleartextTraffic" not in s:
    s = s.replace("<application", '<application android:usesCleartextTraffic="true"', 1)
    print("cleartext patched")

open(path, "w", encoding="utf-8").write(s)
print("manifest patched ->", path)
