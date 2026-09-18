import streamlit as st
from starlette.responses import HTMLResponse, JSONResponse
from starlette.routing import Mount, Route

from app.api import api
from app.api.preview import PREVIEW_HTML


async def preview_route(request):
    return HTMLResponse(PREVIEW_HTML)


async def health_route(request):
    return JSONResponse({"status": "ok", "source": "streamlit-starlette"})


app = st.App(
    "dashboard.py",
    routes=[
        Route("/api/health", health_route),
        Route("/api/preview", preview_route),
        Mount("/api", app=api),
    ],
)
