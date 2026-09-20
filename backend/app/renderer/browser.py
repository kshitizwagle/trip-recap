from __future__ import annotations

import math
import os
import shutil
from pathlib import Path

from playwright.async_api import async_playwright

from app.config import settings


class BrowserRenderer:
    def __init__(self,width:int=1080,height:int=1920,fps:int|None=None,chromium_path:str|None=None,max_duration_seconds:float|None=None)->None:
        self.width=width; self.height=height; self.fps=fps or settings.render_fps; self.max_duration_seconds=max_duration_seconds or settings.render_max_seconds
        self.chromium_path=chromium_path or os.environ.get("CHROMIUM_PATH") or self._find_chromium()

    @staticmethod
    def _find_chromium()->str|None:
        for executable in ("chromium","chromium-browser","google-chrome","google-chrome-stable"):
            if path:=shutil.which(executable): return path
        return None

    async def capture_frames(self,preview_url:str,trip_id:str,frames_dir:Path)->tuple[int,float]:
        frames_dir.mkdir(parents=True,exist_ok=True); url=f"{preview_url}?trip_id={trip_id}&render=1"
        async with async_playwright() as playwright:
            launch={"headless":True,"args":["--no-sandbox","--disable-dev-shm-usage"]}
            if self.chromium_path: launch["executable_path"]=self.chromium_path
            browser=await playwright.chromium.launch(**launch)
            try:
                context=await browser.new_context(viewport={"width":self.width,"height":self.height}); page=await context.new_page(); await page.goto(url,wait_until="domcontentloaded"); await page.wait_for_function("window.tripReady === true",timeout=60_000)
                source_duration=float(await page.evaluate("window.timelineData.duration_seconds")); output_duration=min(source_duration,self.max_duration_seconds); frame_count=max(1,math.ceil(output_duration*self.fps))
                for index in range(frame_count):
                    progress=0 if frame_count==1 else index/(frame_count-1); source_time=source_duration*progress
                    await page.evaluate("time => window.setTripTime(time)",source_time); await page.screenshot(path=str(frames_dir/f"frame-{index:06d}.png"))
                return frame_count,output_duration
            finally: await browser.close()
