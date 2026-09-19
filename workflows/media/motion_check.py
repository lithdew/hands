"""Measure actual MP4 intra-scene changes; this is evidence, not an aesthetic score."""
import json
import subprocess
import sys
from pathlib import Path

import numpy as np
from PIL import Image


def compare_frames(a, b):
    if a.shape != b.shape or a.ndim != 3 or a.shape[2] != 3:
        raise ValueError("Motion samples must be matching RGB frames")
    # Exclude branding, captions and the progress bar so those alone cannot pass.
    height = a.shape[0]
    delta = np.abs(a[int(height * 70 / 720):int(height * 540 / 720)].astype(np.float32)
                   - b[int(height * 70 / 720):int(height * 540 / 720)].astype(np.float32))
    mean = float(delta.mean() / 255)
    fraction = float((delta.max(axis=2) > 8).mean())
    return {"meanAbsoluteDifference": round(mean, 6), "changedPixelFraction": round(fraction, 6),
            "measurableChange": mean >= .003 and fraction >= .01}


def measure(out, ffmpeg):
    out = Path(out)
    spec = json.loads((out / "storyboard.normalized.json").read_text(encoding="utf-8"))
    video = out / "video.mp4"
    if not video.is_file() or not 1 <= len(spec["scenes"]) <= 20:
        raise ValueError("Expected a bounded rendered storyboard")
    preferred = [s for s in spec["scenes"] if s.get("layout") in ("workflow", "artifact-stage", "task-field") or s["visual"] == "matrix"]
    selected = (preferred + [s for s in spec["scenes"] if s not in preferred])[:3]
    folder = out / "motion-samples"
    folder.mkdir(exist_ok=False)
    samples = []
    for scene in selected:
        paths, times = [], []
        for fraction in (.2, .6):
            frame = scene["startFrame"] + round((scene["frames"] - 1) * fraction)
            seconds = frame / spec["fps"]
            destination = folder / f"{scene['id']}-{int(fraction*100)}.png"
            subprocess.run([ffmpeg, "-v", "error", "-ss", str(seconds), "-i", str(video), "-frames:v", "1",
                            "-vf", "scale=640:360", str(destination)], check=True, timeout=20,
                           stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
            paths.append(destination)
            times.append(round(seconds, 4))
        result = compare_frames(*[np.asarray(Image.open(p).convert("RGB")) for p in paths])
        samples.append({"scene": scene["id"], "timesSeconds": times,
                        "files": [p.relative_to(out).as_posix() for p in paths], **result})
    report = {"version": 1, "method": "Actual MP4 decoded frames at 20% and 60% of up to three scenes; RGB difference in content band y=70..540 at 1280x720 equivalent",
              "threshold": {"meanAbsoluteDifference": .003, "changedPixelFraction": .01, "pixelThreshold": 8},
              "interpretation": "Pixel change establishes observable intra-scene changes only; it does not prove semantic motion, design quality or legibility.",
              "sampledSceneCount": len(samples), "measurableChangeSceneCount": sum(s["measurableChange"] for s in samples), "samples": samples}
    (out / "motion-measurements.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    return report


if __name__ == "__main__":
    measure(sys.argv[1], sys.argv[2])
