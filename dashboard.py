import streamlit as st

st.set_page_config(page_title="Trip Recap", page_icon="🛵")
st.title("Trip Recap")
st.write("Build a road-trip recap from the GPS and capture times already stored in your photos and videos.")
st.link_button("Open trip builder", "/api/preview", use_container_width=True)
st.caption("Original media is processed temporarily. No manual coordinates or route stops are required.")
