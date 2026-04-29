import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, onAuthStateChanged, signInAnonymously } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  collection,
  doc,
  getDocs,
  getFirestore,
  onSnapshot,
  query,
  runTransaction,
  serverTimestamp,
  where,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { FIREBASE_CONFIG, SESSION_ID } from "./firebase-config.js";

const MAX_TRIPS_PER_PLAYER = 50;
const colors = ["#ef6f6c", "#0f9d8d", "#f2a541", "#7b9acc", "#d17ab4", "#84b35a"];
const LOCAL_SESSION_KEY = "trip-sprint-local-session";
const LOCAL_UID_KEY = "trip-sprint-local-uid";

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

const state = {
  runtimeMode: "firebase",
  authUid: null,
  participants: [],
  visibleTripsByUid: {},
  isRoundActive: false,
  roundEndsAtMs: null,
  roundResult: null,
  maxTripsPerPlayer: MAX_TRIPS_PER_PLAYER,
  roundNumber: 1,
  sessionVersion: 1,
  adminUid: null,
  runtimeMessage: "",
  pendingStart: null,
  pendingStartMarker: null,
  drawnLayers: [],
  finalizeInFlight: false,
  unsubscribeSession: null,
  unsubscribeParticipants: null,
  unsubscribeTrips: null,
  tripSubscriptionKey: null,
};

let db;
let auth;
let sessionRef;
let participantsCollectionRef;
let participantTripsCollectionRef;

bindUiEvents();

if (!isFirebaseConfigReady()) {
  initializeLocalDemoMode();
} else {
  initializeRealtimeApp().catch((error) => {
    initializeLocalDemoMode(`Firebase unavailable. Falling back to local demo mode: ${error.message}`);
  });
}

setInterval(() => {
  renderTimer();
  void maybeFinalizeRound();
}, 250);

function bindUiEvents() {
  ui.joinBtn.addEventListener("click", () => toggleJoinModal(true));
  ui.cancelJoinBtn.addEventListener("click", () => toggleJoinModal(false));
  ui.joinModal.addEventListener("click", (event) => {
    if (event.target === ui.joinModal) {
      toggleJoinModal(false);
    }
  });

  ui.joinForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const name = ui.participantName.value.trim();
    const objectType = ui.participantObject.value;
    if (!name || !state.authUid) {
      return;
    }

    try {
      await joinRound(name, objectType);
      localStorage.setItem("trip-sprint-name", name);
      localStorage.setItem("trip-sprint-object", objectType);
      toggleJoinModal(false);
    } catch (error) {
      ui.mapHint.textContent = `Join failed: ${error.message}`;
    }
  });

  ui.startTimerBtn.addEventListener("click", async () => {
    try {
      await handleStartTimer();
    } catch (error) {
      ui.mapHint.textContent = `Unable to change round state: ${error.message}`;
    }
  });

  ui.clearStartBtn.addEventListener("click", () => {
    clearPendingStart();
    renderAll();
  });

  ui.deleteLastTripBtn.addEventListener("click", async () => {
    try {
      await deleteLastTrip();
    } catch (error) {
      ui.mapHint.textContent = `Could not delete trip: ${error.message}`;
    }
  });

  ui.clearResultsBtn.addEventListener("click", async () => {
    try {
      await clearPlayersForNextRound();
    } catch (error) {
      ui.mapHint.textContent = `Could not clear players: ${error.message}`;
    }
  });

  document.addEventListener("keydown", async (event) => {
    if (event.key === "Escape" && state.pendingStart) {
      clearPendingStart();
      renderAll();
    }

    if (event.key === "Backspace" && state.isRoundActive) {
      event.preventDefault();
      try {
        await deleteLastTrip();
      } catch (error) {
        ui.mapHint.textContent = `Could not delete trip: ${error.message}`;
      }
    }
  });

  map.on("click", async (event) => {
    if (!state.isRoundActive) {
      return;
    }

    const me = getMe();
    if (!me) {
      ui.mapHint.textContent = "Join first with your name and pin before adding trips.";
      toggleJoinModal(true);
      return;
    }

    if (me.tripCount >= state.maxTripsPerPlayer) {
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

    try {
      await addTrip({ lat: state.pendingStart.lat, lng: state.pendingStart.lng }, event.latlng);
      clearPendingStart();
      ui.mapHint.textContent = "Trip submitted. Add another start and end point.";
    } catch (error) {
      ui.mapHint.textContent = `Could not add trip: ${error.message}`;
    }
  });
}

