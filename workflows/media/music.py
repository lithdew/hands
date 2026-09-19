"""Original deterministic instrumental score. No samples or downloaded music."""
import hashlib
import json
import math
import sys
import wave
from pathlib import Path
import numpy as np

RATE = 48000


def db(value):
    return round(20 * math.log10(max(float(value), 1e-12)), 3)


def analyze(path):
    with wave.open(str(path), "rb") as w:
        if w.getsampwidth() != 2 or w.getnframes() / w.getframerate() > 301:
            raise ValueError("Expected bounded PCM16 audio")
        rate, channels = w.getframerate(), w.getnchannels()
        samples = np.frombuffer(w.readframes(w.getnframes()), dtype="<i2").astype(np.float32).reshape(-1, channels) / 32768
    edge = min(len(samples), rate // 4)
    rms = lambda x: np.sqrt(np.mean(x.astype(np.float64) ** 2))
    return {"durationSeconds": len(samples) / rate, "sampleRate": rate, "channels": channels,
            "peakDbfs": db(np.max(np.abs(samples))), "rmsDbfs": db(rms(samples)),
            "firstQuarterSecondRmsDbfs": db(rms(samples[:edge])), "lastQuarterSecondRmsDbfs": db(rms(samples[-edge:])),
            "clippedSamples": int(np.count_nonzero(np.abs(samples) >= .999)),
            "sha256": hashlib.sha256(Path(path).read_bytes()).hexdigest()}


def compose(request, output):
    allowed = {"durationSeconds", "style", "tempoBpm", "intensity", "seed"}
    if set(request) - allowed: raise ValueError("Unknown music parameter")
    duration, tempo = float(request["durationSeconds"]), int(request.get("tempoBpm", 104))
    intensity, seed = float(request.get("intensity", .65)), int(request.get("seed", 23))
    style = request.get("style", "minimal-electronic")
    if not (3 <= duration <= 300 and 72 <= tempo <= 132 and .2 <= intensity <= 1 and 0 <= seed <= 65535) or style not in ("minimal-electronic", "warm-keys"):
        raise ValueError("Music request outside bounded contract")
    output = Path(output); metadata = Path(str(output) + ".json")
    if output.exists() or metadata.exists(): raise FileExistsError("Music output must be new")
    rng = np.random.default_rng(seed)
    score = np.zeros((round(duration * RATE), 2), dtype=np.float32)
    beat = 60 / tempo
    def add(start, sound, gain, pan=0):
        begin = round(start * RATE)
        if begin >= len(score): return
        sound = sound[:len(score) - begin]
        score[begin:begin + len(sound), 0] += sound * gain * math.sqrt((1 - pan) / 2)
        score[begin:begin + len(sound), 1] += sound * gain * math.sqrt((1 + pan) / 2)
    def tone(midi, seconds, voice):
        t = np.arange(round(seconds * RATE), dtype=np.float32) / RATE
        freq = 440 * 2 ** ((midi - 69) / 12)
        phase = 2 * np.pi * freq * t
        if voice == "pad":
            s = (np.sin(phase) + .3 * np.sin(phase * 1.003) + .12 * np.sin(2 * phase)) / 1.42
            envelope = np.minimum(t / .25, 1) * np.minimum((seconds - t) / .55, 1)
            return s * envelope * (.94 + .06 * np.sin(2 * np.pi * .37 * t))
        if voice == "bass":
            return (np.sin(phase) + .15 * np.sin(2 * phase)) * np.minimum(t / .012, 1) * np.exp(-t * 2.8) * np.minimum((seconds - t) / .08, 1)
        # Bell-soft electric keys: multiple decaying partials, not pure beeps.
        s = np.sin(phase + .48 * np.sin(phase * 2) * np.exp(-t * 4)) + .22 * np.sin(phase * 3) * np.exp(-t * 5)
        return s * np.minimum(t / .008, 1) * np.exp(-t * (2 if style == "warm-keys" else 2.9)) * np.minimum((seconds - t) / .12, 1)
    def noise(seconds, decay):
        t = np.arange(round(seconds * RATE), dtype=np.float32) / RATE
        white = rng.normal(0, 1, len(t)).astype(np.float32)
        bright = np.concatenate(([0], np.diff(white))) / 2
        return bright * np.exp(-t * decay) * np.minimum((seconds - t) / .015, 1)
    chords = [(45, [57, 60, 64, 71]), (41, [53, 57, 60, 64]), (48, [55, 60, 64, 71]), (43, [55, 59, 62, 69])]
    motif = [0, 2, 1, 3, 2, 1, 3, 0]
    bars = math.ceil(duration / (4 * beat))
    for bar in range(bars):
        time = bar * 4 * beat; root, chord = chords[bar % len(chords)]
        final = time > duration - 7
        breakdown = bar % 16 in (8, 9)
        for i, note in enumerate(chord): add(time + i * .022, tone(note, 4 * beat + .5, "pad"), .073, -.65 + i * .43)
        for n, offset in enumerate([0, 1.5, 2.5, 3.25]):
            if bar == 0 and n > 1 or final and n > 1: continue
            note = chord[motif[(bar * 4 + n + seed) % len(motif)]] + 12
            add(time + offset * beat, tone(note, 2.4 * beat, "keys"), .15 if style == "warm-keys" else .12, math.sin(bar + n) * .32)
        if bar >= 1 and not final:
            for offset in (0, 2): add(time + offset * beat, tone(root, 1.9 * beat, "bass"), .24)
        if bar >= 2 and not final:
            dynamics = intensity * (.48 if breakdown else 1)
            for offset in (0, 2):
                t = np.arange(round(.25 * RATE), dtype=np.float32) / RATE
                kick = np.sin(2 * np.pi * (48 * t + 2.6 * (1 - np.exp(-t * 25)))) * np.exp(-t * 18)
                add(time + offset * beat, kick, .23 * dynamics)
            for offset in (1, 3): add(time + offset * beat, noise(.2, 27), .072 * dynamics, .08)
            for i in range(8): add(time + i * beat / 2 + (0.018 if i % 2 else 0), noise(.09, 58), .022 * dynamics * (1 if i % 2 else .65), -.35 if i % 2 else .35)
    # Short stereo room/echo tails lend a coherent space without external samples.
    for delay, gain in [(.13, .14), (.27, .09), (.41, .04)]:
        n = round(delay * RATE)
        score[n:] += score[:-n, ::-1] * gain
    score = np.tanh(score * 1.12)
    fade_in, fade_out = min(2.2, duration / 5), min(3.0, duration / 4)
    a, b = round(fade_in * RATE), round(fade_out * RATE)
    score[:a] *= np.linspace(0, 1, a, dtype=np.float32)[:, None] ** 1.4
    score[-b:] *= np.linspace(1, 0, b, dtype=np.float32)[:, None] ** 1.6
    score *= .68 / max(float(np.max(np.abs(score))), 1e-9)
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open("xb") as handle:
        with wave.open(handle, "wb") as w:
            w.setnchannels(2); w.setsampwidth(2); w.setframerate(RATE)
            w.writeframes(np.round(score * 32767).astype("<i2").tobytes())
    result = {"version": 1, "generator": "Hands original-score-v1", "original": True,
              "style": style, "tempoBpm": tempo, "intensity": intensity, "seed": seed,
              "arrangement": "Four-chord extended voicings, soft electric-key motif, sub bass, synthesized percussion, stereo room, phrase breakdown and outro",
              "externalSamples": [], "fadeInSeconds": fade_in, "fadeOutSeconds": fade_out, **analyze(output)}
    with metadata.open("x", encoding="utf8") as handle: json.dump(result, handle, indent=2)
    print(json.dumps(result))


if __name__ == "__main__":
    if len(sys.argv) == 4 and sys.argv[1] == "--analyze":
        result = analyze(sys.argv[2]); Path(sys.argv[3]).write_text(json.dumps(result, indent=2), encoding="utf8"); print(json.dumps(result))
    elif len(sys.argv) == 3:
        compose(json.loads(Path(sys.argv[1]).read_text(encoding="utf8")), sys.argv[2])
    else: raise SystemExit("music.py request.json output.wav | music.py --analyze input.wav output.json")
