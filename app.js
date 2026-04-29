const map = L.map("map", {
  worldCopyJump: true,
  minZoom: 1,
  maxZoom: 18,
  zoomControl: true,
}).setView([20, 0], 1);

L.tileLayer("https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png", {
  subdomains: "abcd",
  attribution:
    '&copy; OpenStreetMap contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
}).addTo(map);

const socket = io();

const state = {
  participants: [],
  isRoundActive: false,
  roundEndsAtMs: null,
  roundResult: null,
  maxTripsPerPlayer: 50,
  roundNumber: 1,
  meSocketId: null,
  runtimeMessage: "Connecting to shared live server...",
  pendingStart: null,
  pendingStartMarker: null,
  drawnLayers: [],
};

const ui = {
  joinBtn: document.getElementById("joinBtn"),
  joinModal: document.getElementById("joinModal"),
  joinForm: document.getElementById("joinForm"),
  cancelJoinBtn: document.getElementById("cancelJoinBtn"),
  participantName: document.getElementById("participantName"),
  participantObject: document.getElementById("participantObject"),
  participantList: document.getElementById("participantList"),
  activeParticipantChips: document.getElementById("activeParticipantChips"),
  startTimerBtn: document.getElementById("startTimerBtn"),
  adminStatusBadge: document.getElementById("adminStatusBadge"),
  timerDisplay: document.getElementById("timerDisplay"),
  runtimeBanner: document.getElementById("runtimeBanner"),
  mapHint: document.getElementById("mapHint"),
  results: document.getElementById("results"),
  clearStartBtn: document.getElementById("clearStartBtn"),
  deleteLastTripBtn: document.getElementById("deleteLastTripBtn"),
  clearResultsBtn: document.getElementById("clearResultsBtn"),
};

ui.joinBtn.addEventListener("click", () => toggleJoinModal(true));
ui.cancelJoinBtn.addEventListener("click", () => toggleJoinModal(false));
ui.joinModal.addEventListener("click", (event) => {
  if (event.target === ui.joinModal) {
    toggleJoinModal(false);
  }
});

ui.joinForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const name = ui.participantName.value.trim();
  const objectType = ui.participantObject.value;
  if (!name) {
    return;
  }

  socket.emit("player:join", { name, objectType });
  localStorage.setItem("trip-sprint-name", name);
  localStorage.setItem("trip-sprint-object", objectType);
  toggleJoinModal(false);
});

ui.startTimerBtn.addEventListener("click", () => {
  socket.emit("round:start");
});

ui.clearStartBtn.addEventListener("click", () => {
  clearPendingStart();
  renderAll();
});

ui.deleteLastTripBtn.addEventListener("click", () => {
  const me = getMe();
  if (me && me.trips.length > 0) {
    socket.emit("trip:delete", { tripIndex: me.trips.length - 1 });
  }
});

ui.clearResultsBtn.addEventListener("click", () => {
  socket.emit("round:clearPlayers");
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && state.pendingStart) {
    clearPendingStart();
    renderAll();
  }

  if (event.key === "Backspace" && state.isRoundActive) {
    event.preventDefault();
    const me = getMe();
    if (me && me.trips.length > 0) {
      socket.emit("trip:delete", { tripIndex: me.trips.length - 1 });
    }
  }
});

map.on("click", (event) => {
  if (!state.isRoundActive) {
    return;
  }

  const me = getMe();
  if (!me) {
    ui.mapHint.textContent = "Join first with your name and pin before adding trips.";
    toggleJoinModal(true);
    return;
  }

  if (me.trips.length >= state.maxTripsPerPlayer) {
    clearPendingStart();
    ui.mapHint.textContent = `You reached the maximum of ${state.maxTripsPerPlayer} trips for this round.`;
    return;
  }

  if (!state.pendingStart) {
    state.pendingStart = event.latlng;
    state.pendingStartMarker = L.marker(event.latlng, {
      icon: L.divIcon({
        className: "temp-start-marker",
        iconSize: [14, 14],
      }),
    }).addTo(map);
    ui.mapHint.textContent = "Start point set. Click again to place the end point.";
    return;
  }

  socket.emit("trip:add", {
    start: { lat: state.pendingStart.lat, lng: state.pendingStart.lng },
    end: { lat: event.latlng.lat, lng: event.latlng.lng },
  });

  clearPendingStart();
  ui.mapHint.textContent = "Trip submitted. Add another start and end point.";
});

