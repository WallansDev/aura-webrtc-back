from pathlib import Path
from fastapi import FastAPI, WebSocket, Query
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from fastapi.middleware.cors import CORSMiddleware
from .signaling import handle_websocket

STATIC_DIR = Path(__file__).parent.parent.parent / "static"

app = FastAPI(title="Aura WebRTC", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")


@app.get("/")
async def root():
    return FileResponse(str(STATIC_DIR / "index.html"))


@app.websocket("/ws/{room_id}/{client_id}")
async def websocket_endpoint(
    websocket: WebSocket,
    room_id: str,
    client_id: str,
    name: str = Query(default="Anonyme"),
):
    await handle_websocket(websocket, room_id, client_id, name)