async function initializeRealtimeApp() {
  const app = initializeApp(FIREBASE_CONFIG);
  auth = getAuth(app);
  db = getFirestore(app);
  sessionRef = doc(db, "sessions", SESSION_ID);
  participantsCollectionRef = collection(db, "sessions", SESSION_ID, "participants");
  participantTripsCollectionRef = collection(db, "sessions", SESSION_ID, "participantTrips");

  await signInAnonymously(auth);

  onAuthStateChanged(auth, (user) => {
    if (!user) {
      return;
    }

    state.authUid = user.uid;
    subscribeSession();
    restoreProfileOrPrompt();
  });
}

function initializeLocalDemoMode(message) {
  state.runtimeMode = "local";
  state.authUid = getOrCreateLocalUid();
  state.runtimeMessage = message || "Local demo mode active. This browser shares the round across tabs only. Add real Firebase config for shared GitHub Pages multiplayer.";
  restoreProfileOrPrompt();
  applyLocalSession(loadLocalSession());

  if (message) {
    ui.mapHint.textContent = message;
  } else {
    ui.mapHint.textContent = "Local demo mode active. Join works locally and syncs across tabs on this browser.";
  }

  window.addEventListener("storage", (event) => {
    if (event.key === LOCAL_SESSION_KEY) {
      applyLocalSession(loadLocalSession());
    }
  });
}

function getOrCreateLocalUid() {
  const existingUid = localStorage.getItem(LOCAL_UID_KEY);
  if (existingUid) {
    return existingUid;
  }

  const nextUid = `local-${crypto.randomUUID()}`;
  localStorage.setItem(LOCAL_UID_KEY, nextUid);
  return nextUid;
}

function createEmptyLocalSession() {
  return {
    adminUid: null,
    isRoundActive: false,
    roundEndsAtMs: null,
    roundResult: null,
    maxTripsPerPlayer: MAX_TRIPS_PER_PLAYER,
    roundNumber: 1,
    sessionVersion: 1,
    participants: {},
    participantTrips: {},
  };
}

function loadLocalSession() {
  const rawValue = localStorage.getItem(LOCAL_SESSION_KEY);
  if (!rawValue) {
    return createEmptyLocalSession();
  }

  try {
    const parsed = JSON.parse(rawValue);
    return {
      ...createEmptyLocalSession(),
      ...parsed,
      participants: parsed.participants || {},
      participantTrips: parsed.participantTrips || {},
    };
  } catch {
    return createEmptyLocalSession();
  }
}

function saveLocalSession(session) {
  localStorage.setItem(LOCAL_SESSION_KEY, JSON.stringify(session));
  applyLocalSession(session);
}

function applyLocalSession(session) {
  state.isRoundActive = Boolean(session.isRoundActive);
  state.roundEndsAtMs = session.roundEndsAtMs || null;
  state.roundResult = session.roundResult || null;
  state.maxTripsPerPlayer = session.maxTripsPerPlayer || MAX_TRIPS_PER_PLAYER;
  state.roundNumber = session.roundNumber || 1;
  state.sessionVersion = session.sessionVersion || 1;
  state.adminUid = session.adminUid || null;

  const visibleTripsByUid = {};
  const participants = Object.entries(session.participants || {})
    .map(([participantId, participant]) => {
      const participantTrips = session.participantTrips?.[participantId];
      const trips = participantTrips && participantTrips.sessionVersion === state.sessionVersion
        ? participantTrips.trips || []
        : [];

      if (participantId === state.authUid || participantId === state.adminUid) {
        visibleTripsByUid[participantId] = isAdminUser()
          ? trips
          : participantId === state.authUid
            ? trips
            : [];
      } else if (isAdminUser()) {
        visibleTripsByUid[participantId] = trips;
      }

      return {
        id: participantId,
        name: participant.name,
        objectType: participant.objectType,
        color: participant.color,
        tripCount: participant.tripCount || 0,
        totalDistanceKm: participant.totalDistanceKm || 0,
        longestTripDistanceKm: participant.longestTripDistanceKm || 0,
        isAdmin: participantId === session.adminUid,
        trips: [],
      };
    })
    .filter((participant) => participant.sessionVersion !== 0)
    .sort((left, right) => left.name.localeCompare(right.name));

  state.visibleTripsByUid = visibleTripsByUid;
  state.participants = participants;

  if (!state.isRoundActive) {
    clearPendingStart();
  }

  renderAll();
}

