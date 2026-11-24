import io, re

src = io.open(r"D:\dev\rayne\dataset\build.py", encoding="utf-8").read()
m = re.search(r"PROMPT = \((.*?)\)\n", src, re.S)
parts = re.findall(r'"((?:[^"\\]|\\.)*)"', m.group(1))
prompt = "".join(parts)
embedded = io.open(r"D:\dev\Ray\src-tauri\prompts\cleanup.md", encoding="utf-8").read().strip()
print("MATCH" if prompt == embedded else "MISMATCH")
if prompt != embedded:
    print("build.py:", repr(prompt))
    print("embedded:", repr(embedded))
