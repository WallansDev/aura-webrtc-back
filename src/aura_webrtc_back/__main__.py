import logging
import socket
import uvicorn
from .cert_utils import ensure_certificates

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-8s  %(name)s — %(message)s",
)
logger = logging.getLogger(__name__)

HOST = "0.0.0.0"
PORT = 8000


def _local_ips() -> list[str]:
    """Retourne les adresses LAN pour afficher les URLs d'accès."""
    ips = []
    try:
        hostname = socket.gethostname()
        for info in socket.getaddrinfo(hostname, None):
            addr = info[4][0]
            if ":" not in addr and not addr.startswith("127."):
                ips.append(addr)
    except Exception:
        pass
    return list(dict.fromkeys(ips))  # dédoublonnage en gardant l'ordre


if __name__ == "__main__":
    cert_file, key_file = ensure_certificates()

    local_ips = _local_ips()
    logger.info("━" * 52)
    logger.info("  Aura WebRTC — serveur HTTPS démarré")
    logger.info("━" * 52)
    logger.info(f"  Local    → https://localhost:{PORT}")
    for ip in local_ips:
        logger.info(f"  Réseau   → https://{ip}:{PORT}")
    logger.info("")
    logger.info("  ⚠  Certificat auto-signé : acceptez l'exception")
    logger.info("     de sécurité dans votre navigateur au premier accès.")
    logger.info("━" * 52)

    uvicorn.run(
        "aura_webrtc_back.app:app",
        host=HOST,
        port=PORT,
        ssl_certfile=str(cert_file),
        ssl_keyfile=str(key_file),
        reload=False,   # reload incompatible avec SSL dans certaines versions
        log_level="warning",
    )
