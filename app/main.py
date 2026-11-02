"""本地实验入口 —— 仅本地使用，禁止上传到远程实例。"""

from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import RedirectResponse
from fastapi.staticfiles import StaticFiles

from app.games import register_routers

app = FastAPI(title="Inkmesh")

register_routers(app)
app.mount(
    "/static",
    StaticFiles(directory=str(Path(__file__).resolve().parent / "static")),
    name="static",
)


@app.get("/")
async def index():
    """根路径跳转到合作画板。"""
    return RedirectResponse(url="/collab-canvas")