socket.on("connect", () => {
  state.meSocketId = socket.id;
  state.runtimeMessage = "Shared live server active. Share this deployed server URL with players.";
  restoreProfileOrPrompt();
  renderRuntimeBanner();
});

socket.on("disconnect", () => {
  state.runtimeMessage = "Connection lost. Waiting to reconnect to the shared live server.";
  renderRuntimeBanner();
});

socket.on("state:update", (serverState) => {
  state.participants = serverState.participants || [];
  state.isRoundActive = Boolean(serverState.isRoundActive);
  state.roundEndsAtMs = serverState.roundEndsAtMs || null;
  state.roundResult = serverState.roundResult || null;
  state.roundNumber = serverState.roundNumber || 1;
  state.maxTripsPerPlayer = serverState.maxTripsPerPlayer || 50;

  if (!state.isRoundActive) {
    clearPendingStart();
  }

  renderAll();
});

setInterval(renderTimer, 250);

function restoreProfileOrPrompt() {
  const name = localStorage.getItem("trip-sprint-name") || "";
  const objectType = localStorage.getItem("trip-sprint-object") || "pin";

  if (!name) {
    toggleJoinModal(true);
    return;
  }

  socket.emit("player:join", { name, objectType });
}

function toggleJoinModal(show) {
  ui.joinModal.classList.toggle("hidden", !show);
  if (show) {
    ui.participantName.value = localStorage.getItem("trip-sprint-name") || "";
    ui.participantObject.value = localStorage.getItem("trip-sprint-object") || "pin";
    ui.participantName.focus();
  }
}

function renderAll() {
  renderRuntimeBanner();
  renderParticipantChips();
  renderParticipantList();
  renderMapTrips();
  renderResults();
  renderTimer();
  renderHint();
  renderTripControls();
  renderAdminControls();
}

function renderRuntimeBanner() {
  if (!ui.runtimeBanner) {
    return;
  }

  ui.runtimeBanner.hidden = false;
  ui.runtimeBanner.textContent = state.runtimeMessage;
  ui.runtimeBanner.classList.toggle("is-live", socket.connected);
}

function renderTripControls() {
  const hasStartPoint = Boolean(state.pendingStart);
  const me = getMe();
  const hasTrips = me && me.trips.length > 0;

  ui.clearStartBtn.hidden = !hasStartPoint;
  ui.deleteLastTripBtn.hidden = !hasTrips;
}

function renderAdminControls() {
  const me = getMe();
  const isAdmin = me && me.isAdmin;
  const admin = state.participants.find((participant) => participant.isAdmin);

  ui.clearResultsBtn.hidden = !isAdmin || state.isRoundActive;
  ui.startTimerBtn.hidden = !isAdmin;
  ui.startTimerBtn.disabled = !isAdmin || state.isRoundActive || (state.participants.length === 0 && !state.roundResult);

  if (!admin) {
    ui.adminStatusBadge.textContent = "Waiting for admin";
    ui.adminStatusBadge.classList.remove("is-admin");
    return;
  }

  if (isAdmin) {
    ui.adminStatusBadge.textContent = "Admin Controls";
    ui.adminStatusBadge.classList.add("is-admin");
    return;
  }

  ui.adminStatusBadge.textContent = `${admin.name} controls the round`;
  ui.adminStatusBadge.classList.remove("is-admin");
}

