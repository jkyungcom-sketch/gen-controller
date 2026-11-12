#!/usr/bin/env python3
"""Capacitor 안드로이드 프로젝트에 AndroidWifiBridge 주입 (멱등).

수행:
 1) android/app/src/main/java/org/jkyung/generator/AndroidWifiBridge.java 복사
 2) MainActivity.java 를 BridgeActivity 확장 + 브릿지 주입 버전으로 교체
    (이미 우리 버전이면 스킵)
 3) AndroidManifest.xml 에 Wi-Fi/네트워크 권한 추가
"""
import os
import re
import shutil
import sys

PKG_DIR = "android/app/src/main/java/org/jkyung/generator"
SRC_DIR = "android_bridge"

FILES = ["AndroidWifiBridge.java", "MainActivity.java"]

WIFI_PERMS = """
    <uses-permission android:name="android.permission.ACCESS_NETWORK_STATE" />
    <uses-permission android:name="android.permission.CHANGE_NETWORK_STATE" />
    <uses-permission android:name="android.permission.ACCESS_WIFI_STATE" />
    <uses-permission android:name="android.permission.CHANGE_WIFI_STATE" />
    <uses-permission android:name="android.permission.CHANGE_WIFI_MULTICAST_STATE" />
    <uses-permission android:name="android.permission.NEARBY_WIFI_DEVICES" android:usesPermissionFlags="neverForLocation" />
    <uses-permission android:name="android.permission.INTERNET" />
    <uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" />
"""


def patch_manifest(path):
    s = open(path, encoding="utf-8").read()
    orig = s
    added = []

    for perm in ["ACCESS_NETWORK_STATE", "CHANGE_NETWORK_STATE", "ACCESS_WIFI_STATE",
                 "CHANGE_WIFI_STATE", "NEARBY_WIFI_DEVICES"]:
        if perm not in s:
            # 필요한 한 줄만 뽑아 삽입
            line = next((l.strip() for l in WIFI_PERMS.splitlines() if perm in l), None)
            if line:
                s = re.sub(r"(<manifest[^>]*>)", lambda m: m.group(1) + "\n    " + line, s, count=1)
                added.append(perm)

    if "android:usesCleartextTraffic" not in s:
        s = s.replace("<application", '<application android:usesCleartextTraffic="true"', 1)
        added.append("usesCleartextTraffic")

    # API 33 미만에서 NEARBY_WIFI_DEVICES 는 알 수 없는 권한 경고만 발생 → 제거하지 않음(무해)
    if s != orig:
        open(path, "w", encoding="utf-8").write(s)
    print("  manifest 패치: %s" % (", ".join(added) if added else "변경 없음"))
    return True


def main():
    if not os.path.isdir(PKG_DIR):
        print("ERROR: 패키지 디렉터리 없음: %s" % PKG_DIR, file=sys.stderr)
        print("  (npx cap add android 가 먼저 실행돼야 함)", file=sys.stderr)
        sys.exit(1)

    for f in FILES:
        src = os.path.join(SRC_DIR, f)
        dst = os.path.join(PKG_DIR, f)
        if not os.path.exists(src):
            print("ERROR: 소스 없음: %s" % src, file=sys.stderr)
            sys.exit(1)
        shutil.copyfile(src, dst)
        print("  ✅ %s → %s (%d bytes)" % (src, dst, os.path.getsize(dst)))

    # MainActivity 가 BridgeActivity 를 확장하는지 확인
    ma = open(os.path.join(PKG_DIR, "MainActivity.java"), encoding="utf-8").read()
    if "extends BridgeActivity" not in ma:
        print("ERROR: MainActivity 가 BridgeActivity 를 확장하지 않음", file=sys.stderr)
        sys.exit(1)
    if "addJavascriptInterface" not in ma:
        print("ERROR: 브릿지 주입 코드 없음", file=sys.stderr)
        sys.exit(1)
    print("  ✅ MainActivity 검증 OK (extends BridgeActivity + addJavascriptInterface)")

    mf = "android/app/src/main/AndroidManifest.xml"
    if os.path.exists(mf):
        patch_manifest(mf)
    else:
        print("  ⚠️ AndroidManifest.xml 없음: %s" % mf)

    print("AndroidWifiBridge 주입 완료")


if __name__ == "__main__":
    main()
