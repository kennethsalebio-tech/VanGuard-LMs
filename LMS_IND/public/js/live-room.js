/*
 * Vanguard Live Classroom — native WebRTC room client.
 *
 * One getUserMedia() stream per participant. Audio and video are sent through
 * pre-created transceivers so muting/unmuting and camera toggles use
 * replaceTrack() and never need a renegotiation storm. Signaling travels over
 * an authenticated SSE stream (downstream) and CSRF-protected POSTs (upstream).
 */
(function () {
  "use strict";

  const room = window.__VANGUARD_ROOM__;
  if (!room) return;

  const stageEl = document.getElementById("video-stage");
  if (!stageEl) return;

  const me = Number(room.userId);
  const base = "/live/" + encodeURIComponent(room.id);
  const urls = {
    state: base + "/state?token=" + encodeURIComponent(room.token),
    chat: base + "/chat?token=" + encodeURIComponent(room.token),
    leave: base + "/leave",
    signalStream: base + "/signals?token=" + encodeURIComponent(room.token),
    signal: base + "/signals",
    end: "/instructor/live/" + encodeURIComponent(room.id) + "/end",
  };

  const el = {
    stage: stageEl,
    loader: document.getElementById("video-loader"),
    status: document.getElementById("video-status"),
    statusDetail: document.getElementById("video-status-detail"),
    error: document.getElementById("video-error"),
    errorTitle: document.getElementById("video-error-title"),
    errorDetail: document.getElementById("video-error-detail"),
    retryCamera: document.getElementById("btn-retry-camera"),
    joinAudio: document.getElementById("btn-join-audio"),
    micBtn: document.getElementById("btn-mic"),
    micLabel: document.getElementById("mic-label"),
    camBtn: document.getElementById("btn-cam"),
    camLabel: document.getElementById("cam-label"),
    camSelect: document.getElementById("cam-select"),
    shareBtn: document.getElementById("btn-share"),
    shareLabel: document.getElementById("share-label"),
    muteAllBtn: document.getElementById("btn-mute-all"),
    leaveBtn: document.getElementById("btn-leave"),
    endBtn: document.getElementById("btn-end"),
    list: document.getElementById("participant-list"),
    joinedCount: document.getElementById("joined-count"),
    participantSummary: document.getElementById("participant-summary"),
    chatMessages: document.getElementById("chat-messages"),
    chatForm: document.getElementById("chat-form"),
    chatInput: document.getElementById("chat-input"),
    roomStatus: document.getElementById("room-status"),
  };

  const S = {
    leaving: false,
    eventSource: null,
    helloCount: 0,
    lastMessageId: 0,
    camera: "initializing",
    mic: "initializing",
    micMuted: false,
    sharing: false,
    localStream: null,
    audioTrack: null,
    videoTrack: null,
    shareStream: null,
    shareTrack: null,
    localTile: null,
    peers: new Map(),
    participants: [],
    pollTimer: null,
    chatTimer: null,
    participantSignature: "",
    signalLog: [],
  };

  function noteSignal(direction, type, from) {
    S.signalLog.push(
      direction + ":" + type + (from !== undefined ? ":" + from : "")
    );
    if (S.signalLog.length > 30) S.signalLog.shift();
  }

  const AUDIO = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };

  /* ------------------------------------------------------------------ utils */

  function setText(node, value) {
    if (node) node.textContent = value;
  }

  function initials(name) {
    return String(name || "")
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0].toUpperCase())
      .join("");
  }

  function playVideo(video, tile) {
    if (!video || !tile) return;
    const attempt = video.play();
    if (attempt && typeof attempt.catch === "function") {
      attempt
        .then(() => {
          tile.tap.classList.add("hidden");
          tile.tap.classList.remove("flex");
        })
        .catch(() => {
          tile.tap.classList.remove("hidden");
          tile.tap.classList.add("flex");
        });
    }
  }

  function videoConstraints(deviceId) {
    if (deviceId) {
      return {
        deviceId: { exact: deviceId },
        width: { ideal: 1280 },
        height: { ideal: 720 },
      };
    }
    return { width: { ideal: 1280 }, height: { ideal: 720 } };
  }

  function classifyMediaError(error) {
    const name = (error && error.name) || "";
    if (name === "NotAllowedError" || name === "PermissionDeniedError") {
      return {
        state: "blocked",
        title: "Camera permission needed",
        message:
          "Camera and microphone access was blocked. Allow access for this site in the browser's address bar, then choose “Try camera again”.",
      };
    }
    if (name === "NotFoundError" || name === "DevicesNotFoundError") {
      return {
        state: "nodevice",
        title: "No camera detected",
        message:
          "No camera device was found. Connect a camera and try again, or join with audio only.",
      };
    }
    if (
      name === "NotReadableError" ||
      name === "TrackStartError" ||
      name === "AbortError"
    ) {
      return {
        state: "inuse",
        title: "Camera is in use",
        message:
          "Another application or browser tab is using the camera. Close it and try again.",
      };
    }
    if (name === "OverconstrainedError" || name === "ConstraintNotSatisfiedError") {
      return {
        state: "error",
        title: "Camera unavailable",
        message:
          "The selected camera is no longer available. Choose another camera and try again.",
      };
    }
    if (name === "SecurityError") {
      return {
        state: "insecure",
        title: "Camera blocked by the browser",
        message:
          "This page is not allowed to use the camera. Use HTTPS (or localhost) and allow the camera permission.",
      };
    }
    return {
      state: "error",
      title: "Camera could not start",
      message:
        "The camera failed to initialize. Check the device and browser permission, then try again.",
    };
  }

  /* ---------------------------------------------------------------- UI state */

  function setCameraState(name, detail) {
    S.camera = name;
    const labels = {
      initializing: "Connecting camera…",
      on: "Camera on",
      off: "Camera off",
      blocked: "Camera blocked",
      nodevice: "No camera device",
      inuse: "Camera in use",
      insecure: "Camera needs HTTPS",
      error: "Camera error",
    };
    setText(el.camLabel, labels[name] || "Camera error");
    const isError = ["blocked", "nodevice", "inuse", "error", "insecure"].includes(name);
    el.camBtn.classList.toggle("bg-rose-600", name === "off" || isError);
    el.camBtn.classList.toggle("bg-white/10", !(name === "off" || isError));
    el.camBtn.setAttribute("aria-pressed", name === "on" ? "true" : "false");
    el.camBtn.disabled = name === "initializing";
    el.camBtn.title = detail || labels[name] || "";
    updateTile(S.localTile);
  }

  function setMicState(name, detail) {
    S.mic = name;
    const labels = {
      initializing: "Connecting microphone…",
      on: "Microphone on",
      off: "Microphone off",
      blocked: "Microphone blocked",
      nodevice: "No microphone",
      insecure: "Microphone needs HTTPS",
      error: "Microphone error",
    };
    setText(el.micLabel, labels[name] || "Microphone error");
    const isOff = name === "off" || name === "blocked" || name === "nodevice" || name === "insecure" || name === "error";
    el.micBtn.classList.toggle("bg-rose-600", isOff);
    el.micBtn.classList.toggle("bg-white/10", !isOff);
    el.micBtn.setAttribute("aria-pressed", name === "on" ? "true" : "false");
    el.micBtn.disabled = name === "initializing";
    el.micBtn.title = detail || labels[name] || "";
    updateTile(S.localTile);
  }

  function showLoader(status, detail) {
    if (!el.loader) return;
    el.loader.classList.remove("hidden");
    if (status) setText(el.status, status);
    if (detail) setText(el.statusDetail, detail);
  }

  function hideLoader() {
    if (!el.loader) return;
    el.loader.classList.add("hidden");
  }

  function showError(title, detail) {
    if (!el.error) return;
    el.errorTitle.textContent = title;
    el.errorDetail.textContent = detail;
    el.error.classList.remove("hidden");
    el.error.classList.add("flex");
    hideLoader();
  }

  function hideError() {
    if (!el.error) return;
    el.error.classList.add("hidden");
    el.error.classList.remove("flex");
  }

  /* ------------------------------------------------------------------ tiles */

  function createTile({ id, name, isHost, local, color }) {
    const tile = document.createElement("div");
    tile.className = "relative min-h-0 overflow-hidden rounded-xl bg-navy-900";
    tile.dataset.peer = String(id);
    if (local) tile.dataset.local = "true";

    const video = document.createElement("video");
    video.autoplay = true;
    video.playsInline = true;
    video.muted = Boolean(local);
    video.className = "h-full w-full object-cover";
    if (local) video.id = "local-video";

    const avatar = document.createElement("div");
    avatar.className =
      "absolute inset-0 flex flex-col items-center justify-center gap-2 bg-navy-900";
    const circle = document.createElement("span");
    circle.className =
      "flex h-16 w-16 items-center justify-center rounded-full text-lg font-bold text-white";
    circle.style.backgroundColor = color || "#1e3a6e";
    circle.textContent = initials(name) || "?";
    const note = document.createElement("span");
    note.className =
      "text-[10px] font-semibold uppercase tracking-wide text-slate-400";
    note.textContent = local ? "Starting camera…" : "Connecting video…";
    avatar.append(circle, note);

    const nameBar = document.createElement("div");
    nameBar.className =
      "pointer-events-none absolute inset-x-0 bottom-0 flex items-center justify-between gap-2 bg-gradient-to-t from-black/70 to-transparent px-2.5 pb-2 pt-6";
    const nameEl = document.createElement("span");
    nameEl.className = "min-w-0 truncate text-[11px] font-semibold text-white";
    nameEl.textContent = name + (local ? " (you)" : "");
    const micBadge = document.createElement("span");
    micBadge.className =
      "hidden shrink-0 rounded-full bg-black/50 px-1.5 py-0.5 text-[9px] font-semibold text-rose-200";
    micBadge.textContent = "Muted";
    nameBar.append(nameEl, micBadge);

    const hostChip = document.createElement("span");
    hostChip.className =
      "absolute left-2 top-2 rounded-full bg-navy-900/90 px-2 py-0.5 text-[8px] font-bold uppercase tracking-wide text-white";
    hostChip.textContent = "Host";
    hostChip.hidden = !isHost;

    const tap = document.createElement("button");
    tap.type = "button";
    tap.className =
      "absolute inset-0 hidden items-center justify-center bg-black/50 text-xs font-semibold text-white";
    tap.textContent = "Click to play video";
    tap.addEventListener("click", () => {
      video.play().catch(() => {});
      tap.classList.add("hidden");
      tap.classList.remove("flex");
    });

    tile.append(video, avatar, nameBar, hostChip, tap);
    return { tile, video, avatar, avatarNote: note, micBadge, hostChip, tap };
  }

  function updateTile(peer) {
    if (!peer || !peer.tile) return;
    const cameraOn = peer.local
      ? S.sharing
        ? Boolean(S.shareTrack)
        : S.camera === "on" && Boolean(S.videoTrack)
      : Boolean(peer.camOn);

    peer.video.classList.toggle("hidden", !cameraOn);
    peer.avatar.classList.toggle("hidden", cameraOn);

    if (!cameraOn) {
      peer.avatarNote.textContent = peer.local
        ? S.camera === "initializing"
          ? "Starting camera…"
          : S.camera === "insecure"
            ? "Camera needs HTTPS"
            : "Camera off"
        : peer.camOn === null
          ? "Connecting video…"
          : "Camera off";
    }

    const micOff = !peer.local && peer.micOn === false;
    peer.micBadge.classList.toggle("hidden", !micOff);
    if (peer.local) {
      peer.micBadge.classList.toggle("hidden", !S.micMuted);
    }
  }

  function updateLayout() {
    const count = el.stage.children.length;
    const columns =
      count <= 1
        ? "grid-cols-1"
        : count <= 4
          ? "grid-cols-1 sm:grid-cols-2"
          : "grid-cols-2 sm:grid-cols-3";
    el.stage.className =
      "grid h-[58vh] min-h-[320px] w-full gap-1.5 bg-navy-950 p-1.5 " + columns;
  }

  function updateConnectedCount() {
    const total = S.peers.size + 1;
    setText(el.joinedCount, String(total));
    setText(el.participantSummary, String(total));
  }

  function initLocalTile() {
    const tile = createTile({
      id: me,
      name: room.rtc.displayName || "You",
      isHost: Boolean(room.isModerator),
      local: true,
      color: room.rtc.avatarColor,
    });
    S.localTile = { ...tile, id: me, name: room.rtc.displayName, local: true, micOn: false, camOn: false };
    el.stage.appendChild(tile.tile);
    setCameraState("initializing");
    setMicState("initializing");
    updateLayout();
    updateTile(S.localTile);
  }

  /* ------------------------------------------------------------- peer setup */

  function ensurePeer(info) {
    const id = Number(info.id !== undefined ? info.id : info.from);
    if (!id || id === me) return null;

    let peer = S.peers.get(id);
    if (peer) {
      if (info.name) {
        peer.name = info.name;
        const nameEl = peer.tile.querySelector(".min-w-0.truncate");
        if (nameEl) nameEl.textContent = peer.name;
      }
      if (info.role) peer.isHost = info.role === "instructor";
      return peer;
    }

    const ui = createTile({
      id,
      name: info.name || "Participant",
      isHost: info.role === "instructor" || info.isHost === true,
      local: false,
      color: null,
    });
    peer = {
      id,
      name: info.name || "Participant",
      isHost: info.role === "instructor" || info.isHost === true,
      local: false,
      camOn: null,
      micOn: true,
      sharing: false,
      pc: null,
      stream: new MediaStream(),
      makingOffer: false,
      pendingCandidates: [],
      ...ui,
    };
    S.peers.set(id, peer);
    el.stage.appendChild(ui.tile);
    updateLayout();
    updateConnectedCount();
    createPeerConnection(peer);
    updateTile(peer);
    return peer;
  }

  function createPeerConnection(peer) {
    if (peer.pc) return;
    const pc = new RTCPeerConnection({ iceServers: room.rtc.iceServers || [] });
    peer.pc = pc;

    peer.audioSender = null;
    peer.videoSender = null;

    pc.onicecandidate = (event) => {
      if (!event.candidate) return;
      const candidate =
        typeof event.candidate.toJSON === "function"
          ? event.candidate.toJSON()
          : {
              candidate: event.candidate.candidate,
              sdpMid: event.candidate.sdpMid,
              sdpMLineIndex: event.candidate.sdpMLineIndex,
              usernameFragment: event.candidate.usernameFragment,
            };
      postSignal(peer.id, "ice", candidate);
    };

    pc.ontrack = (event) => {
      if (!peer.stream.getTracks().includes(event.track)) {
        peer.stream.addTrack(event.track);
      }
      peer.video.srcObject = peer.stream;
      if (event.track.kind === "video") {
        peer.camOn = !event.track.muted;
        event.track.onunmute = () => {
          peer.camOn = true;
          updateTile(peer);
        };
        event.track.onmute = () => {
          peer.camOn = false;
          updateTile(peer);
        };
        event.track.onended = () => {
          peer.camOn = false;
          updateTile(peer);
        };
      }
      updateTile(peer);
      playVideo(peer.video, peer);
    };

    attachLocalTracks(peer);

    pc.onnegotiationneeded = () => {
      // The lower id opens the first negotiation; either side may renegotiate
      // later when a camera or microphone track becomes available.
      if (me < peer.id || pc.remoteDescription) negotiate(peer);
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "connected") {
        postSignal(peer.id, "media", mediaState());
      }
      if (pc.connectionState === "failed") {
        try {
          pc.restartIce();
        } catch {
          /* the next negotiation retries */
        }
      }
    };
  }

  async function negotiate(peer) {
    if (!peer.pc || peer.makingOffer || peer.pc.signalingState !== "stable") return;
    peer.makingOffer = true;
    try {
      const offer = await peer.pc.createOffer();
      await peer.pc.setLocalDescription(offer);
      postSignal(peer.id, "offer", peer.pc.localDescription);
    } catch (error) {
      console.warn("Could not create the video offer:", error.message);
    } finally {
      peer.makingOffer = false;
    }
  }

  async function flushCandidates(peer) {
    if (!peer.pc || !peer.pc.remoteDescription) return;
    const queued = peer.pendingCandidates.splice(0);
    for (const candidate of queued) {
      try {
        await peer.pc.addIceCandidate(candidate);
      } catch {
        /* ignore a stale candidate */
      }
    }
  }

  /**
   * Perfect-negotiation handler. Either participant can renegotiate (for
   * example when a camera is enabled after joining); the peer with the higher
   * id yields when both offers cross.
   */
  async function handleDescription(peer, description) {
    const pc = peer.pc;
    if (!pc) return;
    const polite = me > peer.id;
    const readyForOffer =
      !peer.makingOffer &&
      (pc.signalingState === "stable" || peer.settingRemoteAnswer);
    const offerCollision = description.type === "offer" && !readyForOffer;
    peer.ignoreOffer = !polite && offerCollision;
    if (peer.ignoreOffer) return;

    try {
      peer.settingRemoteAnswer = description.type === "answer";
      await pc.setRemoteDescription(description);
      peer.settingRemoteAnswer = false;
      if (description.type === "offer") {
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        postSignal(peer.id, "answer", pc.localDescription);
      }
      await flushCandidates(peer);
    } catch (error) {
      peer.settingRemoteAnswer = false;
      console.warn("Could not apply the video description:", error.message);
    }
  }

  async function handleIce(peer, candidate) {
    if (!candidate || peer.ignoreOffer) return;
    if (!peer.pc || !peer.pc.remoteDescription) {
      peer.pendingCandidates.push(candidate);
      return;
    }
    try {
      await peer.pc.addIceCandidate(candidate);
    } catch {
      /* a candidate can arrive after the connection moved on */
    }
  }

  function mediaState() {
    return {
      camOn: S.camera === "on" && Boolean(S.videoTrack),
      micOn: Boolean(S.audioTrack && !S.micMuted && S.audioTrack.enabled),
      sharing: S.sharing,
    };
  }

  function applyPeerMedia(peer, data) {
    if (!peer || !data) return;
    if (typeof data.camOn === "boolean") peer.camOn = data.camOn;
    if (typeof data.micOn === "boolean") peer.micOn = data.micOn;
    if (typeof data.sharing === "boolean") peer.sharing = data.sharing;
    updateTile(peer);
  }

  function closePeer(id) {
    const peer = S.peers.get(Number(id));
    if (!peer) return;
    if (peer.pc) {
      try {
        peer.pc.close();
      } catch {
        /* already closed */
      }
    }
    peer.tile.remove();
    S.peers.delete(peer.id);
    updateLayout();
    updateConnectedCount();
  }

  function closeAllPeers() {
    for (const id of [...S.peers.keys()]) closePeer(id);
    S.peers.clear();
  }

  /* ------------------------------------------------------------- signaling */

  function postSignal(target, type, data, broadcast) {
    if (S.leaving) return Promise.resolve();
    noteSignal("out", type, target || (broadcast ? "all" : undefined));
    return fetch(urls.signal, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "x-csrf-token": room.csrf,
      },
      body: JSON.stringify({
        _csrf: room.csrf,
        token: room.token,
        target,
        type,
        data,
        broadcast: Boolean(broadcast),
      }),
    })
      .then((response) => {
        if (response && !response.ok) {
          console.warn("Signaling " + type + " failed with status " + response.status);
        }
      })
      .catch(() => {
        /* transient signaling failure; a later ICE/negotiation retries */
      });
  }

  function broadcastMedia() {
    postSignal(null, "media", mediaState(), true);
  }

  function handleSignalEvent(event) {
    let payload;
    try {
      payload = JSON.parse(event.data);
    } catch {
      return;
    }
    noteSignal("in", payload.type, payload.from);
    const from = Number(payload.from);
    if (!from || from === me) return;

    const peer = ensurePeer({
      id: from,
      name: payload.fromName,
      role: payload.fromRole,
    });
    if (!peer) return;

    switch (payload.type) {
      case "offer":
      case "answer":
        handleDescription(peer, payload.data);
        break;
      case "ice":
        handleIce(peer, payload.data);
        break;
      case "media":
        applyPeerMedia(peer, payload.data);
        break;
      case "command":
        if (payload.data && payload.data.action === "mute-all" && S.audioTrack) {
          S.micMuted = true;
          S.audioTrack.enabled = false;
          setMicState("off");
          broadcastMedia();
        }
        break;
      default:
        break;
    }
  }

  function joinSignals() {
    if (S.leaving) return;
    if (S.eventSource) {
      try {
        S.eventSource.close();
      } catch {
        /* already closed */
      }
    }
    const source = new EventSource(urls.signalStream);
    S.eventSource = source;

    source.addEventListener("hello", (event) => {
      let data;
      try {
        data = JSON.parse(event.data);
      } catch {
        return;
      }
      noteSignal("in", "hello", (data.peers || []).length);
      if (el.roomStatus) el.roomStatus.classList.add("hidden");
      hideLoader();
      if (S.helloCount > 0) closeAllPeers();
      S.helloCount += 1;
      for (const info of data.peers || []) {
        const peer = ensurePeer({ ...info, id: info.id });
        if (peer && me < peer.id) negotiate(peer);
      }
    });

    source.addEventListener("join", (event) => {
      let data;
      try {
        data = JSON.parse(event.data);
      } catch {
        return;
      }
      const peer = ensurePeer(data);
      if (peer && me < peer.id) negotiate(peer);
    });

    source.addEventListener("left", (event) => {
      let data;
      try {
        data = JSON.parse(event.data);
      } catch {
        return;
      }
      closePeer(data.id);
    });

    source.addEventListener("signal", handleSignalEvent);
    source.onerror = () => {
      if (S.leaving || !el.roomStatus) return;
      el.roomStatus.classList.remove("hidden");
    };
  }

  /* ------------------------------------------------------------------ media */

  function mediaSupported() {
    return Boolean(
      navigator.mediaDevices &&
        typeof navigator.mediaDevices.getUserMedia === "function"
    );
  }

  function stopAudioVideoTracks() {
    if (S.localStream) {
      S.localStream.getTracks().forEach((track) => {
        if (track.readyState === "live") track.stop();
      });
    }
    if (S.audioTrack && S.audioTrack.readyState === "live") S.audioTrack.stop();
    if (S.videoTrack && S.videoTrack.readyState === "live") S.videoTrack.stop();
  }

  function attachLocalVideo() {
    if (!S.localTile || !S.localTile.video) return;
    S.localTile.video.srcObject = S.localStream;
    playVideo(S.localTile.video, S.localTile);
  }

  /**
   * Add tracks only once per peer. Adding a track to a negotiated connection
   * triggers a single renegotiation; toggling an existing camera reuses its
   * sender with replaceTrack() and does not create extra m-lines.
   */
  function attachLocalTracks(peer) {
    if (!peer.pc) return;
    const stream = S.localStream || new MediaStream();
    if (S.audioTrack && !peer.audioSender) {
      try {
        peer.audioSender = peer.pc.addTrack(S.audioTrack, stream);
      } catch {
        /* the connection is closing */
      }
    }
    if (S.videoTrack && !peer.videoSender) {
      try {
        peer.videoSender = peer.pc.addTrack(S.videoTrack, stream);
      } catch {
        /* the connection is closing */
      }
    }
  }

  function syncTracksToPeers() {
    for (const peer of S.peers.values()) {
      if (S.audioTrack) {
        if (peer.audioSender) {
          peer.audioSender.replaceTrack(S.audioTrack).catch(() => {});
        } else {
          attachLocalTracks(peer);
        }
      }
      if (S.videoTrack) {
        if (peer.videoSender) {
          peer.videoSender.replaceTrack(S.videoTrack).catch(() => {});
        } else {
          attachLocalTracks(peer);
        }
      }
    }
  }

  async function startMedia() {
    if (S.leaving) return;
    if (!mediaSupported() || !window.isSecureContext) {
      const message = !window.isSecureContext
        ? "Camera access requires HTTPS (or localhost). Open Vanguard Learning on a secure connection and reload."
        : "This browser does not expose a camera API. Use a current version of Chrome, Edge, Firefox or Safari.";
      setCameraState("insecure", message);
      setMicState("insecure", message);
      showError("Camera needs a secure connection", message);
      return;
    }

    showLoader(
      "Requesting camera and microphone…",
      "Allow access in the browser prompt to appear on video."
    );
    setCameraState("initializing");
    setMicState("initializing");

    const saved = localStorage.getItem("vanguardCameraId");
    let stream = null;
    let mediaError = null;

    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: AUDIO,
        video: videoConstraints(saved),
      });
    } catch (error) {
      mediaError = error;
      if (saved && (error.name === "OverconstrainedError" || error.name === "NotFoundError")) {
        localStorage.removeItem("vanguardCameraId");
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            audio: AUDIO,
            video: videoConstraints(),
          });
        } catch (retryError) {
          mediaError = retryError;
        }
      }
      if (
        !stream &&
        !["NotAllowedError", "SecurityError"].includes(mediaError.name)
      ) {
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            audio: AUDIO,
            video: false,
          });
        } catch {
          /* the camera error is the useful one to report */
        }
      }
    }

    if (!stream) {
      const mapped = classifyMediaError(mediaError);
      setCameraState(mapped.state, mapped.message);
      setMicState(mapped.state, mapped.message);
      showError(mapped.title, mapped.message);
      return;
    }

    S.localStream = stream;
    S.audioTrack = stream.getAudioTracks()[0] || null;
    S.videoTrack = stream.getVideoTracks()[0] || null;

    if (S.audioTrack) {
      S.audioTrack.enabled = !S.micMuted;
      setMicState("on");
    } else {
      setMicState("nodevice", "No microphone was detected. You can still watch and use chat.");
    }

    if (S.videoTrack) {
      S.videoTrack.onended = handleCameraEnded;
      attachLocalVideo();
      setCameraState("on");
    } else {
      setCameraState("off");
    }

    syncTracksToPeers();
    updateTile(S.localTile);

    if (mediaError) {
      const mapped = classifyMediaError(mediaError);
      setCameraState(mapped.state, mapped.message);
      showError(mapped.title, mapped.message);
    } else {
      hideError();
    }
    hideLoader();
    refreshDevices();
  }

  function handleCameraEnded() {
    if (S.leaving || S.sharing) return;
    S.videoTrack = null;
    setCameraState("off");
    updateTile(S.localTile);
    broadcastMedia();
  }

  async function enableCamera(deviceId) {
    if (S.leaving) return;
    if (S.videoTrack) {
      setCameraState("on");
      hideError();
      return;
    }
    if (!mediaSupported()) return;

    setCameraState("initializing");
    hideError();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: videoConstraints(deviceId || localStorage.getItem("vanguardCameraId") || null),
      });
      const track = stream.getVideoTracks()[0];
      if (!track) throw new Error("No video track was returned.");

      if (S.videoTrack) S.videoTrack.stop();
      S.videoTrack = track;
      if (!S.localStream) S.localStream = new MediaStream();
      S.localStream.addTrack(track);
      track.onended = handleCameraEnded;

      attachLocalVideo();
      syncTracksToPeers();
      setCameraState("on");
      hideError();
      hideLoader();
      updateTile(S.localTile);
      broadcastMedia();
      const settings = track.getSettings ? track.getSettings() : {};
      if (settings.deviceId) localStorage.setItem("vanguardCameraId", settings.deviceId);
      refreshDevices();
    } catch (error) {
      const mapped = classifyMediaError(error);
      setCameraState(mapped.state, mapped.message);
      showError(mapped.title, mapped.message);
    }
  }

  function disableCamera() {
    const track = S.videoTrack;
    S.videoTrack = null;
    for (const peer of S.peers.values()) {
      if (peer.videoSender) peer.videoSender.replaceTrack(null).catch(() => {});
    }
    if (S.localStream && track) S.localStream.removeTrack(track);
    if (track && track.readyState === "live") track.stop();
    if (S.localTile && S.localTile.video) S.localTile.video.srcObject = null;
    setCameraState("off");
    updateTile(S.localTile);
    broadcastMedia();
  }

  function toggleCamera() {
    if (S.camera === "initializing") return;
    if (S.videoTrack) {
      disableCamera();
    } else {
      enableCamera();
    }
  }

  function toggleMicrophone() {
    if (!S.audioTrack) {
      retryMicrophone();
      return;
    }
    S.micMuted = !S.micMuted;
    S.audioTrack.enabled = !S.micMuted;
    setMicState(S.micMuted ? "off" : "on");
    updateTile(S.localTile);
    broadcastMedia();
  }

  async function retryMicrophone() {
    if (!mediaSupported()) return;
    setMicState("initializing");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: AUDIO });
      const track = stream.getAudioTracks()[0];
      if (!track) throw new Error("No microphone track was returned.");
      S.audioTrack = track;
      track.enabled = !S.micMuted;
      if (!S.localStream) S.localStream = new MediaStream();
      S.localStream.addTrack(track);
      syncTracksToPeers();
      setMicState(S.micMuted ? "off" : "on");
      broadcastMedia();
    } catch (error) {
      const mapped = classifyMediaError(error);
      setMicState(mapped.state, mapped.message);
    }
  }

  async function refreshDevices() {
    if (!el.camSelect || !navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) {
      return;
    }
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const cameras = devices.filter((device) => device.kind === "videoinput");
      if (!cameras.length) {
        el.camSelect.classList.add("hidden");
        return;
      }
      const settings = S.videoTrack && S.videoTrack.getSettings ? S.videoTrack.getSettings() : {};
      const current = settings.deviceId || localStorage.getItem("vanguardCameraId") || "";
      el.camSelect.textContent = "";
      cameras.forEach((camera, index) => {
        const option = document.createElement("option");
        option.value = camera.deviceId;
        option.textContent = camera.label || "Camera " + (index + 1);
        if (camera.deviceId === current) option.selected = true;
        el.camSelect.appendChild(option);
      });
      el.camSelect.classList.remove("hidden");
    } catch {
      /* device labels are optional */
    }
  }

  async function switchCamera(deviceId) {
    if (!deviceId) return;
    localStorage.setItem("vanguardCameraId", deviceId);
    if (!S.videoTrack) {
      await enableCamera(deviceId);
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: videoConstraints(deviceId),
      });
      const next = stream.getVideoTracks()[0];
      if (!next) throw new Error("No video track was returned.");
      const previous = S.videoTrack;
      if (S.localStream && previous) S.localStream.removeTrack(previous);
      S.videoTrack = next;
      if (!S.localStream) S.localStream = new MediaStream();
      S.localStream.addTrack(next);
      next.onended = handleCameraEnded;
      attachLocalVideo();
      syncTracksToPeers();
      if (previous && previous.readyState === "live") previous.stop();
      setCameraState("on");
      broadcastMedia();
    } catch (error) {
      const mapped = classifyMediaError(error);
      setCameraState(mapped.state, mapped.message);
      showError(mapped.title, mapped.message);
    }
  }

  /* ------------------------------------------------------------ screen share */

  async function toggleShare() {
    if (S.sharing) {
      stopShare();
      return;
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
      window.alert("Screen sharing is not available in this browser.");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
      const track = stream.getVideoTracks()[0];
      if (!track) return;
      S.shareStream = stream;
      S.shareTrack = track;
      S.sharing = true;
      for (const peer of S.peers.values()) {
        if (peer.videoSender) peer.videoSender.replaceTrack(track).catch(() => {});
      }
      if (S.localTile && S.localTile.video) {
        S.localTile.video.srcObject = new MediaStream([track]);
        playVideo(S.localTile.video, S.localTile);
      }
      if (el.shareLabel) el.shareLabel.textContent = "Stop sharing";
      track.onended = stopShare;
      updateTile(S.localTile);
      broadcastMedia();
    } catch {
      /* the user cancelled the picker */
    }
  }

  function stopShare() {
    if (!S.sharing) return;
    S.sharing = false;
    const track = S.shareTrack;
    S.shareTrack = null;
    S.shareStream = null;
    for (const peer of S.peers.values()) {
      if (peer.videoSender) peer.videoSender.replaceTrack(S.videoTrack || null).catch(() => {});
    }
    if (track && track.readyState === "live") track.stop();
    if (el.shareLabel) el.shareLabel.textContent = "Share screen";
    if (S.localTile && S.localTile.video) {
      S.localTile.video.srcObject = S.localStream;
      if (S.videoTrack) playVideo(S.localTile.video, S.localTile);
    }
    updateTile(S.localTile);
    broadcastMedia();
  }

  /* --------------------------------------------------------------- presence */

  function renderParticipants() {
    const signature = S.participants
      .map((participant) => participant.id + ":" + participant.role + ":" + participant.name)
      .join("|");
    if (signature === S.participantSignature) return;
    S.participantSignature = signature;

    el.list.textContent = "";
    if (!S.participants.length) {
      const empty = document.createElement("p");
      empty.className = "px-2 py-3 text-center text-[11px] text-slate-400";
      empty.textContent = "Waiting for participants…";
      el.list.appendChild(empty);
    }

    S.participants.forEach((participant) => {
      const row = document.createElement("div");
      row.className = "flex items-center gap-2 rounded-lg px-2 py-1.5";

      const avatar = document.createElement("span");
      avatar.className =
        "flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-navy-900 text-[10px] font-bold text-white";
      avatar.textContent = initials(participant.name);

      const name = document.createElement("span");
      name.className = "min-w-0 flex-1 truncate text-xs text-slate-700";
      name.textContent = participant.name;

      row.append(avatar, name);

      if (participant.isHost) {
        const chip = document.createElement("span");
        chip.className =
          "rounded-full bg-navy-900 px-2 py-0.5 text-[8px] font-bold uppercase tracking-wide text-white";
        chip.textContent = "Host";
        row.appendChild(chip);
      } else if (room.isModerator) {
        const remove = document.createElement("button");
        remove.type = "button";
        remove.className =
          "rounded-md border border-rose-200 bg-rose-50 px-1.5 py-0.5 text-[9px] font-semibold text-rose-700";
        remove.textContent = "Remove";
        remove.addEventListener("click", () => {
          if (!window.confirm("Remove this learner from the live classroom?")) return;
          fetch(
            "/instructor/live/" + room.id + "/participants/" + participant.id + "/remove",
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Accept: "application/json",
                "x-csrf-token": room.csrf,
              },
              body: JSON.stringify({ _csrf: room.csrf }),
            }
          ).then(() => refreshState());
        });
        row.appendChild(remove);
      }

      el.list.appendChild(row);
    });

    setText(el.joinedCount, String(S.participants.length));
    setText(el.participantSummary, String(S.participants.length));
  }

  async function refreshState() {
    if (S.leaving) return;
    try {
      const response = await fetch(urls.state, { headers: { Accept: "application/json" } });
      if (!response.ok) return;
      const data = await response.json();
      if (data.removed) {
        S.leaving = true;
        window.alert("The host removed you from this live classroom.");
        stopAll();
        window.location.href = room.detailsUrl;
        return;
      }
      if (!data.live) {
        S.leaving = true;
        stopAll();
        window.location.href = room.detailsUrl;
        return;
      }
      S.participants = data.participants || [];
      renderParticipants();
    } catch {
      /* transient network issue; the next poll retries */
    }
  }

  /* ------------------------------------------------------------------- chat */

  function appendMessage(message) {
    const empty = document.getElementById("chat-empty");
    if (empty) empty.remove();
    const wrapper = document.createElement("div");
    wrapper.className = "rounded-xl bg-slate-50 px-3 py-2";
    const author = document.createElement("p");
    author.className = "text-[10px] font-bold uppercase tracking-wide text-slate-400";
    author.textContent = message.author;
    const body = document.createElement("p");
    body.className = "mt-0.5 leading-relaxed";
    body.textContent = message.body;
    wrapper.append(author, body);
    el.chatMessages.appendChild(wrapper);
    el.chatMessages.scrollTop = el.chatMessages.scrollHeight;
  }

  async function loadChat() {
    if (!room.chatEnabled || S.leaving) return;
    try {
      const response = await fetch(urls.chat, { headers: { Accept: "application/json" } });
      if (!response.ok) return;
      const data = await response.json();
      (data.messages || []).forEach((message) => {
        if (message.id > S.lastMessageId) {
          S.lastMessageId = message.id;
          appendMessage(message);
        }
      });
    } catch {
      /* chat polling retries */
    }
  }

  async function sendChat(event) {
    event.preventDefault();
    const body = el.chatInput.value.trim();
    if (!body) return;
    try {
      const response = await fetch(urls.chat, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "x-csrf-token": room.csrf,
        },
        body: JSON.stringify({ body, token: room.token, _csrf: room.csrf }),
      });
      if (response.ok) {
        el.chatInput.value = "";
        loadChat();
      }
    } catch {
      /* the next poll retries */
    }
  }

  /* ----------------------------------------------------------------- leaving */

  function sendLeaveBeacon() {
    const payload = JSON.stringify({ _csrf: room.csrf, token: room.token });
    if (navigator.sendBeacon) {
      navigator.sendBeacon(urls.leave, new Blob([payload], { type: "application/json" }));
      return;
    }
    fetch(urls.leave, {
      method: "POST",
      keepalive: true,
      headers: {
        "Content-Type": "application/json",
        "x-csrf-token": room.csrf,
      },
      body: payload,
    }).catch(() => {});
  }

  function stopAll() {
    if (S.pollTimer) window.clearInterval(S.pollTimer);
    if (S.chatTimer) window.clearInterval(S.chatTimer);
    if (S.eventSource) {
      try {
        S.eventSource.close();
      } catch {
        /* already closed */
      }
      S.eventSource = null;
    }
    closeAllPeers();
    if (S.shareTrack && S.shareTrack.readyState === "live") S.shareTrack.stop();
    stopAudioVideoTracks();
    S.localStream = null;
    S.audioTrack = null;
    S.videoTrack = null;
    S.shareTrack = null;
    S.shareStream = null;
    if (S.localTile && S.localTile.video) S.localTile.video.srcObject = null;
  }

  function leaveMeeting() {
    if (S.leaving) return;
    S.leaving = true;
    stopAll();
    sendLeaveBeacon();
    window.location.href = room.detailsUrl;
  }

  async function endMeeting() {
    if (!window.confirm("End this live class for everyone and save attendance?")) return;
    try {
      const response = await fetch(urls.end, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "x-csrf-token": room.csrf,
        },
        body: JSON.stringify({ _csrf: room.csrf }),
      });
      const data = await response.json().catch(() => ({}));
      S.leaving = true;
      stopAll();
      window.location.href = data.redirect || room.detailsUrl;
    } catch {
      window.alert("Could not end the meeting. Please try again.");
    }
  }

  /* ------------------------------------------------------------------- wiring */

  el.camBtn.addEventListener("click", toggleCamera);
  el.micBtn.addEventListener("click", toggleMicrophone);
  if (el.camSelect) {
    el.camSelect.addEventListener("change", () => switchCamera(el.camSelect.value));
  }
  if (el.shareBtn) el.shareBtn.addEventListener("click", toggleShare);
  if (el.muteAllBtn) {
    el.muteAllBtn.addEventListener("click", () => {
      postSignal(null, "command", { action: "mute-all" }, true);
    });
  }
  el.leaveBtn.addEventListener("click", leaveMeeting);
  if (el.endBtn) el.endBtn.addEventListener("click", endMeeting);
  if (el.retryCamera) {
    el.retryCamera.addEventListener("click", () => {
      hideError();
      enableCamera();
    });
  }
  if (el.joinAudio) {
    el.joinAudio.addEventListener("click", () => {
      hideError();
      if (!S.audioTrack) retryMicrophone();
      setCameraState(S.videoTrack ? "on" : "off");
    });
  }
  if (el.chatForm) el.chatForm.addEventListener("submit", sendChat);

  window.addEventListener("pagehide", () => {
    stopAll();
    sendLeaveBeacon();
  });
  window.addEventListener("pageshow", (event) => {
    if (event.persisted) window.location.reload();
  });

  /* Read-only diagnostics for support and automated checks. */
  window.__VANGUARD_ROOM_DIAGNOSTICS__ = () => ({
    camera: S.camera,
    microphone: S.mic,
    sharing: S.sharing,
    localStream: Boolean(S.localStream),
    localVideo: {
      width: S.localTile && S.localTile.video ? S.localTile.video.videoWidth : 0,
      paused: S.localTile && S.localTile.video ? S.localTile.video.paused : true,
      hasStream: Boolean(S.localTile && S.localTile.video && S.localTile.video.srcObject),
    },
    peers: [...S.peers.values()].map((peer) => ({
      id: peer.id,
      name: peer.name,
      camOn: peer.camOn,
      videoWidth: peer.video.videoWidth,
      connection: peer.pc ? peer.pc.connectionState : "none",
      paused: peer.video.paused,
      readyState: peer.video.readyState,
      remoteTracks: peer.stream.getTracks().map((track) => ({
        kind: track.kind,
        muted: track.muted,
        readyState: track.readyState,
      })),
      transceivers: peer.pc
        ? peer.pc.getTransceivers().map((transceiver) => ({
            mid: transceiver.mid,
            direction: transceiver.direction,
            currentDirection: transceiver.currentDirection,
            sender: transceiver.sender.track
              ? transceiver.sender.track.kind + ":" + transceiver.sender.track.readyState
              : null,
            receiver: transceiver.receiver.track
              ? transceiver.receiver.track.kind +
                ":" +
                transceiver.receiver.track.muted +
                ":" +
                transceiver.receiver.track.readyState
              : null,
          }))
        : [],
    })),
    participantCount: S.participants.length,
    helloCount: S.helloCount,
    eventSourceState: S.eventSource ? S.eventSource.readyState : -1,
    signals: S.signalLog.slice(-12),
  });

  /* -------------------------------------------------------------------- start */

  initLocalTile();
  refreshState();
  loadChat();

  // Negotiate only after the local camera/microphone tracks exist (or media
  // acquisition has failed/timed out), so the first SDP answer can actually
  // publish both directions of media.
  const mediaReady = startMedia();
  const mediaTimeout = new Promise((resolve) => window.setTimeout(resolve, 15000));
  Promise.race([mediaReady, mediaTimeout]).then(joinSignals);
  S.pollTimer = window.setInterval(refreshState, 8000);
  S.chatTimer = window.setInterval(loadChat, 4000);
})();
