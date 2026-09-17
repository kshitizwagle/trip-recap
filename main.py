import streamlit as st
from fastapi import FastAPI
from fastapi.responses import HTMLResponse
from starlette.routing import Mount

api = FastAPI()


@api.get("/", response_class=HTMLResponse)
async def root() -> str:
    return "<h1>Hello World</h1>"


app = st.App(
    "dashboard.py",
    routes=[
        Mount("/api", app=api),
    ],
)
