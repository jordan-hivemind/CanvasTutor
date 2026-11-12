"""Kokoro text-to-speech worker.

Usage: python tts.py <model.onnx> <voices.bin>
Reads one JSON request per line: {"id": n, "text": str, "voice": str, "speed": float}
Writes one JSON line per request: {"id": n, "ok": true, "wav": <base64 16-bit PCM WAV>, "seconds": float}
"""
import base64
import io
import json
import sys
import time

import soundfile as sf
from kokoro_onnx import Kokoro

kokoro = Kokoro(sys.argv[1], sys.argv[2])
VOICES = set(kokoro.get_voices())


def synth(req):
    voice = req.get("voice") if req.get("voice") in VOICES else "af_heart"
    speed = min(1.6, max(0.6, float(req.get("speed") or 1.0)))
    t = time.time()
    samples, sr = kokoro.create(req["text"][:1200], voice=voice, speed=speed, lang="en-us")
    buf = io.BytesIO()
    sf.write(buf, samples, sr, format="WAV", subtype="PCM_16")
    return {"wav": base64.b64encode(buf.getvalue()).decode("ascii"), "seconds": len(samples) / sr, "synth_seconds": time.time() - t}


sys.stdout.write(json.dumps({"ready": True}) + "\n")
sys.stdout.flush()
for line in sys.stdin:
    if not line.strip():
        continue
    req = json.loads(line)
    try:
        resp = {"id": req.get("id"), "ok": True, **synth(req)}
    except Exception as e:  # noqa: BLE001
        resp = {"id": req.get("id"), "ok": False, "error": f"{type(e).__name__}: {e}"}
    sys.stdout.write(json.dumps(resp) + "\n")
    sys.stdout.flush()
