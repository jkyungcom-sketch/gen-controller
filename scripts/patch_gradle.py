#!/usr/bin/env python3
"""build.gradle 에 release signingConfig 주입 (멱등)."""
import os, sys

path = sys.argv[1]
s = open(path, encoding="utf-8").read()

if "signingConfigs" in s:
    print("signing config already present")
    sys.exit(0)

block = """
    signingConfigs {
        release {
            storeFile file("%s")
            storePassword "%s"
            keyAlias "%s"
            keyPassword "%s"
        }
    }
    buildTypes {
        release {
            signingConfig signingConfigs.release
            minifyEnabled false
        }
    }
""" % (os.environ["KS_FILE"], os.environ["KS_PASS"], os.environ["KS_ALIAS"], os.environ["KS_PASS"])

s = s.replace("android {", "android {\n" + block, 1)
open(path, "w", encoding="utf-8").write(s)
print("signing config injected ->", path)
