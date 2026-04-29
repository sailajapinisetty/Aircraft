const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const MAX_TRIPS_PER_PLAYER = 50;

const colors = ["#ef6f6c", "#0f9d8d", "#f2a541", "#7b9acc", "#d17ab4", "#84b35a"];

const gameState = {
  participants: [],
  adminSocketId: null,
  isRoundActive: false,
  roundEndsAtMs: null,
  roundResult: null,
  roundNumber: 1,
  timerIntervalId: null,
  roundTimeoutId: null,
};

app.use(express.static(path.join(__dirname)));

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

io.on("connection", (socket) => {
  socket.emit("state:update", publicStateFor(socket.id));

  socket.on("player:join", ({ name, objectType }) => {
    const sanitizedName = sanitizeName(name);
    const sanitizedObjectType = sanitizeObjectType(objectType);
    if (!sanitizedName) {
      return;
    }

    const existing = gameState.participants.find((participant) => participant.socketId === socket.id);
    if (existing) {
      existing.name = sanitizedName;
      existing.objectType = sanitizedObjectType;
    } else {
      if (gameState.participants.length === 0) {
        gameState.adminSocketId = socket.id;
      }
      gameState.participants.push({
        id: randomId(),
        socketId: socket.id,
        name: sanitizedName,
        objectType: sanitizedObjectType,
        color: colors[gameState.participants.length % colors.length],
        trips: [],
      });
    }

    broadcastState();
  });

  socket.on("round:start", () => {
    if (socket.id !== gameState.adminSocketId) {
      return;
    }

    if (gameState.isRoundActive) {
      return;
    }

    // If starting a new round after a previous one ended, clear all participants first
    if (gameState.roundResult !== null) {
      gameState.participants = [];
      gameState.roundResult = null;
      gameState.roundNumber += 1;
      broadcastState();
      return;
    }

    // Need at least one participant to start
    if (gameState.participants.length === 0) {
      return;
    }

    resetTrips();
    gameState.roundResult = null;
    gameState.isRoundActive = true;
    gameState.roundEndsAtMs = Date.now() + 60000;
    startTimerBroadcast();

    gameState.roundTimeoutId = setTimeout(() => {
      endRound();
    }, 60000);

    broadcastState();
  });

  socket.on("trip:add", ({ start, end }) => {
    if (!gameState.isRoundActive) {
      return;
    }

    const participant = gameState.participants.find((player) => player.socketId === socket.id);
    if (!participant || !isValidPoint(start) || !isValidPoint(end)) {
      return;
    }

    if (participant.trips.length >= MAX_TRIPS_PER_PLAYER) {
      return;
    }

    const distanceKm = haversineKm(start.lat, start.lng, end.lat, end.lng);
    participant.trips.push({ start, end, distanceKm });
    broadcastState();
  });

  socket.on("trip:delete", ({ tripIndex }) => {
    if (!gameState.isRoundActive) {
      return;
    }

    const participant = gameState.participants.find((player) => player.socketId === socket.id);
    if (!participant || typeof tripIndex !== "number") {
      return;
    }

    if (tripIndex >= 0 && tripIndex < participant.trips.length) {
      participant.trips.splice(tripIndex, 1);
      broadcastState();
    }
  });

  socket.on("round:clearPlayers", () => {
    if (socket.id !== gameState.adminSocketId) {
      return;
    }

    gameState.participants = [];
    gameState.isRoundActive = false;
    gameState.roundResult = null;
    gameState.roundEndsAtMs = null;
    gameState.adminSocketId = null;
    gameState.roundNumber += 1;

    if (gameState.roundTimeoutId) {
      clearTimeout(gameState.roundTimeoutId);
      gameState.roundTimeoutId = null;
    }

    if (gameState.timerIntervalId) {
      clearInterval(gameState.timerIntervalId);
      gameState.timerIntervalId = null;
    }

    broadcastState();
  });

  socket.on("disconnect", () => {
    gameState.participants = gameState.participants.filter((participant) => participant.socketId !== socket.id);

    if (socket.id === gameState.adminSocketId) {
      gameState.adminSocketId = gameState.participants.length > 0 ? gameState.participants[0].socketId : null;
    }

    if (gameState.participants.length === 0 && gameState.isRoundActive) {
      endRound();
      return;
    }

    broadcastState();
  });
});

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`World Trip Sprint running on http://localhost:${PORT}`);
});