function subscribeSession() {
  if (state.unsubscribeSession) {
    state.unsubscribeSession();
  }

  state.unsubscribeSession = onSnapshot(
    sessionRef,
    (snapshot) => {
      if (!snapshot.exists()) {
        state.isRoundActive = false;
        state.roundEndsAtMs = null;
        state.roundResult = null;
        state.maxTripsPerPlayer = MAX_TRIPS_PER_PLAYER;
        state.roundNumber = 1;
        state.sessionVersion = 1;
        state.adminUid = null;
        syncParticipantsSubscription();
        syncTripsSubscription();
        renderAll();
        return;
      }

      const data = snapshot.data();
      state.isRoundActive = Boolean(data.isRoundActive);
      state.roundEndsAtMs = data.roundEndsAtMs || null;
      state.roundResult = data.roundResult || null;
      state.maxTripsPerPlayer = data.maxTripsPerPlayer || MAX_TRIPS_PER_PLAYER;
      state.roundNumber = data.roundNumber || 1;
      state.sessionVersion = data.sessionVersion || 1;
      state.adminUid = data.adminUid || null;
      state.runtimeMessage = "Shared live mode active. Participants on different devices join the same round.";

      if (!state.isRoundActive) {
        clearPendingStart();
      }

      syncParticipantsSubscription();
      syncTripsSubscription();
      renderAll();
      void maybeFinalizeRound();
    },
    (error) => {
      renderSetupError(`Realtime session unavailable: ${error.message}`);
    },
  );
}

function syncParticipantsSubscription() {
  if (!participantsCollectionRef) {
    return;
  }

  if (state.unsubscribeParticipants) {
    state.unsubscribeParticipants();
  }

  const participantsQuery = query(participantsCollectionRef, where("sessionVersion", "==", state.sessionVersion));
  state.unsubscribeParticipants = onSnapshot(participantsQuery, (snapshot) => {
    const previousTrips = state.visibleTripsByUid;
    state.participants = snapshot.docs
      .map((participantDoc) => {
        const data = participantDoc.data();
        return {
          id: participantDoc.id,
          name: data.name,
          objectType: data.objectType,
          color: data.color,
          tripCount: data.tripCount || 0,
          totalDistanceKm: data.totalDistanceKm || 0,
          longestTripDistanceKm: data.longestTripDistanceKm || 0,
          isAdmin: participantDoc.id === state.adminUid,
          trips: previousTrips[participantDoc.id] || [],
        };
      })
      .sort((left, right) => left.name.localeCompare(right.name));

    syncTripsSubscription();
    renderAll();
  });
}

function syncTripsSubscription() {
  if (!participantTripsCollectionRef || !state.authUid) {
    return;
  }

  const isAdmin = isAdminUser();
  const nextKey = `${state.sessionVersion}:${isAdmin ? "admin" : "self"}:${state.authUid}`;

  if (state.tripSubscriptionKey === nextKey) {
    return;
  }

  state.tripSubscriptionKey = nextKey;

  if (state.unsubscribeTrips) {
    state.unsubscribeTrips();
  }

  state.visibleTripsByUid = {};

  if (isAdmin) {
    const tripsQuery = query(participantTripsCollectionRef, where("sessionVersion", "==", state.sessionVersion));
    state.unsubscribeTrips = onSnapshot(tripsQuery, (snapshot) => {
      const nextTripsByUid = {};
      snapshot.forEach((tripDoc) => {
        nextTripsByUid[tripDoc.id] = tripDoc.data().trips || [];
      });
      state.visibleTripsByUid = nextTripsByUid;
      attachVisibleTrips();
      renderAll();
    });
    return;
  }

  state.unsubscribeTrips = onSnapshot(doc(participantTripsCollectionRef, state.authUid), (snapshot) => {
    const nextTripsByUid = {};
    if (snapshot.exists()) {
      const data = snapshot.data();
      if (data.sessionVersion === state.sessionVersion) {
        nextTripsByUid[state.authUid] = data.trips || [];
      }
    }
    state.visibleTripsByUid = nextTripsByUid;
    attachVisibleTrips();
    renderAll();
  });
}

