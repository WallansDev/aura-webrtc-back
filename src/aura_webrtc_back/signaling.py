import logging
from fastapi import WebSocket, WebSocketDisconnect
from .room_manager import RoomManager

logger = logging.getLogger(__name__)
room_manager = RoomManager()


async def handle_websocket(
    websocket: WebSocket,
    room_id: str,
    client_id: str,
    display_name: str,
):
    await websocket.accept()
    room = room_manager.get_or_create_room(room_id)

    existing_peers = room.get_other_clients(client_id)
    room.add_client(client_id, websocket, display_name)

    logger.info(f"[{room_id}] '{display_name}' ({client_id}) a rejoint. Pairs existants: {len(existing_peers)}")

    # Informe le nouveau client des pairs déjà présents
    await websocket.send_json({
        "type": "room-info",
        "peers": existing_peers,
    })

    # Notifie les pairs existants de l'arrivée du nouveau
    for peer in existing_peers:
        peer_ws = room.connections.get(peer["id"])
        if peer_ws:
            await peer_ws.send_json({
                "type": "peer-joined",
                "peerId": client_id,
                "displayName": display_name,
            })

    try:
        while True:
            data = await websocket.receive_json()
            msg_type = data.get("type")
            target_id = data.get("target")

            # Relai direct d'un message vers un pair cible
            if target_id and target_id in room.connections:
                target_ws = room.connections[target_id]
                data["from"] = client_id
                await target_ws.send_json(data)
            else:
                logger.warning(f"[{room_id}] Message '{msg_type}' sans cible valide de '{client_id}'")

    except WebSocketDisconnect:
        room.remove_client(client_id)
        room_manager.cleanup_room(room_id)
        logger.info(f"[{room_id}] '{display_name}' ({client_id}) a quitté.")

        for peer_id, peer_ws in room.connections.items():
            try:
                await peer_ws.send_json({
                    "type": "peer-left",
                    "peerId": client_id,
                })
            except Exception:
                pass