function publicStateFor(socketId) {
  const isAdmin = socketId === gameState.adminSocketId;

  return {
    participants: gameState.participants.map((participant) => ({
      id: participant.id,
      socketId: participant.socketId,
      name: participant.name,
      objectType: participant.objectType,
      color: participant.color,
      trips: isAdmin || participant.socketId === socketId ? participant.trips : [],
      tripCount: participant.trips.length,
      totalDistanceKm: participant.trips.reduce((sum, trip) => sum + trip.distanceKm, 0),
      isAdmin: participant.socketId === gameState.adminSocketId,
    })),
    isRoundActive: gameState.isRoundActive,
    roundEndsAtMs: gameState.roundEndsAtMs,
    roundResult: gameState.roundResult,
    roundNumber: gameState.roundNumber,
    maxTripsPerPlayer: MAX_TRIPS_PER_PLAYER,
  };
}

function broadcastState() {
  io.sockets.sockets.forEach((socket) => {
    socket.emit("state:update", publicStateFor(socket.id));
  });
}

function resetTrips() {
  gameState.participants.forEach((participant) => {
    participant.trips = [];
  });
}

function endRound() {
  gameState.isRoundActive = false;
  gameState.roundResult = calculateRoundResult();
  gameState.roundEndsAtMs = null;

  if (gameState.roundTimeoutId) {
    clearTimeout(gameState.roundTimeoutId);
    gameState.roundTimeoutId = null;
  }

  if (gameState.timerIntervalId) {
    clearInterval(gameState.timerIntervalId);
    gameState.timerIntervalId = null;
  }

  broadcastState();
}

function startTimerBroadcast() {
  if (gameState.timerIntervalId) {
    clearInterval(gameState.timerIntervalId);
  }

  gameState.timerIntervalId = setInterval(() => {
    if (!gameState.isRoundActive) {
      clearInterval(gameState.timerIntervalId);
      gameState.timerIntervalId = null;
      return;
    }

    broadcastState();
  }, 1000);
}

function calculateRoundResult() {
  if (gameState.participants.length === 0) {
    return null;
  }

  const tripCounts = gameState.participants.map((player) => ({
    name: player.name,
    count: player.trips.length,
  }));

  const highestCount = Math.max(...tripCounts.map((entry) => entry.count));
  const mostTripPlayers = highestCount === 0
    ? []
    : tripCounts.filter((entry) => entry.count === highestCount).map((entry) => entry.name);

  let longestTripName = "No trips";
  let longestTripDistanceKm = 0;

  gameState.participants.forEach((player) => {
    player.trips.forEach((trip) => {
      if (trip.distanceKm > longestTripDistanceKm) {
        longestTripDistanceKm = trip.distanceKm;
        longestTripName = player.name;
      }
    });
  });

  return {
    mostTripPlayers,
    highestCount,
    longestTripName,
    longestTripDistanceKm,
  };
}

function sanitizeName(name) {
  if (typeof name !== "string") {
    return "";
  }

  return name.trim().slice(0, 24);
}

function sanitizeObjectType(objectType) {
  const allowed = new Set(["pin", "diamond", "circle", "flag"]);
  if (!allowed.has(objectType)) {
    return "pin";
  }
  return objectType;
}

function isValidPoint(point) {
  if (!point || typeof point.lat !== "number" || typeof point.lng !== "number") {
    return false;
  }

  return point.lat >= -90 && point.lat <= 90 && point.lng >= -180 && point.lng <= 180;
}

function randomId() {
  return Math.random().toString(36).slice(2, 12);
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const earthRadiusKm = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return earthRadiusKm * c;
}

function toRad(deg) {
  return (deg * Math.PI) / 180;
}
