import os
import time
from pathlib import Path

from app.storage import TripStore


def test_cleanup_expired_removes_old_workspace(tmp_path: Path) -> None:
    store=TripStore(tmp_path); workspace=store.workspace("old"); old=time.time()-7200; os.utime(workspace,(old,old)); store.cleanup_expired(3600); assert not workspace.exists()
