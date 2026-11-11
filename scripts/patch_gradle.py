#!/usr/bin/env python3
"""build.gradle 에 release signingConfig 주입 (멱등).

핵심:
  - signingConfigs 는 android {} 안 맨 앞에 삽입
  - 기존 buildTypes.release 블록을 '찾아서' signingConfig 한 줄만 주입
  - buildTypes 를 새로 만들지 않는다 (중복 선언 시 Gradle 이 마지막 것을 써서
    signingConfig 가 무효화되는 사고 방지)
"""
import os
import re
import sys


def find_block_end(s, start):
    """start 위치의 '{' 부터 짝이 맞는 '}' 다음 위치를 반환."""
    depth = 0
    i = start
    while i < len(s):
        c = s[i]
        if c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0:
                return i + 1
        i += 1
    return -1


def main():
    path = sys.argv[1]
    s = open(path, encoding="utf-8").read()
    orig = s

    ks_file = os.environ["KS_FILE"]
    ks_pass = os.environ["KS_PASS"]
    ks_alias = os.environ["KS_ALIAS"]

    # ---------- 1) signingConfigs 주입 ----------
    signing_block = """    signingConfigs {
        release {
            storeFile file("%s")
            storePassword "%s"
            keyAlias "%s"
            keyPassword "%s"
            v1SigningEnabled true
            v2SigningEnabled true
        }
    }
""" % (ks_file, ks_pass, ks_alias, ks_pass)

    if "signingConfigs" in s:
        # 이미 있으면 기존 블록을 새 값으로 교체
        m = re.search(r"^(\s*)signingConfigs\s*\{", s, re.M)
        if m:
            start = s.index("{", m.start())
            end = find_block_end(s, start)
            indent = m.group(1)
            new_blk = signing_block.replace("    signingConfigs", indent + "signingConfigs", 1)
            s = s[:m.start()] + new_blk.rstrip() + "\n" + indent + s[end:].lstrip("\n")
            print("signingConfigs 기존 블록 교체")
        else:
            print("WARN: signingConfigs 문자열은 있으나 블록 파싱 실패")
    else:
        m = re.search(r"^(\s*)android\s*\{", s, re.M)
        if not m:
            print("ERROR: android {} 블록을 찾을 수 없음", file=sys.stderr)
            sys.exit(1)
        insert_at = s.index("{", m.start()) + 1
        indent = m.group(1)
        blk = "\n" + signing_block.replace("    signingConfigs", indent + "    signingConfigs", 1)
        s = s[:insert_at] + blk + s[insert_at:]
        print("signingConfigs 신규 주입 (android 블록 맨 앞)")

    # ---------- 2) 기존 buildTypes.release 안에 signingConfig 한 줄 추가 ----------
    bt = re.search(r"^(\s*)buildTypes\s*\{", s, re.M)
    if not bt:
        print("ERROR: buildTypes {} 를 찾을 수 없음", file=sys.stderr)
        sys.exit(1)

    bt_start = s.index("{", bt.start())
    bt_end = find_block_end(s, bt_start)
    bt_body = s[bt_start + 1:bt_end - 1]
    bt_indent = bt.group(1)

    rel = re.search(r"^(\s*)release\s*\{", bt_body, re.M)
    if rel:
        rel_open = bt_body.index("{", rel.start())
        rel_close = find_block_end(bt_body, rel_open)
        rel_body = bt_body[rel_open + 1:rel_close - 1]
        rel_indent = rel.group(1)

        if "signingConfig" in rel_body:
            rel_body = re.sub(
                r"^\s*signingConfig\s+signingConfigs\.\w+\s*$",
                "%ssigningConfig signingConfigs.release" % rel_indent,
                rel_body, count=1, flags=re.M)
            print("기존 signingConfig 줄 갱신")
        else:
            rel_body = "\n%ssigningConfig signingConfigs.release" % rel_indent + rel_body
            print("buildTypes.release 에 signingConfig 주입")

        new_rel = "%srelease {%s\n%s}" % (rel.group(1), rel_body.rstrip(), rel_indent)
        # 정확한 범위 치환
        bt_body = bt_body[:rel.start()] + new_rel + bt_body[rel_close:]
    else:
        print("ERROR: buildTypes 안에 release 블록 없음", file=sys.stderr)
        sys.exit(1)

    s = s[:bt_start + 1] + bt_body + s[bt_end - 1:]

    if s == orig:
        print("변경 없음 (이미 적용됨)")
    else:
        open(path, "w", encoding="utf-8").write(s)
        print("build.gradle 서명 설정 적용 완료 ->", path)

    # ---------- 3) 검증: buildTypes 선언 횟수 ----------
    n_bt = len(re.findall(r"^\s*buildTypes\s*\{", s, re.M))
    n_sc = len(re.findall(r"^\s*signingConfigs\s*\{", s, re.M))
    print("검증: buildTypes 블록 %d개 / signingConfigs 블록 %d개" % (n_bt, n_sc))
    if n_bt != 1:
        print("ERROR: buildTypes 가 %d개 (1개여야 함)" % n_bt, file=sys.stderr)
        sys.exit(1)
    if "signingConfig signingConfigs.release" not in s:
        print("ERROR: signingConfig 연결 실패", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
