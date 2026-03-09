/* ═══════════════════════════════════════════════════
   Aura — WebRTC client-side logic
   Protocole de signalisation :
     room-info     → liste des pairs déjà présents
     peer-joined   → un nouveau pair vient d'arriver
     peer-left     → un pair est parti
     offer / answer / ice-candidate → signalisation WebRTC
   ═══════════════════════════════════════════════════ */

const ICE_CONFIG = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
  ],
};

/* ── État global ── */
let localStream = null;      // flux caméra/micro d'origine (jamais modifié)
let ws = null;
let myClientId = null;
let myDisplayName = null;
let myRoomId = null;
let micEnabled = true;
let camEnabled = true;
let screenSharing = false;
let activeScreenTrack = null; // piste vidéo de partage d'écran en cours

const peerConnections = {}; // peerId → RTCPeerConnection
const peerDisplayNames = {}; // peerId → string

/* ── Éléments DOM ── */
const pageLanding    = document.getElementById("page-landing");
const pageConference = document.getElementById("page-conference");
const inputName      = document.getElementById("input-name");
const inputRoom      = document.getElementById("input-room");
const btnJoin        = document.getElementById("btn-join");
const landingError   = document.getElementById("landing-error");
const headerRoomName = document.getElementById("header-room-name");
const headerStatus   = document.getElementById("header-status");
const statusLabel    = headerStatus.querySelector(".status-label");
const videoGrid      = document.getElementById("video-grid");
const btnMute        = document.getElementById("btn-mute");
const btnCamera      = document.getElementById("btn-camera");
const btnScreen      = document.getElementById("btn-screen");
const btnLeave       = document.getElementById("btn-leave");

/* ══════════════════════════════════════════════════
   ACCUEIL — rejoindre une salle
══════════════════════════════════════════════════ */
btnJoin.addEventListener("click", handleJoin);
[inputName, inputRoom].forEach((el) =>
  el.addEventListener("keydown", (e) => { if (e.key === "Enter") handleJoin(); })
);

/**
 * Tente d'acquérir un flux média avec plusieurs niveaux de repli :
 *   1. vidéo + audio
 *   2. audio seul (pas de caméra)
 *   3. flux vide (aucun périphérique disponible — mode spectateur)
 */
async function acquireMediaStream() {
  // Niveau 1 : vidéo + audio
  try {
    return await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
  } catch (e1) {
    console.warn("Caméra+micro indisponibles :", e1.message);
  }

  // Niveau 2 : audio seulement
  try {
    const audioOnly = await navigator.mediaDevices.getUserMedia({ video: false, audio: true });
    showLandingError("⚠ Caméra introuvable — vous rejoignez en audio uniquement.");
    setTimeout(hideLandingError, 4000);
    camEnabled = false;
    return audioOnly;
  } catch (e2) {
    console.warn("Micro indisponible :", e2.message);
  }

  // Niveau 3 : flux vide (ni caméra ni micro)
  showLandingError("⚠ Aucun périphérique audio/vidéo trouvé — mode spectateur.");
  setTimeout(hideLandingError, 5000);
  camEnabled = false;
  micEnabled = false;
  return new MediaStream();
}

async function handleJoin() {
  const name = inputName.value.trim();
  const room = inputRoom.value.trim().toLowerCase().replace(/\s+/g, "-");

  if (!name) return showLandingError("Veuillez entrer votre nom.");
  if (!room) return showLandingError("Veuillez entrer un nom de salle.");

  hideLandingError();
  btnJoin.disabled = true;
  btnJoin.textContent = "Connexion…";

  localStream = await acquireMediaStream();

  myDisplayName = name;
  myRoomId = room;
  myClientId = generateId();

  showConferencePage();
  syncControlsUI();
  addVideoTile("local", localStream, `${name} (vous)`, true);
  if (!camEnabled) {
    const tile = document.getElementById("tile-local");
    if (tile) tile.classList.add("cam-off");
  }
  connectWebSocket();
}

