from __future__ import annotations

import math
import os
import shutil
from pathlib import Path

from playwright.async_api import async_playwright


class BrowserRenderer:
    def __init__(
        self,
        width: int = 1080,
        height: int = 1920,
        fps: int = 30,
        chromium_path: str | None = None,
    ) -> None:
        self.width = width
        self.height = height
        self.fps = fps
        self.chromium_path = chromium_path or os.environ.get("CHROMIUM_PATH") or self._find_chromium()

    @staticmethod
    def _find_chromium() -> str | None:
        for executable in ("chromium", "chromium-browser", "google-chrome", "google-chrome-stable"):
            path = shutil.which(executable)
            if path:
                return path
        return None

    async def capture_frames(self, preview_url: str, trip_id: str, frames_dir: Path) -> tuple[int, float]:
        frames_dir.mkdir(parents=True, exist_ok=True)
        url = f"{preview_url}?trip_id={trip_id}&render=1"
        async with async_playwright() as playwright:
            launch_args = {"headless": True}
            if self.chromium_path:
                launch_args["executable_path"] = self.chromium_path
            browser = await playwright.chromium.launch(**launch_args)
            try:
                context = await browser.new_context(viewport={"width": self.width, "height": self.height})
                page = await context.new_page()
                await page.goto(url, wait_until="networkidle")
                await page.wait_for_function("window.tripReady === true", timeout=60_000)
                duration = float(await page.evaluate("window.timelineData.duration_seconds"))
                frame_count = max(1, math.ceil(duration * self.fps))
                for index in range(frame_count):
                    video_time = min(duration, index / self.fps)
                    await page.evaluate("time => window.setTripTime(time)", video_time)
                    await page.screenshot(path=str(frames_dir / f"frame-{index:06d}.png"))
                return frame_count, duration
            finally:
                await browser.close()