function attachVisibleTrips() {
  state.participants = state.participants.map((participant) => ({
    ...participant,
    trips: state.visibleTripsByUid[participant.id] || [],
    isAdmin: participant.id === state.adminUid,
  }));
}

async function joinRound(name, objectType) {
  if (state.runtimeMode === "local") {
    const session = loadLocalSession();
    const participantId = state.authUid;
    const color = pickColor(participantId);

    if (!session.adminUid) {
      session.adminUid = participantId;
    }

    session.participants[participantId] = {
      name,
      objectType,
      color,
      tripCount: 0,
      totalDistanceKm: 0,
      longestTripDistanceKm: 0,
      sessionVersion: session.sessionVersion,
    };

    session.participantTrips[participantId] = {
      trips: [],
      sessionVersion: session.sessionVersion,
    };

    saveLocalSession(session);
    return;
  }

  const participantId = state.authUid;
  const participantRef = doc(participantsCollectionRef, participantId);
  const participantTripsRef = doc(participantTripsCollectionRef, participantId);
  const color = pickColor(participantId);

  await runTransaction(db, async (transaction) => {
    const sessionSnapshot = await transaction.get(sessionRef);

    let sessionData;
    if (!sessionSnapshot.exists()) {
      sessionData = {
        adminUid: participantId,
        isRoundActive: false,
        roundEndsAtMs: null,
        roundResult: null,
        maxTripsPerPlayer: MAX_TRIPS_PER_PLAYER,
        roundNumber: 1,
        sessionVersion: 1,
        updatedAt: serverTimestamp(),
      };
      transaction.set(sessionRef, sessionData);
    } else {
      sessionData = sessionSnapshot.data();
      const sessionPatch = {};
      if (!sessionData.maxTripsPerPlayer) {
        sessionPatch.maxTripsPerPlayer = MAX_TRIPS_PER_PLAYER;
      }
      if (!sessionData.roundNumber) {
        sessionPatch.roundNumber = 1;
      }
      if (!sessionData.sessionVersion) {
        sessionPatch.sessionVersion = 1;
      }
      if (!sessionData.adminUid) {
        sessionPatch.adminUid = participantId;
      }
      if (Object.keys(sessionPatch).length > 0) {
        sessionPatch.updatedAt = serverTimestamp();
        transaction.set(sessionRef, sessionPatch, { merge: true });
        sessionData = { ...sessionData, ...sessionPatch };
      }
    }

    const currentSessionVersion = sessionData.sessionVersion || 1;
    const publicSnapshot = await transaction.get(participantRef);
    const publicData = publicSnapshot.exists() ? publicSnapshot.data() : null;
    const sameSession = publicData && publicData.sessionVersion === currentSessionVersion;

    const participantBase = {
      name,
      objectType,
      color,
      sessionVersion: currentSessionVersion,
      updatedAt: serverTimestamp(),
    };

    if (sameSession) {
      transaction.set(participantRef, participantBase, { merge: true });
    } else {
      transaction.set(
        participantRef,
        {
          ...participantBase,
          tripCount: 0,
          totalDistanceKm: 0,
          longestTripDistanceKm: 0,
        },
        { merge: true },
      );

      transaction.set(
        participantTripsRef,
        {
          trips: [],
          sessionVersion: currentSessionVersion,
          updatedAt: serverTimestamp(),
        },
        { merge: true },
      );
    }
  });
}

