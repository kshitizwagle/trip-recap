from __future__ import annotations

import asyncio
from pathlib import Path


def build_ffmpeg_command(frames_dir: Path, output_path: Path, fps: int = 30) -> list[str]:
    return [
        "ffmpeg",
        "-y",
        "-framerate",
        str(fps),
        "-i",
        str(frames_dir / "frame-%06d.png"),
        "-c:v",
        "libx264",
        "-preset",
        "medium",
        "-crf",
        "20",
        "-pix_fmt",
        "yuv420p",
        "-movflags",
        "+faststart",
        str(output_path),
    ]


async def encode_frames(frames_dir: Path, output_path: Path, fps: int = 30) -> None:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    process = await asyncio.create_subprocess_exec(
        *build_ffmpeg_command(frames_dir, output_path, fps),
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    _, stderr = await process.communicate()
    if process.returncode != 0:
        raise RuntimeError(f"ffmpeg failed: {stderr.decode(errors='replace')[-4000:]}")
