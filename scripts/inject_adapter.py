#!/usr/bin/env python3
"""index.html 에 ble-native-adapter.js <script> 태그가 없으면 자동 삽입."""
import sys

path = sys.argv[1]
s = open(path, encoding="utf-8").read()
tag = '<script src="ble-native-adapter.js"></script>'

if "ble-native-adapter.js" in s:
    print("adapter already present")
    sys.exit(0)

if "<script" in s:
    s = s.replace("<script", tag + "\n    <script", 1)
elif "</body>" in s:
    s = s.replace("</body>", "  " + tag + "\n</body>", 1)
else:
    s = s + "\n" + tag + "\n"

open(path, "w", encoding="utf-8").write(s)
print("adapter injected ->", path)