async function handleStartTimer() {
  if (state.runtimeMode === "local") {
    if (!isAdminUser()) {
      return;
    }

    const session = loadLocalSession();
    if (session.adminUid !== state.authUid || session.isRoundActive) {
      return;
    }

    if (session.roundResult) {
      session.adminUid = null;
      session.isRoundActive = false;
      session.roundEndsAtMs = null;
      session.roundResult = null;
      session.roundNumber += 1;
      session.sessionVersion += 1;
      session.participants = {};
      session.participantTrips = {};
      saveLocalSession(session);
      return;
    }

    const activeParticipantIds = Object.keys(session.participants).filter(
      (participantId) => session.participants[participantId].sessionVersion === session.sessionVersion,
    );
    if (activeParticipantIds.length === 0) {
      return;
    }

    session.isRoundActive = true;
    session.roundEndsAtMs = Date.now() + 60000;
    session.roundResult = null;
    saveLocalSession(session);
    return;
  }

  if (!isAdminUser()) {
    return;
  }

  const activeParticipantsSnapshot = await getDocs(
    query(participantsCollectionRef, where("sessionVersion", "==", state.sessionVersion)),
  );

  await runTransaction(db, async (transaction) => {
    const sessionSnapshot = await transaction.get(sessionRef);
    if (!sessionSnapshot.exists()) {
      return;
    }

    const sessionData = sessionSnapshot.data();
    if (sessionData.adminUid !== state.authUid || sessionData.isRoundActive) {
      return;
    }

    if (sessionData.roundResult) {
      transaction.set(
        sessionRef,
        {
          adminUid: null,
          isRoundActive: false,
          roundEndsAtMs: null,
          roundResult: null,
          roundNumber: (sessionData.roundNumber || 1) + 1,
          sessionVersion: (sessionData.sessionVersion || 1) + 1,
          updatedAt: serverTimestamp(),
        },
        { merge: true },
      );
      return;
    }

    if (activeParticipantsSnapshot.empty) {
      return;
    }

    transaction.set(
      sessionRef,
      {
        isRoundActive: true,
        roundEndsAtMs: Date.now() + 60000,
        roundResult: null,
        updatedAt: serverTimestamp(),
      },
      { merge: true },
    );
  });
}

async function clearPlayersForNextRound() {
  if (state.runtimeMode === "local") {
    if (!isAdminUser()) {
      return;
    }

    const session = loadLocalSession();
    if (session.adminUid !== state.authUid) {
      return;
    }

    session.adminUid = null;
    session.isRoundActive = false;
    session.roundEndsAtMs = null;
    session.roundResult = null;
    session.roundNumber += 1;
    session.sessionVersion += 1;
    session.participants = {};
    session.participantTrips = {};
    saveLocalSession(session);
    return;
  }

  if (!isAdminUser()) {
    return;
  }

  await runTransaction(db, async (transaction) => {
    const sessionSnapshot = await transaction.get(sessionRef);
    if (!sessionSnapshot.exists()) {
      return;
    }

    const sessionData = sessionSnapshot.data();
    if (sessionData.adminUid !== state.authUid) {
      return;
    }

    transaction.set(
      sessionRef,
      {
        adminUid: null,
        isRoundActive: false,
        roundEndsAtMs: null,
        roundResult: null,
        roundNumber: (sessionData.roundNumber || 1) + 1,
        sessionVersion: (sessionData.sessionVersion || 1) + 1,
        updatedAt: serverTimestamp(),
      },
      { merge: true },
    );
  });
}

async function addTrip(start, endLatLng) {
  if (state.runtimeMode === "local") {
    const session = loadLocalSession();
    const participantId = state.authUid;
    const participant = session.participants[participantId];
    const participantTrips = session.participantTrips[participantId];
    if (!session.isRoundActive || !participant || !participantTrips) {
      return;
    }

    if (participant.sessionVersion !== session.sessionVersion || participantTrips.sessionVersion !== session.sessionVersion) {
      return;
    }

    const trips = [...(participantTrips.trips || [])];
    if (trips.length >= (session.maxTripsPerPlayer || MAX_TRIPS_PER_PLAYER)) {
      return;
    }

    const end = { lat: endLatLng.lat, lng: endLatLng.lng };
    const distanceKm = haversineKm(start.lat, start.lng, end.lat, end.lng);
    trips.push({ start, end, distanceKm });
    const summary = buildTripSummary(trips);

    session.participantTrips[participantId] = {
      trips,
      sessionVersion: session.sessionVersion,
    };
    session.participants[participantId] = {
      ...participant,
      tripCount: summary.tripCount,
      totalDistanceKm: summary.totalDistanceKm,
      longestTripDistanceKm: summary.longestTripDistanceKm,
      sessionVersion: session.sessionVersion,
    };

    saveLocalSession(session);
    return;
  }

  const participantId = state.authUid;
  const participantRef = doc(participantsCollectionRef, participantId);
  const participantTripsRef = doc(participantTripsCollectionRef, participantId);
  const end = { lat: endLatLng.lat, lng: endLatLng.lng };

  await runTransaction(db, async (transaction) => {
    const sessionSnapshot = await transaction.get(sessionRef);
    const participantSnapshot = await transaction.get(participantRef);
    const participantTripsSnapshot = await transaction.get(participantTripsRef);

    if (!sessionSnapshot.exists() || !participantSnapshot.exists()) {
      return;
    }

    const sessionData = sessionSnapshot.data();
    const participantData = participantSnapshot.data();
    const participantTripsData = participantTripsSnapshot.exists()
      ? participantTripsSnapshot.data()
      : { trips: [], sessionVersion: state.sessionVersion };

    if (!sessionData.isRoundActive || participantData.sessionVersion !== sessionData.sessionVersion) {
      return;
    }

    if (participantTripsData.sessionVersion !== sessionData.sessionVersion) {
      return;
    }

    const trips = Array.isArray(participantTripsData.trips) ? [...participantTripsData.trips] : [];
    if (trips.length >= (sessionData.maxTripsPerPlayer || MAX_TRIPS_PER_PLAYER)) {
      return;
    }

    const distanceKm = haversineKm(start.lat, start.lng, end.lat, end.lng);
    trips.push({ start, end, distanceKm });
    const summary = buildTripSummary(trips);

    transaction.set(
      participantTripsRef,
      {
        trips,
        sessionVersion: sessionData.sessionVersion,
        updatedAt: serverTimestamp(),
      },
      { merge: true },
    );

    transaction.set(
      participantRef,
      {
        tripCount: summary.tripCount,
        totalDistanceKm: summary.totalDistanceKm,
        longestTripDistanceKm: summary.longestTripDistanceKm,
        updatedAt: serverTimestamp(),
      },
      { merge: true },
    );
  });
}

