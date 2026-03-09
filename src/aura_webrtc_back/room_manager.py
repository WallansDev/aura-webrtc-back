from typing import Dict
from fastapi import WebSocket


class Room:
    def __init__(self, room_id: str):
        self.room_id = room_id
        self.connections: Dict[str, WebSocket] = {}
        self.display_names: Dict[str, str] = {}

    def add_client(self, client_id: str, websocket: WebSocket, display_name: str):
        self.connections[client_id] = websocket
        self.display_names[client_id] = display_name

    def remove_client(self, client_id: str):
        self.connections.pop(client_id, None)
        self.display_names.pop(client_id, None)

    def get_other_clients(self, client_id: str) -> list[dict]:
        return [
            {"id": cid, "name": self.display_names.get(cid, cid)}
            for cid in self.connections
            if cid != client_id
        ]

    def is_empty(self) -> bool:
        return len(self.connections) == 0


class RoomManager:
    def __init__(self):
        self.rooms: Dict[str, Room] = {}

    def get_or_create_room(self, room_id: str) -> Room:
        if room_id not in self.rooms:
            self.rooms[room_id] = Room(room_id)
        return self.rooms[room_id]

    def cleanup_room(self, room_id: str):
        if room_id in self.rooms and self.rooms[room_id].is_empty():
            del self.rooms[room_id]