/* ══════════════════════════════════════════════════
   WEBSOCKET — signalisation
══════════════════════════════════════════════════ */
function connectWebSocket() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const url = `${proto}://${location.host}/ws/${myRoomId}/${myClientId}?name=${encodeURIComponent(myDisplayName)}`;
  ws = new WebSocket(url);

  ws.onopen = () => setStatus("connected", "Connecté");

  ws.onmessage = async (event) => {
    const msg = JSON.parse(event.data);
    await handleSignaling(msg);
  };

  ws.onclose = () => {
    setStatus("error", "Déconnecté");
    cleanupAll();
  };

  ws.onerror = () => setStatus("error", "Erreur WebSocket");
}

async function handleSignaling(msg) {
  switch (msg.type) {
    case "room-info":
      // Nouveau dans la salle → on crée les offres vers les pairs existants
      for (const peer of msg.peers) {
        peerDisplayNames[peer.id] = peer.name;
        await createOffer(peer.id);
      }
      break;

    case "peer-joined":
      // Un pair vient d'arriver, il va nous envoyer une offre
      peerDisplayNames[msg.peerId] = msg.displayName;
      break;

    case "offer":
      peerDisplayNames[msg.from] = msg.displayName || msg.from;
      await handleOffer(msg.from, msg.sdp);
      break;

    case "answer":
      await handleAnswer(msg.from, msg.sdp);
      break;

    case "ice-candidate":
      await handleIceCandidate(msg.from, msg.candidate);
      break;

    case "peer-left":
      removePeer(msg.peerId);
      break;
  }
}

/* ══════════════════════════════════════════════════
   WebRTC — gestion des pairs
══════════════════════════════════════════════════ */
function createPeerConnection(peerId) {
  const pc = new RTCPeerConnection(ICE_CONFIG);
  peerConnections[peerId] = pc;

  // Ajout des pistes audio locales
  localStream.getAudioTracks().forEach((track) => pc.addTrack(track, localStream));

  // Piste vidéo : utilise l'écran partagé si un partage est en cours, sinon la caméra
  const videoTrack = screenSharing && activeScreenTrack
    ? activeScreenTrack
    : localStream.getVideoTracks()[0];
  if (videoTrack) pc.addTrack(videoTrack, localStream);

  // Réception du flux distant
  pc.ontrack = (event) => {
    const displayName = peerDisplayNames[peerId] || peerId.substring(0, 6);
    addVideoTile(peerId, event.streams[0], displayName, false);
  };

  // Envoi des candidats ICE au serveur de signalisation
  pc.onicecandidate = (event) => {
    if (event.candidate) {
      wsSend({ type: "ice-candidate", target: peerId, candidate: event.candidate });
    }
  };

  pc.onconnectionstatechange = () => {
    if (["failed", "disconnected", "closed"].includes(pc.connectionState)) {
      removePeer(peerId);
    }
  };

  return pc;
}

async function createOffer(peerId) {
  const pc = createPeerConnection(peerId);
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  wsSend({ type: "offer", target: peerId, sdp: pc.localDescription });
}

async function handleOffer(fromId, sdp) {
  // Réutilise la connexion existante pour la renégociation (partage d'écran, etc.)
  // Ne crée une nouvelle connexion que si aucune n'existe encore
  let pc = peerConnections[fromId];
  if (!pc) {
    pc = createPeerConnection(fromId);
  }
  await pc.setRemoteDescription(new RTCSessionDescription(sdp));
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  wsSend({ type: "answer", target: fromId, sdp: pc.localDescription });
}

/**
 * Envoie une nouvelle offre à un pair pour renégocier les paramètres codec.
 * Nécessaire après replaceTrack (résolution/framerate différents).
 */
async function renegotiate(peerId) {
  const pc = peerConnections[peerId];
  if (!pc || pc.signalingState !== "stable") return;
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  wsSend({ type: "offer", target: peerId, sdp: pc.localDescription });
}

async function handleAnswer(fromId, sdp) {
  const pc = peerConnections[fromId];
  if (pc && pc.signalingState !== "stable") {
    await pc.setRemoteDescription(new RTCSessionDescription(sdp));
  }
}

