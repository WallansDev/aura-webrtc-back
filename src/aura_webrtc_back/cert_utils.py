"""
Génère automatiquement un certificat TLS auto-signé valide pour :
  - localhost / 127.0.0.1
  - toutes les adresses IPv4 locales détectées sur la machine

Le certificat est stocké dans <racine_projet>/certs/ et réutilisé
tant qu'il est valide (1 an).
"""

import datetime
import ipaddress
import logging
import socket
from pathlib import Path

logger = logging.getLogger(__name__)

CERTS_DIR = Path(__file__).parent.parent.parent / "certs"
CERT_FILE = CERTS_DIR / "cert.pem"
KEY_FILE = CERTS_DIR / "key.pem"


def _get_local_ips() -> list[ipaddress.IPv4Address]:
    """Retourne toutes les adresses IPv4 locales de la machine."""
    ips = {ipaddress.IPv4Address("127.0.0.1")}
    try:
        hostname = socket.gethostname()
        for info in socket.getaddrinfo(hostname, None):
            addr = info[4][0]
            try:
                ip = ipaddress.IPv4Address(addr)
                if not ip.is_loopback:
                    ips.add(ip)
            except ValueError:
                pass
    except Exception:
        pass
    return list(ips)


def ensure_certificates() -> tuple[Path, Path]:
    """
    Retourne (cert_file, key_file).
    Génère le certificat s'il n'existe pas ou s'il a expiré.
    """
    if _is_cert_valid():
        return CERT_FILE, KEY_FILE

    try:
        from cryptography import x509
        from cryptography.hazmat.primitives import hashes, serialization
        from cryptography.hazmat.primitives.asymmetric import rsa
        from cryptography.x509.oid import NameOID
    except ImportError:
        raise RuntimeError(
            "Le paquet 'cryptography' est requis pour générer le certificat SSL.\n"
            "Lancez : poetry add cryptography"
        )

    CERTS_DIR.mkdir(exist_ok=True)

    logger.info("Génération d'un nouveau certificat TLS auto-signé…")

    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)

    local_ips = _get_local_ips()
    logger.info(f"IPs incluses dans le certificat : {[str(ip) for ip in local_ips]}")

    san_entries = [x509.DNSName("localhost")]
    for ip in local_ips:
        san_entries.append(x509.IPAddress(ip))

    subject = issuer = x509.Name([
        x509.NameAttribute(NameOID.COMMON_NAME, "Aura WebRTC — certificat local"),
        x509.NameAttribute(NameOID.ORGANIZATION_NAME, "Aura Dev"),
    ])

    now = datetime.datetime.now(datetime.timezone.utc)
    cert = (
        x509.CertificateBuilder()
        .subject_name(subject)
        .issuer_name(issuer)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now)
        .not_valid_after(now + datetime.timedelta(days=365))
        .add_extension(x509.SubjectAlternativeName(san_entries), critical=False)
        .add_extension(x509.BasicConstraints(ca=True, path_length=None), critical=True)
        .sign(key, hashes.SHA256())
    )

    CERT_FILE.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    KEY_FILE.write_bytes(
        key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.TraditionalOpenSSL,
            serialization.NoEncryption(),
        )
    )

    logger.info(f"Certificat généré → {CERT_FILE}")
    return CERT_FILE, KEY_FILE


def _is_cert_valid() -> bool:
    """Vérifie que le certificat existe et n'a pas expiré."""
    if not CERT_FILE.exists() or not KEY_FILE.exists():
        return False
    try:
        from cryptography import x509
        cert = x509.load_pem_x509_certificate(CERT_FILE.read_bytes())
        now = datetime.datetime.now(datetime.timezone.utc)
        # Renouvelle s'il expire dans moins de 7 jours
        return cert.not_valid_after_utc > now + datetime.timedelta(days=7)
    except Exception:
        return False