function renderParticipantChips() {
  ui.activeParticipantChips.innerHTML = "";

  if (state.participants.length === 0) {
    const empty = document.createElement("span");
    empty.className = "empty-chip";
    empty.textContent = "No participants yet";
    ui.activeParticipantChips.appendChild(empty);
    return;
  }

  state.participants.forEach((participant) => {
    const chip = document.createElement("span");
    chip.className = "participant-chip";
    if (participant.socketId === state.meSocketId) {
      chip.classList.add("active");
    }

    chip.innerHTML = `
      <span class="marker-preview ${participant.objectType}" style="background:${participant.color};"></span>
      ${escapeHtml(participant.name)}
    `;

    ui.activeParticipantChips.appendChild(chip);
  });
}

function renderParticipantList() {
  ui.participantList.innerHTML = "";

  if (state.participants.length === 0) {
    const item = document.createElement("li");
    item.className = "empty";
    item.textContent = "No one joined yet.";
    ui.participantList.appendChild(item);
    return;
  }

  state.participants.forEach((participant) => {
    const item = document.createElement("li");
    const totalDistance = participant.totalDistanceKm ?? participant.trips.reduce((sum, trip) => sum + trip.distanceKm, 0);
    const tripCount = participant.tripCount ?? participant.trips.length;

    const badge = document.createElement("span");
    badge.className = "player-badge";
    badge.innerHTML = `
      <span class="marker-preview ${participant.objectType}" style="background:${participant.color};"></span>
      ${escapeHtml(participant.name)}${participant.isAdmin ? " 👑 Admin" : ""}${participant.socketId === state.meSocketId ? " (You)" : ""}
    `;

    const stats = document.createElement("span");
    stats.className = "player-stats";
    stats.textContent = `${tripCount}/${state.maxTripsPerPlayer} trips | ${totalDistance.toFixed(1)} km`;

    item.appendChild(badge);
    item.appendChild(stats);
    ui.participantList.appendChild(item);
  });
}

function renderMapTrips() {
  state.drawnLayers.forEach((layer) => map.removeLayer(layer));
  state.drawnLayers = [];

  state.participants.forEach((participant) => {
    participant.trips.forEach((trip) => {
      const path = L.polyline([trip.start, trip.end], {
        color: participant.color,
        weight: 3,
        opacity: 0.85,
      }).addTo(map);

      const startMarker = createParticipantMarker(trip.start, participant);
      const endMarker = createParticipantMarker(trip.end, participant);
      state.drawnLayers.push(path, startMarker, endMarker);
    });
  });
}