async function handleIceCandidate(fromId, candidate) {
  const pc = peerConnections[fromId];
  if (pc && candidate) {
    try {
      await pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (e) {
      console.warn("Erreur ajout ICE candidate:", e);
    }
  }
}

function removePeer(peerId) {
  const pc = peerConnections[peerId];
  if (pc) { pc.close(); delete peerConnections[peerId]; }
  delete peerDisplayNames[peerId];
  removeVideoTile(peerId);
}

function cleanupAll() {
  Object.keys(peerConnections).forEach(removePeer);
  if (localStream) {
    localStream.getTracks().forEach((t) => t.stop());
    localStream = null;
  }
}

/* ══════════════════════════════════════════════════
   CONTRÔLES
══════════════════════════════════════════════════ */
btnMute.addEventListener("click", () => {
  micEnabled = !micEnabled;
  localStream.getAudioTracks().forEach((t) => (t.enabled = micEnabled));
  document.getElementById("icon-mic-on").classList.toggle("hidden", !micEnabled);
  document.getElementById("icon-mic-off").classList.toggle("hidden", micEnabled);
  btnMute.classList.toggle("active", !micEnabled);
});

btnCamera.addEventListener("click", () => {
  camEnabled = !camEnabled;
  localStream.getVideoTracks().forEach((t) => (t.enabled = camEnabled));
  document.getElementById("icon-cam-on").classList.toggle("hidden", !camEnabled);
  document.getElementById("icon-cam-off").classList.toggle("hidden", camEnabled);
  btnCamera.classList.toggle("active", !camEnabled);

  const tile = document.getElementById("tile-local");
  if (tile) tile.classList.toggle("cam-off", !camEnabled);
});

btnScreen.addEventListener("click", async () => {
  if (!screenSharing) {
    try {
      const screenStream = await navigator.mediaDevices.getDisplayMedia({
        video: { cursor: "always" },
        audio: false,
      });
      activeScreenTrack = screenStream.getVideoTracks()[0];

      // Remplace la piste vidéo chez tous les pairs, puis renégocie
      for (const [peerId, pc] of Object.entries(peerConnections)) {
        const sender = pc.getSenders().find((s) => s.track?.kind === "video");
        if (sender) {
          await sender.replaceTrack(activeScreenTrack);
        } else {
          // Pas de caméra : ajoute une nouvelle piste vidéo
          pc.addTrack(activeScreenTrack, localStream);
        }
        await renegotiate(peerId);
      }

      // Prévisualisation locale : nouveau MediaStream pour forcer le refresh
      const localVideo = document.querySelector("#tile-local video");
      if (localVideo) {
        localVideo.srcObject = new MediaStream([activeScreenTrack]);
        localVideo.classList.remove("mirrored");
      }
      const tile = document.getElementById("tile-local");
      if (tile) tile.classList.remove("cam-off");

      // Arrêt automatique si l'utilisateur clique sur "Arrêter" dans le navigateur
      activeScreenTrack.onended = stopScreenShare;

      screenSharing = true;
      btnScreen.classList.add("active");
    } catch (e) {
      console.warn("Partage d'écran annulé:", e);
    }
  } else {
    stopScreenShare();
  }
});

async function stopScreenShare() {
  if (!screenSharing) return;
  screenSharing = false;
  btnScreen.classList.remove("active");

  // Arrête la capture d'écran
  if (activeScreenTrack) {
    activeScreenTrack.stop();
    activeScreenTrack = null;
  }

  // Rétablit la piste caméra d'origine chez tous les pairs, puis renégocie
  const camTrack = localStream.getVideoTracks()[0] ?? null;
  for (const [peerId, pc] of Object.entries(peerConnections)) {
    const sender = pc.getSenders().find((s) => s.track?.kind === "video");
    if (sender) {
      await sender.replaceTrack(camTrack); // null si pas de caméra = désactive la vidéo
    }
    await renegotiate(peerId);
  }

  // Restaure la prévisualisation locale avec le flux caméra
  const localVideo = document.querySelector("#tile-local video");
  if (localVideo) {
    localVideo.srcObject = localStream;
    localVideo.classList.add("mirrored");
  }
  const tile = document.getElementById("tile-local");
  if (tile) tile.classList.toggle("cam-off", !camEnabled);
}

btnLeave.addEventListener("click", () => {
  if (ws) { ws.close(); ws = null; }
  cleanupAll();
  videoGrid.innerHTML = "";
  micEnabled = true;
  camEnabled = true;
  screenSharing = false;
  activeScreenTrack = null;
  pageLanding.classList.remove("hidden");
  pageConference.classList.add("hidden");
  btnJoin.disabled = false;
  btnMute.disabled = false;
  btnCamera.disabled = false;
  btnJoin.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M15 10l4.553-2.369A1 1 0 0121 8.53v6.94a1 1 0 01-1.447.899L15 14"/>
    <rect x="3" y="7" width="12" height="10" rx="2"/>
  </svg> Rejoindre la salle`;
});

/* ══════════════════════════════════════════════════
   GESTION DES TUILES VIDÉO
══════════════════════════════════════════════════ */
function addVideoTile(id, stream, label, isLocal) {
  if (document.getElementById(`tile-${id}`)) return;

  const tile = document.createElement("div");
  tile.className = `video-tile${isLocal ? " local" : ""}`;
  tile.id = `tile-${id}`;

  const video = document.createElement("video");
  video.autoplay = true;
  video.playsInline = true;
  if (isLocal) { video.muted = true; video.classList.add("mirrored"); }
  video.srcObject = stream;

  const labelEl = document.createElement("div");
  labelEl.className = "tile-label";
  labelEl.textContent = label;

  const camOff = document.createElement("div");
  camOff.className = "tile-cam-off";
  const avatar = document.createElement("div");
  avatar.className = "avatar-circle";
  avatar.textContent = label.charAt(0).toUpperCase();
  const camOffText = document.createElement("span");
  camOffText.style.fontSize = "0.8rem";
  camOffText.textContent = "Caméra désactivée";
  camOff.appendChild(avatar);
  camOff.appendChild(camOffText);

  tile.appendChild(video);
  tile.appendChild(labelEl);
  tile.appendChild(camOff);
  videoGrid.appendChild(tile);

  updateGridLayout();
}

function removeVideoTile(id) {
  const tile = document.getElementById(`tile-${id}`);
  if (tile) tile.remove();
  updateGridLayout();
}

function updateGridLayout() {
  const count = videoGrid.children.length;
  videoGrid.setAttribute("data-count", Math.min(count, 6).toString());
}

/* ══════════════════════════════════════════════════
   HELPERS
══════════════════════════════════════════════════ */
function syncControlsUI() {
  document.getElementById("icon-mic-on").classList.toggle("hidden", !micEnabled);
  document.getElementById("icon-mic-off").classList.toggle("hidden", micEnabled);
  btnMute.classList.toggle("active", !micEnabled);
  btnMute.disabled = !localStream.getAudioTracks().length;

  document.getElementById("icon-cam-on").classList.toggle("hidden", !camEnabled);
  document.getElementById("icon-cam-off").classList.toggle("hidden", camEnabled);
  btnCamera.classList.toggle("active", !camEnabled);
  btnCamera.disabled = !localStream.getVideoTracks().length;
}

function showConferencePage() {
  pageLanding.classList.add("hidden");
  pageConference.classList.remove("hidden");
  headerRoomName.textContent = myRoomId;
  setStatus("connecting", "Connexion…");
}

function setStatus(type, label) {
  headerStatus.className = `status-badge ${type}`;
  statusLabel.textContent = label;
}

function showLandingError(msg) {
  landingError.textContent = msg;
  landingError.classList.remove("hidden");
}

function hideLandingError() {
  landingError.classList.add("hidden");
}

function wsSend(data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

function generateId() {
  return Math.random().toString(36).substring(2, 10) + Date.now().toString(36);
}
