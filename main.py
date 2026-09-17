import streamlit as st
from starlette.routing import Mount

from app.api import api

app = st.App(
    "dashboard.py",
    routes=[Mount("/api", app=api)],
)