async function deleteLastTrip() {
  if (state.runtimeMode === "local") {
    const session = loadLocalSession();
    const participantId = state.authUid;
    const participant = session.participants[participantId];
    const participantTrips = session.participantTrips[participantId];
    if (!session.isRoundActive || !participant || !participantTrips) {
      return;
    }

    const trips = [...(participantTrips.trips || [])];
    if (trips.length === 0) {
      return;
    }

    trips.pop();
    const summary = buildTripSummary(trips);
    session.participantTrips[participantId] = {
      trips,
      sessionVersion: session.sessionVersion,
    };
    session.participants[participantId] = {
      ...participant,
      tripCount: summary.tripCount,
      totalDistanceKm: summary.totalDistanceKm,
      longestTripDistanceKm: summary.longestTripDistanceKm,
      sessionVersion: session.sessionVersion,
    };

    saveLocalSession(session);
    return;
  }

  const me = getMe();
  if (!me || me.tripCount <= 0) {
    return;
  }

  const participantRef = doc(participantsCollectionRef, state.authUid);
  const participantTripsRef = doc(participantTripsCollectionRef, state.authUid);

  await runTransaction(db, async (transaction) => {
    const sessionSnapshot = await transaction.get(sessionRef);
    const participantTripsSnapshot = await transaction.get(participantTripsRef);

    if (!sessionSnapshot.exists() || !participantTripsSnapshot.exists()) {
      return;
    }

    const sessionData = sessionSnapshot.data();
    const tripsData = participantTripsSnapshot.data();
    if (!sessionData.isRoundActive || tripsData.sessionVersion !== sessionData.sessionVersion) {
      return;
    }

    const trips = Array.isArray(tripsData.trips) ? [...tripsData.trips] : [];
    if (trips.length === 0) {
      return;
    }

    trips.pop();
    const summary = buildTripSummary(trips);

    transaction.set(
      participantTripsRef,
      {
        trips,
        sessionVersion: sessionData.sessionVersion,
        updatedAt: serverTimestamp(),
      },
      { merge: true },
    );

    transaction.set(
      participantRef,
      {
        tripCount: summary.tripCount,
        totalDistanceKm: summary.totalDistanceKm,
        longestTripDistanceKm: summary.longestTripDistanceKm,
        updatedAt: serverTimestamp(),
      },
      { merge: true },
    );
  });
}

