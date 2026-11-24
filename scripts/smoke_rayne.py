"""One-shot live smoke test of the Rayne homeserver endpoint (no secrets).

Verifies: /warmup reachability, /v1/models, and the no-thinking response shape
the Ray desktop parser relies on. Rayne runs on the tailnet homeserver
(http://homeserver:8000) and needs no API key.
"""
import io, json, time, urllib.request

BASE = "http://homeserver:8000"


def req(method, url, body=None, timeout=60):
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(url, data=data, method=method,
                               headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(r, timeout=timeout) as resp:
        return resp.status, resp.read().decode()


status, text = req("GET", BASE + "/warmup")
print(f"warmup: HTTP {status} -> {text[:120]}")
assert status == 200, "homeserver /warmup not reachable"

status, text = req("GET", BASE + "/v1/models")
print(f"models: HTTP {status} -> {text[:120]}")
assert status == 200 and "rayne-1" in text

prompt = io.open(r"D:\dev\Ray\src-tauri\prompts\cleanup.md", encoding="utf-8").read().strip()
system = prompt + "\nDictionary: Creem, PostHog"
body = {"model": "rayne-1",
        "messages": [{"role": "system", "content": system},
                     {"role": "user", "content": "uh the cream payout landed and check post hog, the budget is one thousand dollars"}],
        "temperature": 0, "max_tokens": 512, "stream": False}
t0 = time.time()
status, text = req("POST", BASE + "/v1/chat/completions", body)
print(f"completion: HTTP {status} in {time.time()-t0:.2f}s")
assert status == 200, text[:300]
j = json.loads(text)
content = j["choices"][0]["message"]["content"]
print("finish_reason:", j["choices"][0].get("finish_reason"))
print("output:", repr(content))
assert "Creem" in content and "PostHog" in content and "$1,000" in content
assert "think>" not in content, "no-thinking model should not emit think tags"
print("OK")
