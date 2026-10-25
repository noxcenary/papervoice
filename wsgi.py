from pathlib import Path

from flask import send_from_directory

from app import app


DIST_DIR = Path(__file__).resolve().parent / "frontend" / "dist"


def react_index():
    return send_from_directory(DIST_DIR, "index.html")


# Replace Flask's old / route without touching the backend code.
app.view_functions["index"] = react_index


@app.route("/assets/<path:filename>")
def react_assets(filename):
    return send_from_directory(DIST_DIR / "assets", filename)


application = app