async function maybeFinalizeRound() {
  if (state.runtimeMode === "local") {
    if (!isAdminUser() || !state.isRoundActive || !state.roundEndsAtMs || state.finalizeInFlight) {
      return;
    }

    if (Date.now() < state.roundEndsAtMs) {
      return;
    }

    state.finalizeInFlight = true;
    try {
      const session = loadLocalSession();
      if (session.adminUid !== state.authUid || !session.isRoundActive) {
        return;
      }

      const participantSummaries = Object.entries(session.participants)
        .filter(([, participant]) => participant.sessionVersion === session.sessionVersion)
        .map(([participantId, participant]) => ({
          id: participantId,
          name: participant.name,
          tripCount: participant.tripCount || 0,
          longestTripDistanceKm: participant.longestTripDistanceKm || 0,
        }));

      session.isRoundActive = false;
      session.roundEndsAtMs = null;
      session.roundResult = calculateRoundResult(participantSummaries);
      saveLocalSession(session);
    } finally {
      state.finalizeInFlight = false;
    }
    return;
  }

  if (!isAdminUser() || !state.isRoundActive || !state.roundEndsAtMs || state.finalizeInFlight) {
    return;
  }

  if (Date.now() < state.roundEndsAtMs) {
    return;
  }

  state.finalizeInFlight = true;
  try {
    const participantSnapshots = await getDocs(
      query(participantsCollectionRef, where("sessionVersion", "==", state.sessionVersion)),
    );

    const summaries = participantSnapshots.docs.map((participantDoc) => {
      const data = participantDoc.data();
      return {
        id: participantDoc.id,
        name: data.name,
        tripCount: data.tripCount || 0,
        longestTripDistanceKm: data.longestTripDistanceKm || 0,
      };
    });

    const roundResult = calculateRoundResult(summaries);

    await runTransaction(db, async (transaction) => {
      const sessionSnapshot = await transaction.get(sessionRef);
      if (!sessionSnapshot.exists()) {
        return;
      }

      const sessionData = sessionSnapshot.data();
      if (sessionData.adminUid !== state.authUid || !sessionData.isRoundActive) {
        return;
      }

      if (sessionData.roundEndsAtMs && sessionData.roundEndsAtMs > Date.now()) {
        return;
      }

      transaction.set(
        sessionRef,
        {
          isRoundActive: false,
          roundEndsAtMs: null,
          roundResult,
          updatedAt: serverTimestamp(),
        },
        { merge: true },
      );
    });
  } finally {
    state.finalizeInFlight = false;
  }
}

function restoreProfileOrPrompt() {
  const name = localStorage.getItem("trip-sprint-name") || "";
  const objectType = localStorage.getItem("trip-sprint-object") || "pin";

  if (!name) {
    toggleJoinModal(true);
    return;
  }

  ui.participantName.value = name;
  ui.participantObject.value = objectType;
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
  attachVisibleTrips();
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

  const isLocal = state.runtimeMode === "local";
  const message = state.runtimeMessage || (isLocal
    ? "Local demo mode active."
    : "Shared live mode active.");

  ui.runtimeBanner.hidden = false;
  ui.runtimeBanner.textContent = message;
  ui.runtimeBanner.classList.toggle("is-live", !isLocal);
}

function renderTripControls() {
  const hasStartPoint = Boolean(state.pendingStart);
  const me = getMe();
  const hasTrips = me && me.tripCount > 0;

  ui.clearStartBtn.hidden = !hasStartPoint;
  ui.deleteLastTripBtn.hidden = !hasTrips;
}

