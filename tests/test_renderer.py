from pathlib import Path

from app.renderer.ffmpeg import build_ffmpeg_command


def test_ffmpeg_command_targets_h264_vertical_frames() -> None:
    command = build_ffmpeg_command(Path("/tmp/frames"), Path("/tmp/out.mp4"), fps=30)
    assert command[0] == "ffmpeg"
    assert "libx264" in command
    assert "yuv420p" in command
    assert "/tmp/frames/frame-%06d.png" in command
    assert command[-1] == "/tmp/out.mp4"
