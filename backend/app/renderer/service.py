from __future__ import annotations

import json
import os
import shutil
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

from app.renderer.browser import BrowserRenderer
from app.renderer.ffmpeg import encode_frames
from app.storage import TripStore


class RenderService:
    def __init__(self,store:TripStore)->None: self.store=store
    def create_job(self,trip_id:str)->str:
        render_id=str(uuid4()); directory=self.store.render_dir(render_id); self._write_status(directory,{"id":render_id,"trip_id":trip_id,"status":"queued"}); return render_id
    async def run(self,render_id:str,trip_id:str,preview_url:str)->None:
        directory=self.store.render_dir(render_id); frames=directory/"frames"; output=directory/"trip.mp4"; self._write_status(directory,{"id":render_id,"trip_id":trip_id,"status":"rendering"})
        try:
            renderer=BrowserRenderer(); frame_count,duration=await renderer.capture_frames(preview_url,trip_id,frames); await encode_frames(frames,output,renderer.fps)
            self._write_status(directory,{"id":render_id,"trip_id":trip_id,"status":"complete","frame_count":frame_count,"duration_seconds":duration,"video":str(output)})
        except Exception as exc: self._write_status(directory,{"id":render_id,"trip_id":trip_id,"status":"failed","error":str(exc)})
        finally: shutil.rmtree(frames,ignore_errors=True)
    def status(self,render_id:str)->dict:
        path=self.store.render_dir(render_id)/"status.json"
        if not path.exists(): raise FileNotFoundError(render_id)
        return json.loads(path.read_text(encoding="utf-8"))
    def video_path(self,render_id:str)->Path: return self.store.render_dir(render_id)/"trip.mp4"
    @staticmethod
    def _write_status(directory:Path,payload:dict)->None:
        payload["updated_at"]=datetime.now(timezone.utc).isoformat(); target=directory/"status.json"; temp=directory/f".status-{os.getpid()}.tmp"; temp.write_text(json.dumps(payload,indent=2),encoding="utf-8"); temp.replace(target)