function renderAdminControls() {
  const isAdmin = isAdminUser();
  const admin = state.participants.find((participant) => participant.id === state.adminUid);

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
    if (participant.id === state.authUid) {
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
    const badge = document.createElement("span");
    badge.className = "player-badge";
    badge.innerHTML = `
      <span class="marker-preview ${participant.objectType}" style="background:${participant.color};"></span>
      ${escapeHtml(participant.name)}${participant.id === state.adminUid ? " 👑 Admin" : ""}${participant.id === state.authUid ? " (You)" : ""}
    `;

    const stats = document.createElement("span");
    stats.className = "player-stats";
    stats.textContent = `${participant.tripCount}/${state.maxTripsPerPlayer} trips | ${participant.totalDistanceKm.toFixed(1)} km`;

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
    return;
  }

  if (!state.roundResult) {
    ui.results.classList.add("empty");
    ui.results.textContent = "Results appear when timer reaches 00:00.";
    return;
  }

  const { mostTripPlayers, highestCount, longestTripName, longestTripDistanceKm } = state.roundResult;
  ui.results.classList.remove("empty");

  if (!mostTripPlayers.length) {
    ui.results.innerHTML = `
      <div style="text-align: center; padding: 1rem;">
        <h3 style="font-size: 1.3rem; margin: 0 0 0.5rem; color: #0f9d8d;">Round ${state.roundNumber} Completed</h3>
        <div style="color: #355a5f; margin-top: 0.5rem;">No trips were added this round.</div>
        <div style="margin-top: 1rem; font-size: 0.9rem; color: #355a5f;">Admin can clear players and begin Round ${state.roundNumber + 1}</div>
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
    const tripsLeft = Math.max(0, state.maxTripsPerPlayer - me.tripCount);
    ui.mapHint.textContent = `Round live: click once for start, once for end to add your trip. ${tripsLeft} trips left.`;
    return;
  }

  if (!isAdminUser()) {
    if (state.roundResult) {
      ui.mapHint.textContent = `Round ${state.roundNumber} ended. Waiting for the admin to reset Round ${state.roundNumber + 1}.`;
      return;
    }

    ui.mapHint.textContent = `Round ${state.roundNumber} ready. Waiting for the admin to start the timer.`;
    return;
  }

  if (state.roundResult) {
    ui.mapHint.textContent = `Round ${state.roundNumber} ended. Start Timer or Clear Players will reset the game for Round ${state.roundNumber + 1}.`;
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
  return state.participants.find((participant) => participant.id === state.authUid) || null;
}

function isAdminUser() {
  return Boolean(state.authUid) && state.authUid === state.adminUid;
}

function renderTimer() {
  if (!state.isRoundActive || !state.roundEndsAtMs) {
    ui.timerDisplay.textContent = "01:00";
    return;
  }

  const remainingMs = Math.max(0, state.roundEndsAtMs - Date.now());
  const remainingSeconds = Math.ceil(remainingMs / 1000);
  const minutes = Math.floor(remainingSeconds / 60)
    .toString()
    .padStart(2, "0");
  const seconds = (remainingSeconds % 60).toString().padStart(2, "0");
  ui.timerDisplay.textContent = `${minutes}:${seconds}`;
}

function buildTripSummary(trips) {
  return {
    tripCount: trips.length,
    totalDistanceKm: trips.reduce((sum, trip) => sum + trip.distanceKm, 0),
    longestTripDistanceKm: trips.reduce((maxDistance, trip) => Math.max(maxDistance, trip.distanceKm), 0),
  };
}

function calculateRoundResult(participants) {
  if (participants.length === 0) {
    return null;
  }

  const highestCount = Math.max(...participants.map((participant) => participant.tripCount));
  const mostTripPlayers = highestCount === 0
    ? []
    : participants.filter((participant) => participant.tripCount === highestCount).map((participant) => participant.name);

  const longestTripParticipant = participants.reduce(
    (winner, participant) => (participant.longestTripDistanceKm > winner.longestTripDistanceKm ? participant : winner),
    { name: "No trips", longestTripDistanceKm: 0 },
  );

  return {
    mostTripPlayers,
    highestCount,
    longestTripName: longestTripParticipant.name,
    longestTripDistanceKm: longestTripParticipant.longestTripDistanceKm,
  };
}

function pickColor(seed) {
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) {
    hash = (hash * 31 + seed.charCodeAt(index)) >>> 0;
  }
  return colors[hash % colors.length];
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

function toRad(degrees) {
  return (degrees * Math.PI) / 180;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function isFirebaseConfigReady() {
  return Boolean(
    FIREBASE_CONFIG
      && FIREBASE_CONFIG.apiKey
      && !FIREBASE_CONFIG.apiKey.startsWith("YOUR_")
      && FIREBASE_CONFIG.projectId
      && !FIREBASE_CONFIG.projectId.startsWith("YOUR_"),
  );
}

function renderSetupError(message) {
  ui.joinBtn.disabled = true;
  ui.startTimerBtn.disabled = true;
  ui.clearStartBtn.hidden = true;
  ui.deleteLastTripBtn.hidden = true;
  ui.clearResultsBtn.hidden = true;
  ui.adminStatusBadge.textContent = "Setup Required";
  ui.adminStatusBadge.classList.remove("is-admin");
  ui.mapHint.textContent = message;
  ui.results.classList.remove("empty");
  ui.results.innerHTML = `<div>${escapeHtml(message)}</div>`;
}

renderAll();