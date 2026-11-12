"""Whisper speech-to-text worker (faster-whisper, CPU).

Usage: python stt.py <model name or path> <download dir>
Reads one JSON request per line: {"id": n, "path": "/tmp/audio.webm"}
Writes one JSON line per request: {"id": n, "ok": true, "text": str, "seconds": float}
"""
import json
import subprocess
import sys
import time

import numpy as np
from faster_whisper import WhisperModel

model = WhisperModel(sys.argv[1], device="cpu", compute_type="int8", download_root=sys.argv[2])

# Nudges recognition toward the vocabulary a math/physics student actually says.
PROMPT = (
    "Calculus and physics tutoring. Partial derivative of f with respect to x, gradient, divergence, curl, "
    "integral, derivative, sine, cosine, tangent, theta, phi, pi, lambda, sigma, epsilon, delta, "
    "vector, matrix, determinant, eigenvalue, Lagrange multiplier, Jacobian, chain rule, product rule, "
    "x squared, e to the x, natural log, square root, orbit, gravity, Kepler, kilometers per second."
)


def load_audio(path: str) -> np.ndarray:
    """Decode any browser recording (webm/opus, mp4/aac, wav...) to 16 kHz mono with ffmpeg."""
    pcm = subprocess.run(
        ["ffmpeg", "-nostdin", "-loglevel", "error", "-i", path, "-f", "s16le", "-ac", "1", "-ar", "16000", "-"],
        capture_output=True,
        check=True,
        timeout=60,
    ).stdout
    return np.frombuffer(pcm, np.int16).astype(np.float32) / 32768.0


def transcribe(req):
    t = time.time()
    segments, info = model.transcribe(
        load_audio(req["path"]),
        language="en",
        beam_size=1,
        vad_filter=True,
        initial_prompt=PROMPT,
        condition_on_previous_text=False,
    )
    text = " ".join(s.text.strip() for s in segments).strip()
    return {"text": text, "seconds": round(time.time() - t, 2), "audio_seconds": round(info.duration, 2)}


sys.stdout.write(json.dumps({"ready": True}) + "\n")
sys.stdout.flush()
for line in sys.stdin:
    if not line.strip():
        continue
    req = json.loads(line)
    try:
        resp = {"id": req.get("id"), "ok": True, **transcribe(req)}
    except Exception as e:  # noqa: BLE001
        resp = {"id": req.get("id"), "ok": False, "error": f"{type(e).__name__}: {e}"}
    sys.stdout.write(json.dumps(resp) + "\n")
    sys.stdout.flush()
