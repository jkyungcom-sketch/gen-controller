#!/usr/bin/env python3
"""AndroidManifest.xml 에 BLE + Wi-Fi 권한 주입 (멱등).

★ 중요 이력 (2026-11-12):
  ACCESS_FINE_LOCATION 에 android:maxSdkVersion="30" 이 붙어 있었다.
  → Android 12(API 31)+ 기기에서는 위치 권한이 "선언되지 않은 앱" 으로 처리되어
     WifiManager.getScanResults() / getConnectionInfo().getSSID() 가
     빈 목록 / "<unknown ssid>" 를 반환했다. (스캔·PIN·연결 전부 실패의 뿌리)
  → maxSdkVersion 을 제거하고, ACCESS_COARSE_LOCATION 과
     NEARBY_WIFI_DEVICES(usesPermissionFlags=neverForLocation) 를 함께 선언한다.
"""
import re
import sys

path = sys.argv[1]
s = open(path, encoding="utf-8").read()

# 각 권한을 개별 태그로 관리 → 개별 멱등 삽입이 가능
PERMS = [
    ("BLUETOOTH_SCAN",
     '<uses-permission android:name="android.permission.BLUETOOTH_SCAN"'
     ' android:usesPermissionFlags="neverForLocation" />'),
    ("BLUETOOTH_CONNECT",
     '<uses-permission android:name="android.permission.BLUETOOTH_CONNECT" />'),
    ("android.permission.BLUETOOTH\"",
     '<uses-permission android:name="android.permission.BLUETOOTH"'
     ' android:maxSdkVersion="30" />'),
    ("BLUETOOTH_ADMIN",
     '<uses-permission android:name="android.permission.BLUETOOTH_ADMIN"'
     ' android:maxSdkVersion="30" />'),
    # ★ maxSdkVersion 없이 — 12+ 에서도 위치 권한 살아 있어야 SSID 스캔 가능
    ("android.permission.ACCESS_FINE_LOCATION",
     '<uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" />'),
    ("android.permission.ACCESS_COARSE_LOCATION",
     '<uses-permission android:name="android.permission.ACCESS_COARSE_LOCATION" />'),
    ("NEARBY_WIFI_DEVICES",
     '<uses-permission android:name="android.permission.NEARBY_WIFI_DEVICES"'
     ' android:usesPermissionFlags="neverForLocation" />'),
    ("ACCESS_WIFI_STATE",
     '<uses-permission android:name="android.permission.ACCESS_WIFI_STATE" />'),
    ("CHANGE_WIFI_STATE",
     '<uses-permission android:name="android.permission.CHANGE_WIFI_STATE" />'),
    ("ACCESS_NETWORK_STATE",
     '<uses-permission android:name="android.permission.ACCESS_NETWORK_STATE" />'),
    ("CHANGE_NETWORK_STATE",
     '<uses-permission android:name="android.permission.CHANGE_NETWORK_STATE" />'),
    ("android.permission.WAKE_LOCK",
     '<uses-permission android:name="android.permission.WAKE_LOCK" />'),
    ("android.permission.INTERNET",
     '<uses-permission android:name="android.permission.INTERNET" />'),
    ("android.permission.POST_NOTIFICATIONS",
     '<uses-permission android:name="android.permission.POST_NOTIFICATIONS" />'),
    ("android.permission.SCHEDULE_EXACT_ALARM",
     '<uses-permission android:name="android.permission.SCHEDULE_EXACT_ALARM" />'),
]

FEATURES = [
    ("android.hardware.bluetooth_le",
     '<uses-feature android:name="android.hardware.bluetooth_le" android:required="true" />'),
    ("android.hardware.wifi",
     '<uses-feature android:name="android.hardware.wifi" android:required="true" />'),
]

added = []

# ① 기존에 maxSdkVersion 이 붙은 ACCESS_FINE_LOCATION / ACCESS_COARSE_LOCATION 을 정리
for perm in ("ACCESS_FINE_LOCATION", "ACCESS_COARSE_LOCATION"):
    pat = re.compile(
        r'\s*<uses-permission\s+android:name="android\.permission\.%s"[^>]*maxSdkVersion[^>]*/>'
        % perm)
    if pat.search(s):
        s = pat.sub("", s)
        added.append("remove maxSdkVersion from " + perm)

# ② 빠진 권한만 개별 삽입
for needle, tag in PERMS + FEATURES:
    if needle not in s:
        s = re.sub(r"(<manifest[^>]*>)",
                   lambda m: m.group(1) + "\n    " + tag, s, count=1)
        added.append(tag.split('android:name="')[1].split('"')[0])

# ③ cleartext (ESP32 http://192.168.4.1 통신)
if "usesCleartextTraffic" not in s:
    s = s.replace("<application",
                  '<application android:usesCleartextTraffic="true"', 1)
    added.append("usesCleartextTraffic=true")

open(path, "w", encoding="utf-8").write(s)

print("추가/수정:", ", ".join(added) if added else "(변경 없음 — 이미 완비)")

# ④ 검증: 필수 권한이 실제로 다 있는지 (없으면 빌드 실패)
REQUIRED = [
    "ACCESS_FINE_LOCATION", "ACCESS_COARSE_LOCATION", "NEARBY_WIFI_DEVICES",
    "ACCESS_WIFI_STATE", "CHANGE_WIFI_STATE",
    "ACCESS_NETWORK_STATE", "CHANGE_NETWORK_STATE", "INTERNET",
]
missing = [r for r in REQUIRED if r not in s]
if missing:
    print("!! 필수 권한 누락:", missing, file=sys.stderr)
    sys.exit(1)

# ⑤ 치명 검사: 위치 권한에 maxSdkVersion 이 다시 붙으면 즉시 실패
for perm in ("ACCESS_FINE_LOCATION", "ACCESS_COARSE_LOCATION"):
    if re.search(r'android\.permission\.%s"[^>]*maxSdkVersion' % perm, s):
        print("!! %s 에 maxSdkVersion 이 남아 있음 — Android12+ 스캔 불가" % perm,
              file=sys.stderr)
        sys.exit(1)

print("manifest patched ->", path)