function renderResults() {
  if (state.isRoundActive) {
    ui.results.classList.add("empty");
    ui.results.textContent = "Round in progress...";
    ui.clearResultsBtn.hidden = true;
    return;
  }

  if (!state.roundResult) {
    ui.results.classList.add("empty");
    ui.results.textContent = "Results appear when timer reaches 00:00.";
    ui.clearResultsBtn.hidden = true;
    return;
  }

  const { mostTripPlayers, highestCount, longestTripName, longestTripDistanceKm } = state.roundResult;
  ui.results.classList.remove("empty");
  ui.clearResultsBtn.hidden = false;

  if (!mostTripPlayers.length) {
    ui.results.innerHTML = `
      <div style="text-align: center; padding: 1rem;">
        <h3 style="font-size: 1.3rem; margin: 0 0 0.5rem; color: #0f9d8d;">Round ${state.roundNumber} Completed</h3>
        <div style="color: #355a5f; margin-top: 0.5rem;">No trips were added this round.</div>
        <div style="margin-top: 1rem; font-size: 0.9rem; color: #355a5f;">Admin can clear players for Round ${state.roundNumber + 1}</div>
      </div>
    `;
    return;
  }

  const mostTripsWinners = mostTripPlayers.map((name) => escapeHtml(name)).join(", ");
  const longestTripWinner = escapeHtml(longestTripName);

  ui.results.innerHTML = `
    <div style="text-align: center; margin-bottom: 1rem;">
      <h3 style="font-size: 1.4rem; margin: 0; color: #0f9d8d;">🎊 Round ${state.roundNumber} Completed 🎊</h3>
      <div style="font-size: 0.95rem; color: #355a5f; margin-top: 0.3rem;">Congratulations to all participants!</div>
    </div>

    <div class="winner-celebration">
      <div style="font-size: 2rem; margin-bottom: 0.5rem;">👑 🏆 👑</div>
      <h3 style="margin: 0 0 0.5rem; font-size: 1.15rem;">Most Trips Champion</h3>
      <div class="winner-stat">🎁 Virtual Gold Trophy 🎁</div>
      <div class="winner-name"><span class="confetti">⭐</span> ${mostTripsWinners} <span class="confetti">⭐</span></div>
      <div class="winner-stat" style="font-size: 1rem; font-weight: 700; color: #0f9d8d; margin-top: 0.3rem;">🎖️ Completed ${highestCount} trips 🎖️</div>
    </div>

    <div class="winner-celebration">
      <div style="font-size: 2rem; margin-bottom: 0.5rem;">🌟 🗺️ 🌟</div>
      <h3 style="margin: 0 0 0.5rem; font-size: 1.15rem;">Longest Journey Champion</h3>
      <div class="winner-stat">🎁 Virtual Diamond Badge 🎁</div>
      <div class="winner-name"><span class="confetti">✨</span> ${longestTripWinner} <span class="confetti">✨</span></div>
      <div class="winner-stat" style="font-size: 1rem; font-weight: 700; color: #0f9d8d; margin-top: 0.3rem;">🌍 Traveled ${longestTripDistanceKm.toFixed(1)} km 🌍</div>
    </div>
  `;
}

function renderHint() {
  const me = getMe();
  if (!me) {
    ui.mapHint.textContent = `Round ${state.roundNumber} - Join with your name and pin to participate.`;
    return;
  }

  if (state.isRoundActive) {
    const tripsLeft = Math.max(0, state.maxTripsPerPlayer - me.trips.length);
    ui.mapHint.textContent = `Round live: click once for start, once for end to add your trip. ${tripsLeft} trips left.`;
    return;
  }

  if (!me.isAdmin) {
    if (state.roundResult) {
      ui.mapHint.textContent = `Round ${state.roundNumber} ended. Waiting for the admin to reset Round ${state.roundNumber + 1}.`;
      return;
    }

    ui.mapHint.textContent = `Round ${state.roundNumber} ready. Waiting for the admin to start the timer.`;
    return;
  }

  if (state.roundResult) {
    ui.mapHint.textContent = `Round ${state.roundNumber} ended. Use Clear Players to start Round ${state.roundNumber + 1}.`;
    return;
  }

  ui.mapHint.textContent = `Round ${state.roundNumber} ready to start. You are the admin and can click Start Timer.`;
}

function createParticipantMarker(latlng, participant) {
  return L.marker(latlng, {
    icon: L.divIcon({
      className: "participant-marker-wrap",
      html: `<div class="participant-marker ${participant.objectType}" style="--marker-color:${participant.color};"></div>`,
      iconSize: [20, 20],
      iconAnchor: [10, 10],
    }),
  }).addTo(map);
}

function clearPendingStart() {
  state.pendingStart = null;
  if (state.pendingStartMarker) {
    map.removeLayer(state.pendingStartMarker);
    state.pendingStartMarker = null;
  }
}

function getMe() {
  return state.participants.find((participant) => participant.socketId === state.meSocketId);
}

function renderTimer() {
  if (!state.isRoundActive || !state.roundEndsAtMs) {
    ui.timerDisplay.textContent = "01:00";
    return;
  }

  const remainingMs = Math.max(0, state.roundEndsAtMs - Date.now());
  const remainingSec = Math.ceil(remainingMs / 1000);
  const mins = Math.floor(remainingSec / 60)
    .toString()
    .padStart(2, "0");
  const secs = (remainingSec % 60).toString().padStart(2, "0");
  ui.timerDisplay.textContent = `${mins}:${secs}`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

renderAll();
