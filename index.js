require("dotenv").config();
const express = require("express");
const cors = require("cors");
const http = require("http");
const fs = require("fs");
const path = require("path");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { Server } = require("socket.io");

const app = express();
const PORT = 8787;

app.use(cors());
app.use(express.json({ limit: "8mb" }));

const server = http.createServer(app);

// PASS_BCAST4E_FIX_EXCHANGE_SELECTED_TRACKS_DEFAULTS
// SERVER FIRST — Cloudflare Exchange selectedTracks safety.
// Some older exchange routes write selectedTracks into AGV broadcast state
// even when using room-composite egress. These safe defaults prevent the
// exchange path from crashing and overwriting a good BCAST-4 state.
const selectedTracks = {
  videoTrackId: "",
  audioTrackId: "",
  participantIdentity: ""
};

// PASS_BCAST4G_FIX_EXCHANGE_SELECTED_SCREENSHARE_DEFAULTS
// SERVER FIRST — Cloudflare Exchange selectedScreenShare safety.
// The older exchange route may write screen share fields even when room-composite
// egress is used. These safe defaults prevent the exchange path from crashing.
const selectedScreenShare = {
  screenShareTrackId: "",
  screenShareParticipant: ""
};

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

const PRESENCE_STALE_MS = 45000;
const PRESENCE_SWEEP_MS = 15000;

const DATA_FILE = path.join(__dirname, "stro-cheivery-data.json");
const USERS_FILE = path.join(__dirname, "stro-cheivery-users.json");
const JWT_SECRET =
  process.env.AGV_JWT_SECRET || "agv-dev-secret-change-this-before-production";
const JWT_EXPIRES_IN = "7d";

const DEFAULT_ADMIN_USERNAME = "admin";
const DEFAULT_ADMIN_DISPLAY_NAME = "Admin";
const DEFAULT_ADMIN_PASSWORD =
  process.env.AGV_ADMIN_PASSWORD || "CHANGE_THIS_ADMIN_PASSWORD_NOW";

const DEFAULT_ROOMS = [
  {
    id: "main-hall",
    name: "Main Hall",
    category: "Convention",
    isPrivate: false,
    isLocked: false,
    assignedHost: "Admin",
    moderators: ["Admin"],
  },
  {
    id: "studio-a",
    name: "Studio A",
    category: "Media",
    isPrivate: false,
    isLocked: false,
    assignedHost: "Admin",
    moderators: [],
  },
  {
    id: "radio-room",
    name: "Radio Room",
    category: "Broadcast",
    isPrivate: false,
    isLocked: false,
    assignedHost: "Admin",
    moderators: [],
  },
  {
    id: "prayer-room",
    name: "Prayer Room",
    category: "Community",
    isPrivate: true,
    isLocked: false,
    assignedHost: "Admin",
    moderators: [],
  },
  {
    id: "classroom-1",
    name: "Classroom 1",
    category: "Teaching",
    isPrivate: false,
    isLocked: false,
    assignedHost: "Admin",
    moderators: [],
  },
  {
    id: "green-room",
    name: "Green Room",
    category: "Backstage",
    isPrivate: true,
    isLocked: false,
    assignedHost: "Admin",
    moderators: [],
  },
];

const DEFAULT_ROOM_STATE = {
  "main-hall": {
    messages: [
      {
        id: 1,
        sender: "System",
        text: "Welcome to Avant Global Vision.",
        time: timeNow(),
      },
      {
        id: 2,
        sender: "Admin",
        text: "Main stage is ready.",
        time: timeNow(),
      },
    ],
    bulletins: [
      "Welcome to Avant Global Vision.",
      "Your invited room opens directly after sign-in.",
      "Hosts and moderators manage each room separately.",
    ],
    bulletinSource: "manual",
  },
};

let rooms = [];
let roomState = {};
let users = [];
let presenceByRoom = {};

/*
  SAFE BUILD BROADCAST LAYER

  This stores only signaling state.
  It does NOT store video.
  Video moves browser-to-browser through WebRTC.

  roomBroadcasts shape:
  {
    "main-hall": {
      hostSocketId: "...",
      hostName: "Admin",
      mode: "camera" | "screen",
      startedAt: "..."
    }
  }
*/
const roomBroadcasts = {};

function timeNow() {
  return new Date().toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
}

function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function cleanName(value) {
  return String(value || "").trim();
}

function uniqueNames(values) {
  const seen = new Set();
  const output = [];

  for (const value of Array.isArray(values) ? values : []) {
    const cleaned = cleanName(value);
    if (!cleaned) continue;
    if (seen.has(cleaned)) continue;
    seen.add(cleaned);
    output.push(cleaned);
  }

  return output;
}

function safeUser(user) {
  return {
    username: user.username,
    displayName: user.displayName,
    globalRole: user.globalRole,
    isActive: Boolean(user.isActive),
    createdAt: user.createdAt,
  };
}

function defaultRoomState() {
  return {
    messages: [],
    bulletins: [],
    bulletinSource: "manual",
  };
}

function ensureRoomState(roomId) {
  if (!roomState[roomId]) {
    roomState[roomId] = defaultRoomState();
  }

  if (!Array.isArray(roomState[roomId].messages)) {
    roomState[roomId].messages = [];
  }

  if (!Array.isArray(roomState[roomId].bulletins)) {
    roomState[roomId].bulletins = [];
  }

  if (!roomState[roomId].bulletinSource) {
    roomState[roomId].bulletinSource = "manual";
  }

  return roomState[roomId];
}

function normalizeRoom(room) {
  return {
    id: room.id,
    name: room.name,
    category: room.category,
    isPrivate: Boolean(room.isPrivate),
    isLocked: Boolean(room.isLocked),
    assignedHost: cleanName(room.assignedHost) || "Admin",
    moderators: uniqueNames(room.moderators),
    host: cleanName(room.assignedHost) || "Admin",
  };
}

function sanitizeRoom(input) {
  return normalizeRoom({
    id: cleanName(input.id),
    name: cleanName(input.name),
    category: cleanName(input.category) || "Room",
    isPrivate: Boolean(input.isPrivate),
    isLocked: Boolean(input.isLocked),
    assignedHost: cleanName(input.assignedHost) || "Admin",
    moderators: uniqueNames(input.moderators),
  });
}

function getRoomSnapshot(roomId) {
  const room = findRoom(roomId);
  if (!room) return null;

  return {
    room: normalizeRoom(room),
    state: ensureRoomState(roomId),
    participants: getParticipantsForRoom(roomId),
    broadcast: roomBroadcasts[roomId] || null,
  };
}

function saveData() {
  fs.writeFileSync(
    DATA_FILE,
    JSON.stringify({ rooms, roomState }, null, 2),
    "utf8"
  );
}

function saveUsers() {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2), "utf8");
}

function loadData() {
  if (!fs.existsSync(DATA_FILE)) {
    rooms = DEFAULT_ROOMS.map(sanitizeRoom);
    roomState = JSON.parse(JSON.stringify(DEFAULT_ROOM_STATE));
    saveData();
    return;
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));

    rooms = Array.isArray(parsed.rooms)
      ? parsed.rooms.map(sanitizeRoom)
      : DEFAULT_ROOMS.map(sanitizeRoom);

    roomState =
      parsed.roomState && typeof parsed.roomState === "object"
        ? parsed.roomState
        : JSON.parse(JSON.stringify(DEFAULT_ROOM_STATE));

    for (const room of rooms) {
      ensureRoomState(room.id);
    }
  } catch (error) {
    rooms = DEFAULT_ROOMS.map(sanitizeRoom);
    roomState = JSON.parse(JSON.stringify(DEFAULT_ROOM_STATE));
    saveData();
  }
}

function seedDefaultAdmin() {
  if (users.some((user) => user.username === DEFAULT_ADMIN_USERNAME)) {
    return;
  }

  const passwordHash = bcrypt.hashSync(DEFAULT_ADMIN_PASSWORD, 10);

  users.push({
    username: DEFAULT_ADMIN_USERNAME,
    displayName: DEFAULT_ADMIN_DISPLAY_NAME,
    passwordHash,
    globalRole: "superadmin",
    isActive: true,
    createdAt: new Date().toISOString(),
  });

  saveUsers();
}

function loadUsers() {
  if (!fs.existsSync(USERS_FILE)) {
    users = [];
    seedDefaultAdmin();
    return;
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(USERS_FILE, "utf8"));
    users = Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    users = [];
  }

  seedDefaultAdmin();
}

function signToken(user) {
  return jwt.sign(
    {
      username: user.username,
      displayName: user.displayName,
      globalRole: user.globalRole,
    },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );
}

function verifyToken(token) {
  return jwt.verify(token, JWT_SECRET);
}

function getTokenFromRequest(req) {
  const authHeader = req.headers.authorization || "";
  if (!authHeader.startsWith("Bearer ")) return "";
  return authHeader.slice("Bearer ".length).trim();
}

function requireAuth(req, res, next) {
  try {
    const token = getTokenFromRequest(req);

    if (!token) {
      return res
        .status(401)
        .json({ ok: false, error: "Authentication required" });
    }

    const payload = verifyToken(token);
    const user = users.find((entry) => entry.username === payload.username);

    if (!user || !user.isActive) {
      return res.status(401).json({ ok: false, error: "Invalid user" });
    }

    req.authUser = safeUser(user);
    next();
  } catch (error) {
    return res.status(401).json({ ok: false, error: "Invalid token" });
  }
}

function requireSuperadmin(req, res, next) {
  if (!req.authUser || req.authUser.globalRole !== "superadmin") {
    return res.status(403).json({ ok: false, error: "Admin only" });
  }

  next();
}

function findRoom(roomId) {
  return rooms.find((room) => room.id === roomId);
}

function findUserByDisplayName(displayName) {
  const cleaned = cleanName(displayName);
  return users.find((user) => user.displayName === cleaned);
}

function getRole(room, authUser) {
  if (!authUser) return "viewer";
  if (authUser.globalRole === "superadmin") return "superadmin";
  if (!room) return "viewer";

  if (room.assignedHost === authUser.displayName) {
    return "host";
  }

  if (
    Array.isArray(room.moderators) &&
    room.moderators.includes(authUser.displayName)
  ) {
    return "moderator";
  }

  return "viewer";
}

function canManageModerators(room, authUser) {
  const role = getRole(room, authUser);
  return role === "superadmin" || role === "host";
}

function canManagePrivacy(room, authUser) {
  const role = getRole(room, authUser);
  return role === "superadmin" || role === "host" || role === "moderator";
}

function canControlStage(room, authUser) {
  const role = getRole(room, authUser);
  return role === "superadmin" || role === "host";
}

function canEnterRoom(room, authUser) {
  if (!room.isLocked) return true;

  const role = getRole(room, authUser);
  return role === "superadmin" || role === "host" || role === "moderator";
}

function emitRooms() {
  io.emit("rooms:update", {
    rooms: rooms.map(normalizeRoom),
  });
}

function emitPresence(roomId) {
  io.to(`room:${roomId}`).emit("presence:update", {
    roomId,
    participants: getParticipantsForRoom(roomId),
  });
}

function emitRoomState(roomId) {
  io.to(`room:${roomId}`).emit("roomstate:update", {
    roomId,
    state: ensureRoomState(roomId),
  });
}

function emitBroadcast(roomId) {
  io.to(`room:${roomId}`).emit("broadcast:update", {
    roomId,
    broadcast: roomBroadcasts[roomId] || null,
  });
}

function emitRoomSnapshot(roomId) {
  const snapshot = getRoomSnapshot(roomId);
  if (!snapshot) return;

  io.to(`room:${roomId}`).emit("room:snapshot", snapshot);
}

function getParticipantsForRoom(roomId) {
  const roomPresence = presenceByRoom[roomId] || {};
  const now = Date.now();

  return Object.values(roomPresence)
    .filter((entry) => now - entry.lastSeenAt <= PRESENCE_STALE_MS)
    .map((entry) => ({
      sessionId: entry.sessionId,
      name: entry.name,
      role: entry.role,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function clearStalePresence() {
  const now = Date.now();

  for (const roomId of Object.keys(presenceByRoom)) {
    const roomPresence = presenceByRoom[roomId] || {};
    let changed = false;

    for (const sessionId of Object.keys(roomPresence)) {
      if (now - roomPresence[sessionId].lastSeenAt > PRESENCE_STALE_MS) {
        delete roomPresence[sessionId];
        changed = true;
      }
    }

    if (changed) {
      emitPresence(roomId);
      emitRoomSnapshot(roomId);
    }
  }
}

function joinPresence(roomId, authUser, sessionId) {
  if (!presenceByRoom[roomId]) {
    presenceByRoom[roomId] = {};
  }

  const room = findRoom(roomId);
  const role = getRole(room, authUser);

  presenceByRoom[roomId][sessionId] = {
    sessionId,
    username: authUser.username,
    name: authUser.displayName,
    role,
    lastSeenAt: Date.now(),
  };

  return getParticipantsForRoom(roomId);
}

function heartbeatPresence(roomId, authUser, sessionId) {
  if (!presenceByRoom[roomId]) {
    presenceByRoom[roomId] = {};
  }

  const room = findRoom(roomId);
  const role = getRole(room, authUser);
  const existing = presenceByRoom[roomId][sessionId];

  presenceByRoom[roomId][sessionId] = {
    ...(existing || {}),
    sessionId,
    username: authUser.username,
    name: authUser.displayName,
    role,
    lastSeenAt: Date.now(),
  };

  return getParticipantsForRoom(roomId);
}

function leavePresence(roomId, sessionId) {
  if (!presenceByRoom[roomId]) {
    return getParticipantsForRoom(roomId);
  }

  delete presenceByRoom[roomId][sessionId];
  return getParticipantsForRoom(roomId);
}

function disconnectPresence(sessionId) {
  for (const roomId of Object.keys(presenceByRoom)) {
    if (presenceByRoom[roomId][sessionId]) {
      delete presenceByRoom[roomId][sessionId];
      emitPresence(roomId);
      emitRoomSnapshot(roomId);
    }
  }
}

function endBroadcastForSocket(socketId) {
  for (const roomId of Object.keys(roomBroadcasts)) {
    if (roomBroadcasts[roomId]?.hostSocketId === socketId) {
      delete roomBroadcasts[roomId];

      emitBroadcast(roomId);
      emitRoomSnapshot(roomId);

      io.to(`room:${roomId}`).emit("webrtc:stage-ended", {
        roomId,
      });
    }
  }
}

loadData();
loadUsers();
setInterval(clearStalePresence, PRESENCE_SWEEP_MS);

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    rooms: rooms.length,
    users: users.length,
    timestamp: new Date().toISOString(),
  });
});



// PASS34A_CLEAN_LIVEKIT_SERVER_REBUILD
function agvCleanText(value, fallback = "") {
  return String(value ?? fallback).trim();
}

function agvSafeIdentity(value, fallback = "agv-user") {
  const raw = agvCleanText(value, fallback).toLowerCase();

  const safe = raw
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);

  return safe || fallback;
}

function agvLiveKitEnvStatus() {
  const livekitUrl = agvCleanText(process.env.LIVEKIT_URL);
  const apiKey = agvCleanText(process.env.LIVEKIT_API_KEY);
  const apiSecret = agvCleanText(process.env.LIVEKIT_API_SECRET);

  return {
    livekitUrl,
    apiKey,
    apiSecret,
    livekitConfigured: Boolean(livekitUrl && apiKey && apiSecret),
    livekitUrlConfigured: Boolean(livekitUrl),
    apiKeyConfigured: Boolean(apiKey),
    apiSecretConfigured: Boolean(apiSecret),
    livekitUrlHost: livekitUrl.replace(/^wss?:\/\//i, "").replace(/\/.*$/, ""),
    apiKeyPrefix: apiKey ? apiKey.slice(0, 8) : "",
  };
}

app.get("/api/livekit/health", (req, res) => {
  const env = agvLiveKitEnvStatus();

  return res.json({
    ok: true,
    service: "AGV Clean LiveKit Server",
    pass: "PASS34A",
    livekitConfigured: env.livekitConfigured,
    livekitUrlConfigured: env.livekitUrlConfigured,
    apiKeyConfigured: env.apiKeyConfigured,
    apiSecretConfigured: env.apiSecretConfigured,
    livekitUrlHost: env.livekitUrlHost,
    apiKeyPrefix: env.apiKeyPrefix,
    timestamp: new Date().toISOString(),
  });
});

app.get("/api/livekit/config-check", (req, res) => {
  const env = agvLiveKitEnvStatus();

  return res.json({
    ok: true,
    service: "AGV LiveKit Config Check",
    pass: "PASS34A",
    expected: {
      livekitUrlFormat: "wss://your-project.livekit.cloud",
      keyAndSecretMustMatchSameProject: true,
    },
    current: {
      livekitConfigured: env.livekitConfigured,
      livekitUrlHost: env.livekitUrlHost,
      apiKeyPrefix: env.apiKeyPrefix,
      apiKeyConfigured: env.apiKeyConfigured,
      apiSecretConfigured: env.apiSecretConfigured,
    },
    warning:
      "If websocket signal connection still fails while this route is ok, verify LIVEKIT_URL, LIVEKIT_API_KEY, and LIVEKIT_API_SECRET all come from the same LiveKit Cloud project.",
    timestamp: new Date().toISOString(),
  });
});

app.post("/api/livekit/token", async (req, res) => {
  try {
    const env = agvLiveKitEnvStatus();

    if (!env.livekitConfigured) {
      return res.status(500).json({
        ok: false,
        pass: "PASS34A",
        error: "LiveKit env not configured",
        livekitUrlConfigured: env.livekitUrlConfigured,
        apiKeyConfigured: env.apiKeyConfigured,
        apiSecretConfigured: env.apiSecretConfigured,
      });
    }

    const { AccessToken } = require("livekit-server-sdk");

    const roomName = agvSafeIdentity(
      req.body?.roomName || req.body?.room || req.body?.roomId,
      "main-hall"
    );

    const requestedRole = agvCleanText(
      req.body?.role || req.body?.participantRole || "viewer",
      "viewer"
    ).toLowerCase();

    const displayName = agvCleanText(
      req.body?.name || req.body?.displayName || req.body?.identity,
      requestedRole === "host" ? "AGV Host" : "AGV Viewer"
    );

    const identityBase = agvSafeIdentity(
      req.body?.identity || req.body?.participantIdentity || displayName,
      requestedRole === "host" ? "agv-host" : "agv-viewer"
    );

    const identity = identityBase + "-" + Date.now();

    const canPublish =
      requestedRole === "host" ||
      requestedRole === "admin" ||
      requestedRole === "moderator" ||
      requestedRole === "superadmin" ||
      requestedRole === "super-admin" ||
      req.body?.canPublish === true;

    const at = new AccessToken(env.apiKey, env.apiSecret, {
      identity,
      name: displayName,
      ttl: "2h",
      metadata: JSON.stringify({
        agv: true,
        pass: "PASS34A",
        betaCompatibilityMode: true,
        role: requestedRole,
        displayName,
      }),
    });

    at.addGrant({
      roomJoin: true,
      room: roomName,
      canSubscribe: true,
      canPublish,
      canPublishData: true,
    });

    const jwt = await at.toJwt();

    return res.json({
      ok: true,
      pass: "PASS34A",
      betaCompatibilityMode: true,
      token: jwt,
      participant_token: jwt,
      server_url: env.livekitUrl,
      url: env.livekitUrl,
      roomName,
      identity,
      name: displayName,
      role: requestedRole,
      canPublish,
      livekitUrlHost: env.livekitUrlHost,
      apiKeyPrefix: env.apiKeyPrefix,
      issuedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error("PASS34A LIVEKIT TOKEN ERROR:", error);

    return res.status(500).json({
      ok: false,
      pass: "PASS34A",
      error: "LiveKit token failed",
      message: error?.message || "Unknown LiveKit token error",
    });
  }
});

app.post("/api/auth/login", (req, res) => {
  const username = cleanName(req.body?.username).toLowerCase();
  const password = String(req.body?.password || "");

  const user = users.find(
    (entry) => entry.username.toLowerCase() === username
  );

  if (!user || !user.isActive) {
    return res.status(401).json({ ok: false, error: "Login failed" });
  }

  const passwordOk = bcrypt.compareSync(password, user.passwordHash);

  if (!passwordOk) {
    return res.status(401).json({ ok: false, error: "Login failed" });
  }

  const token = signToken(user);

  return res.json({
    ok: true,
    token,
    user: safeUser(user),
  });
});

app.get("/api/auth/me", requireAuth, (req, res) => {
  return res.json({
    ok: true,
    user: req.authUser,
  });
});

app.post("/api/auth/change-password", requireAuth, (req, res) => {
  const currentPassword = String(req.body?.currentPassword || "");
  const newPassword = String(req.body?.newPassword || "");

  if (!currentPassword || !newPassword) {
    return res.status(400).json({
      ok: false,
      error: "Current and new passwords are required",
    });
  }

  if (newPassword.length < 8) {
    return res.status(400).json({
      ok: false,
      error: "New password must be at least 8 characters",
    });
  }

  const user = users.find((entry) => entry.username === req.authUser.username);

  if (!user) {
    return res.status(404).json({
      ok: false,
      error: "User not found",
    });
  }

  const passwordOk = bcrypt.compareSync(currentPassword, user.passwordHash);

  if (!passwordOk) {
    return res.status(401).json({
      ok: false,
      error: "Current password is incorrect",
    });
  }

  user.passwordHash = bcrypt.hashSync(newPassword, 10);
  saveUsers();

  return res.json({ ok: true });
});

app.post("/api/auth/register", requireAuth, requireSuperadmin, (req, res) => {
  const username = cleanName(req.body?.username).toLowerCase();
  const displayName = cleanName(req.body?.displayName);
  const password = String(req.body?.password || "");
  const globalRole =
    cleanName(req.body?.globalRole) === "superadmin" ? "superadmin" : "user";

  if (!username || !displayName || !password) {
    return res.status(400).json({
      ok: false,
      error: "Username, display name, and password are required",
    });
  }

  if (password.length < 8) {
    return res.status(400).json({
      ok: false,
      error: "Password must be at least 8 characters",
    });
  }

  if (users.some((user) => user.username.toLowerCase() === username)) {
    return res.status(409).json({
      ok: false,
      error: "Username already exists",
    });
  }

  if (users.some((user) => user.displayName === displayName)) {
    return res.status(409).json({
      ok: false,
      error: "Display name already exists",
    });
  }

  const user = {
    username,
    displayName,
    passwordHash: bcrypt.hashSync(password, 10),
    globalRole,
    isActive: true,
    createdAt: new Date().toISOString(),
  };

  users.push(user);
  saveUsers();

  return res.json({
    ok: true,
    user: safeUser(user),
  });
});

app.get("/api/admin/users", requireAuth, requireSuperadmin, (req, res) => {
  return res.json({
    ok: true,
    users: users.map(safeUser),
  });
});

app.post(
  "/api/admin/users/:username/deactivate",
  requireAuth,
  requireSuperadmin,
  (req, res) => {
    const username = cleanName(req.params.username).toLowerCase();
    const user = users.find(
      (entry) => entry.username.toLowerCase() === username
    );

    if (!user) {
      return res.status(404).json({
        ok: false,
        error: "User not found",
      });
    }

    if (user.username === DEFAULT_ADMIN_USERNAME) {
      return res.status(400).json({
        ok: false,
        error: "Cannot deactivate default admin",
      });
    }

    user.isActive = false;
    saveUsers();

    return res.json({
      ok: true,
      user: safeUser(user),
    });
  }
);

app.post(
  "/api/admin/users/:username/reactivate",
  requireAuth,
  requireSuperadmin,
  (req, res) => {
    const username = cleanName(req.params.username).toLowerCase();
    const user = users.find(
      (entry) => entry.username.toLowerCase() === username
    );

    if (!user) {
      return res.status(404).json({
        ok: false,
        error: "User not found",
      });
    }

    user.isActive = true;
    saveUsers();

    return res.json({
      ok: true,
      user: safeUser(user),
    });
  }
);

app.get("/api/rooms", requireAuth, (req, res) => {
  return res.json({
    ok: true,
    rooms: rooms.map(normalizeRoom),
  });
});

app.post("/api/rooms", requireAuth, (req, res) => {
  const name = cleanName(req.body?.name);
  const category = cleanName(req.body?.category) || "Custom";
  const isPrivate = Boolean(req.body?.isPrivate);

  if (!name) {
    return res.status(400).json({
      ok: false,
      error: "Room name is required",
    });
  }

  let id = slugify(name) || `room-${Date.now()}`;
  let attempt = 1;

  while (findRoom(id)) {
    attempt += 1;
    id = `${slugify(name)}-${attempt}`;
  }

  const room = sanitizeRoom({
    id,
    name,
    category,
    isPrivate,
    isLocked: false,
    assignedHost: req.authUser.displayName,
    moderators: [],
  });

  rooms.push(room);
  ensureRoomState(room.id);
  saveData();

  emitRooms();
  emitRoomSnapshot(room.id);

  return res.json({
    ok: true,
    room: normalizeRoom(room),
  });
});

app.get("/api/rooms/:roomId/state", requireAuth, (req, res) => {
  const room = findRoom(req.params.roomId);

  if (!room) {
    return res.status(404).json({
      ok: false,
      error: "Room not found",
    });
  }

  if (!canEnterRoom(room, req.authUser)) {
    return res.status(403).json({
      ok: false,
      error: "Room is locked",
    });
  }

  return res.json({
    ok: true,
    state: ensureRoomState(room.id),
    broadcast: roomBroadcasts[room.id] || null,
  });
});

app.post("/api/rooms/:roomId/assign-host", requireAuth, (req, res) => {
  const room = findRoom(req.params.roomId);

  if (!room) {
    return res.status(404).json({
      ok: false,
      error: "Room not found",
    });
  }

  if (req.authUser.globalRole !== "superadmin") {
    return res.status(403).json({
      ok: false,
      error: "Only Admin can assign a room host",
    });
  }

  const nextHostDisplayName = cleanName(
    req.body?.displayName || req.body?.user
  );

  if (!nextHostDisplayName) {
    return res.status(400).json({
      ok: false,
      error: "Host display name is required",
    });
  }

  const targetUser = findUserByDisplayName(nextHostDisplayName);

  if (!targetUser || !targetUser.isActive) {
    return res.status(404).json({
      ok: false,
      error: "Target user not found",
    });
  }

  room.assignedHost = targetUser.displayName;
  room.moderators = uniqueNames(room.moderators).filter(
    (name) => name !== targetUser.displayName
  );

  saveData();
  emitRooms();
  emitRoomSnapshot(room.id);

  return res.json({
    ok: true,
    room: normalizeRoom(room),
  });
});

app.post("/api/rooms/:roomId/add-moderator", requireAuth, (req, res) => {
  const room = findRoom(req.params.roomId);

  if (!room) {
    return res.status(404).json({
      ok: false,
      error: "Room not found",
    });
  }

  if (!canManageModerators(room, req.authUser)) {
    return res.status(403).json({
      ok: false,
      error: "Only Admin or the assigned host can add moderators",
    });
  }

  const nextModeratorDisplayName = cleanName(
    req.body?.displayName || req.body?.user
  );

  if (!nextModeratorDisplayName) {
    return res.status(400).json({
      ok: false,
      error: "Moderator display name is required",
    });
  }

  const targetUser = findUserByDisplayName(nextModeratorDisplayName);

  if (!targetUser || !targetUser.isActive) {
    return res.status(404).json({
      ok: false,
      error: "Target user not found",
    });
  }

  if (targetUser.displayName !== room.assignedHost) {
    room.moderators = uniqueNames([
      ...(room.moderators || []),
      targetUser.displayName,
    ]);
  }

  saveData();
  emitRooms();
  emitRoomSnapshot(room.id);

  return res.json({
    ok: true,
    room: normalizeRoom(room),
  });
});

app.post("/api/rooms/:roomId/remove-moderator", requireAuth, (req, res) => {
  const room = findRoom(req.params.roomId);

  if (!room) {
    return res.status(404).json({
      ok: false,
      error: "Room not found",
    });
  }

  if (!canManageModerators(room, req.authUser)) {
    return res.status(403).json({
      ok: false,
      error: "Only Admin or the assigned host can remove moderators",
    });
  }

  const moderatorDisplayName = cleanName(
    req.body?.displayName || req.body?.user
  );

  if (!moderatorDisplayName) {
    return res.status(400).json({
      ok: false,
      error: "Moderator display name is required",
    });
  }

  room.moderators = uniqueNames(room.moderators).filter(
    (name) => name !== moderatorDisplayName
  );

  saveData();
  emitRooms();
  emitRoomSnapshot(room.id);

  return res.json({
    ok: true,
    room: normalizeRoom(room),
  });
});

app.post("/api/rooms/:roomId/privacy", requireAuth, (req, res) => {
  const room = findRoom(req.params.roomId);

  if (!room) {
    return res.status(404).json({
      ok: false,
      error: "Room not found",
    });
  }

  if (!canManagePrivacy(room, req.authUser)) {
    return res.status(403).json({
      ok: false,
      error: "Not allowed",
    });
  }

  room.isPrivate = Boolean(req.body?.isPrivate);

  saveData();
  emitRooms();
  emitRoomSnapshot(room.id);

  return res.json({
    ok: true,
    room: normalizeRoom(room),
  });
});

app.post("/api/rooms/:roomId/lock", requireAuth, (req, res) => {
  const room = findRoom(req.params.roomId);

  if (!room) {
    return res.status(404).json({
      ok: false,
      error: "Room not found",
    });
  }

  if (!canManagePrivacy(room, req.authUser)) {
    return res.status(403).json({
      ok: false,
      error: "Not allowed",
    });
  }

  room.isLocked = Boolean(req.body?.isLocked);

  saveData();
  emitRooms();
  emitRoomSnapshot(room.id);

  return res.json({
    ok: true,
    room: normalizeRoom(room),
  });
});

app.post("/api/rooms/:roomId/messages", requireAuth, (req, res) => {
  const room = findRoom(req.params.roomId);

  if (!room) {
    return res.status(404).json({
      ok: false,
      error: "Room not found",
    });
  }

  if (!canEnterRoom(room, req.authUser)) {
    return res.status(403).json({
      ok: false,
      error: "Room is locked",
    });
  }

  const text = cleanName(req.body?.text);

  if (!text) {
    return res.status(400).json({
      ok: false,
      error: "Message text is required",
    });
  }

  const state = ensureRoomState(room.id);

  state.messages.push({
    id: Date.now(),
    sender: req.authUser.displayName,
    text,
    time: timeNow(),
  });

  saveData();
  emitRoomState(room.id);

  return res.json({
    ok: true,
    state,
  });
});

app.post("/api/rooms/:roomId/bulletins/add", requireAuth, (req, res) => {
  const room = findRoom(req.params.roomId);

  if (!room) {
    return res.status(404).json({
      ok: false,
      error: "Room not found",
    });
  }

  if (!canManagePrivacy(room, req.authUser)) {
    return res.status(403).json({
      ok: false,
      error: "Only Admin, host, or moderator can add bulletins",
    });
  }

  const text = cleanName(req.body?.text);

  if (!text) {
    return res.status(400).json({
      ok: false,
      error: "Bulletin text is required",
    });
  }

  const state = ensureRoomState(room.id);

  state.bulletins.push(text);
  state.bulletinSource = "manual";

  saveData();
  emitRoomState(room.id);

  return res.json({
    ok: true,
    state,
  });
});

app.post("/api/rooms/:roomId/bulletins/import", requireAuth, (req, res) => {
  const room = findRoom(req.params.roomId);

  if (!room) {
    return res.status(404).json({
      ok: false,
      error: "Room not found",
    });
  }

  if (!canManagePrivacy(room, req.authUser)) {
    return res.status(403).json({
      ok: false,
      error: "Only Admin, host, or moderator can import bulletins",
    });
  }

  const lines = Array.isArray(req.body?.lines)
    ? req.body.lines.map((line) => cleanName(line)).filter(Boolean)
    : [];

  if (lines.length === 0) {
    return res.status(400).json({
      ok: false,
      error: "No bulletin lines provided",
    });
  }

  const state = ensureRoomState(room.id);

  state.bulletins = lines;
  state.bulletinSource = "imported";

  saveData();
  emitRoomState(room.id);

  return res.json({
    ok: true,
    state,
  });
});

app.post("/api/rooms/:roomId/presence/join", requireAuth, (req, res) => {
  const room = findRoom(req.params.roomId);

  if (!room) {
    return res.status(404).json({
      ok: false,
      error: "Room not found",
    });
  }

  if (!canEnterRoom(room, req.authUser)) {
    return res.status(403).json({
      ok: false,
      error: "Room is locked",
    });
  }

  const sessionId = cleanName(req.body?.sessionId);

  if (!sessionId) {
    return res.status(400).json({
      ok: false,
      error: "Session id is required",
    });
  }

  const participants = joinPresence(room.id, req.authUser, sessionId);

  emitPresence(room.id);
  emitRoomSnapshot(room.id);

  return res.json({
    ok: true,
    participants,
  });
});

app.post(
  "/api/rooms/:roomId/presence/heartbeat",
  requireAuth,
  (req, res) => {
    const room = findRoom(req.params.roomId);

    if (!room) {
      return res.status(404).json({
        ok: false,
        error: "Room not found",
      });
    }

    const sessionId = cleanName(req.body?.sessionId);

    if (!sessionId) {
      return res.status(400).json({
        ok: false,
        error: "Session id is required",
      });
    }

    const participants = heartbeatPresence(room.id, req.authUser, sessionId);

    emitPresence(room.id);

    return res.json({
      ok: true,
      participants,
    });
  }
);

app.post("/api/rooms/:roomId/presence/leave", requireAuth, (req, res) => {
  const room = findRoom(req.params.roomId);

  if (!room) {
    return res.status(404).json({
      ok: false,
      error: "Room not found",
    });
  }

  const sessionId = cleanName(req.body?.sessionId);

  if (!sessionId) {
    return res.status(400).json({
      ok: false,
      error: "Session id is required",
    });
  }

  const participants = leavePresence(room.id, sessionId);

  emitPresence(room.id);
  emitRoomSnapshot(room.id);

  return res.json({
    ok: true,
    participants,
  });
});

app.post("/api/presence/disconnect", (req, res) => {
  const sessionId = cleanName(req.body?.sessionId);

  if (sessionId) {
    disconnectPresence(sessionId);
  }

  return res.json({ ok: true });
});

io.use((socket, next) => {
  try {
    const token = cleanName(socket.handshake.auth?.token);

    if (!token) {
      return next(new Error("Authentication required"));
    }

    const payload = verifyToken(token);
    const user = users.find((entry) => entry.username === payload.username);

    if (!user || !user.isActive) {
      return next(new Error("Invalid user"));
    }

    socket.authUser = safeUser(user);
    next();
  } catch (error) {
    next(new Error("Invalid token"));
  }
});

io.on("connection", (socket) => {
  socket.on("room:subscribe", ({ roomId, sessionId }) => {
    const room = findRoom(cleanName(roomId));
    if (!room) return;

    socket.join(`room:${room.id}`);

    if (sessionId) {
      heartbeatPresence(room.id, socket.authUser, cleanName(sessionId));
      emitPresence(room.id);
    }

    socket.emit("room:snapshot", getRoomSnapshot(room.id));

    const broadcast = roomBroadcasts[room.id];

    if (broadcast && !canControlStage(room, socket.authUser)) {
      io.to(broadcast.hostSocketId).emit("viewer:request-stage", {
        roomId: room.id,
        viewerSocketId: socket.id,
        viewerName: socket.authUser.displayName,
      });
    }
  });

  socket.on("room:unsubscribe", ({ roomId }) => {
    const room = findRoom(cleanName(roomId));
    if (!room) return;

    socket.leave(`room:${room.id}`);
  });

  socket.on("broadcast:start", ({ roomId, mode }) => {
    const room = findRoom(cleanName(roomId));
    if (!room) return;

    if (!canControlStage(room, socket.authUser)) {
      socket.emit("broadcast:error", {
        roomId: room.id,
        error: "Only Admin or the assigned host can broadcast to the stage",
      });
      return;
    }

    roomBroadcasts[room.id] = {
      hostSocketId: socket.id,
      hostName: socket.authUser.displayName,
      mode: cleanName(mode) || "camera",
      startedAt: new Date().toISOString(),
    };

    socket.join(`room:${room.id}`);

    emitBroadcast(room.id);
    emitRoomSnapshot(room.id);
  });

  socket.on("broadcast:stop", ({ roomId }) => {
    const room = findRoom(cleanName(roomId));
    if (!room) return;

    const broadcast = roomBroadcasts[room.id];

    if (
      broadcast?.hostSocketId === socket.id ||
      canControlStage(room, socket.authUser)
    ) {
      delete roomBroadcasts[room.id];

      emitBroadcast(room.id);
      emitRoomSnapshot(room.id);

      io.to(`room:${room.id}`).emit("webrtc:stage-ended", {
        roomId: room.id,
      });
    }
  });

  socket.on("viewer:request-stage", ({ roomId }) => {
    const room = findRoom(cleanName(roomId));
    if (!room) return;

    const broadcast = roomBroadcasts[room.id];

    if (!broadcast?.hostSocketId) {
      socket.emit("broadcast:update", {
        roomId: room.id,
        broadcast: null,
      });
      return;
    }

    io.to(broadcast.hostSocketId).emit("viewer:request-stage", {
      roomId: room.id,
      viewerSocketId: socket.id,
      viewerName: socket.authUser.displayName,
    });
  });

  socket.on("webrtc:offer", ({ roomId, viewerSocketId, description }) => {
    const room = findRoom(cleanName(roomId));
    if (!room) return;

    const broadcast = roomBroadcasts[room.id];

    if (!broadcast || broadcast.hostSocketId !== socket.id) {
      return;
    }

    io.to(viewerSocketId).emit("webrtc:offer", {
      roomId: room.id,
      hostSocketId: socket.id,
      hostName: socket.authUser.displayName,
      description,
    });
  });

  socket.on("webrtc:answer", ({ roomId, hostSocketId, description }) => {
    const room = findRoom(cleanName(roomId));
    if (!room) return;

    io.to(hostSocketId).emit("webrtc:answer", {
      roomId: room.id,
      viewerSocketId: socket.id,
      viewerName: socket.authUser.displayName,
      description,
    });
  });

  socket.on("webrtc:ice-candidate", ({ roomId, targetSocketId, candidate }) => {
    const room = findRoom(cleanName(roomId));

    if (!room || !targetSocketId || !candidate) {
      return;
    }

    io.to(targetSocketId).emit("webrtc:ice-candidate", {
      roomId: room.id,
      fromSocketId: socket.id,
      candidate,
    });
  });

  socket.on("disconnect", () => {
    disconnectPresence(socket.id);
    endBroadcastForSocket(socket.id);
  });
});



// PASS_BCAST1_BROADCAST_MODE_FOUNDATION
// SERVER FIRST — Broadcast Mode Foundation.
// This stores AGV broadcast viewer mode state only.
// It does not start Cloudflare, LiveKit Egress, RTMP, HLS, camera, or screen share.

const AGV_BCAST_FS = require("fs");
const AGV_BCAST_PATH = require("path");
const AGV_BROADCAST_STATE_FILE = AGV_BCAST_PATH.join(__dirname, "agv-broadcast-state.json");

function agvBroadcastDefaultState() {
  return {
    ok: true,
    service: "AGV Broadcast Mode",
    pass: "BCAST-1",
    provider: "manual",
    status: "off",
    isLive: false,
    roomId: "main-hall",
    title: "AGV Broadcast",
    playbackUrl: "",
    embedUrl: "",
    hlsUrl: "",
    viewerMode: "livekit",
    message: "Broadcast mode is off.",
    updatedAt: new Date().toISOString()
  };
}

function agvCleanBroadcastText(value, fallback = "") {
  return String(value ?? fallback).trim();
}

function agvCleanBroadcastUrl(value) {
  const clean = agvCleanBroadcastText(value, "");
  if (!clean) return "";

  if (
    clean.startsWith("https://") ||
    clean.startsWith("http://") ||
    clean.startsWith("wss://") ||
    clean.startsWith("rtmps://") ||
    clean.startsWith("rtmp://") ||
    clean.startsWith("srt://")
  ) {
    return clean;
  }

  return "";
}

function agvReadBroadcastState() {
  try {
    if (!AGV_BCAST_FS.existsSync(AGV_BROADCAST_STATE_FILE)) {
      const initial = agvBroadcastDefaultState();
      AGV_BCAST_FS.writeFileSync(
        AGV_BROADCAST_STATE_FILE,
        JSON.stringify(initial, null, 2),
        "utf8"
      );
      return initial;
    }

    const raw = AGV_BCAST_FS.readFileSync(AGV_BROADCAST_STATE_FILE, "utf8");
    const parsed = JSON.parse(raw);

    return {
      ...agvBroadcastDefaultState(),
      ...parsed,
      ok: true,
      service: "AGV Broadcast Mode",
      pass: "BCAST-1"
    };
  } catch (error) {
    console.error("AGV BROADCAST READ ERROR:", error);
    return agvBroadcastDefaultState();
  }
}

function agvWriteBroadcastState(nextState) {
  const current = agvReadBroadcastState();

  const safe = {
    ...current,
    ...nextState,
    ok: true,
    service: "AGV Broadcast Mode",
    pass: "BCAST-1",
    updatedAt: new Date().toISOString()
  };

  AGV_BCAST_FS.writeFileSync(
    AGV_BROADCAST_STATE_FILE,
    JSON.stringify(safe, null, 2),
    "utf8"
  );

  return safe;
}

app.get("/api/broadcast/health", (req, res) => {
  const state = agvReadBroadcastState();

  return res.json({
    ok: true,
    service: "AGV Broadcast Mode Foundation",
    pass: "BCAST-1",
    status: state.status,
    isLive: Boolean(state.isLive),
    provider: state.provider || "manual",
    viewerMode: state.viewerMode || "livekit",
    roomId: state.roomId || "main-hall",
    hasPlaybackUrl: Boolean(state.playbackUrl || state.embedUrl || state.hlsUrl),
    timestamp: new Date().toISOString()
  });
});

app.get("/api/broadcast/state", (req, res) => {
  return res.json({
    ok: true,
    state: agvReadBroadcastState()
  });
});

app.post("/api/broadcast/state", (req, res) => {
  const body = req.body || {};

  const next = agvWriteBroadcastState({
    provider: agvCleanBroadcastText(body.provider, "manual") || "manual",
    status: agvCleanBroadcastText(body.status, "off") || "off",
    isLive: Boolean(body.isLive),
    roomId: agvCleanBroadcastText(body.roomId, "main-hall") || "main-hall",
    title: agvCleanBroadcastText(body.title, "AGV Broadcast") || "AGV Broadcast",
    playbackUrl: agvCleanBroadcastUrl(body.playbackUrl),
    embedUrl: agvCleanBroadcastUrl(body.embedUrl),
    hlsUrl: agvCleanBroadcastUrl(body.hlsUrl),
    viewerMode: agvCleanBroadcastText(body.viewerMode, "broadcast") || "broadcast",
    message:
      agvCleanBroadcastText(body.message, "") ||
      (body.isLive ? "Broadcast mode is live." : "Broadcast mode is off.")
  });

  return res.json({
    ok: true,
    state: next
  });
});

app.post("/api/broadcast/start", (req, res) => {
  const body = req.body || {};

  const next = agvWriteBroadcastState({
    provider: agvCleanBroadcastText(body.provider, "manual") || "manual",
    status: "live",
    isLive: true,
    roomId: agvCleanBroadcastText(body.roomId, "main-hall") || "main-hall",
    title: agvCleanBroadcastText(body.title, "AGV Broadcast") || "AGV Broadcast",
    playbackUrl: agvCleanBroadcastUrl(body.playbackUrl),
    embedUrl: agvCleanBroadcastUrl(body.embedUrl),
    hlsUrl: agvCleanBroadcastUrl(body.hlsUrl),
    viewerMode: "broadcast",
    message:
      agvCleanBroadcastText(body.message, "Broadcast mode is live.") ||
      "Broadcast mode is live."
  });

  return res.json({
    ok: true,
    state: next
  });
});

app.post("/api/broadcast/stop", (req, res) => {
  const body = req.body || {};

  const next = agvWriteBroadcastState({
    status: "off",
    isLive: false,
    viewerMode: agvCleanBroadcastText(body.viewerMode, "livekit") || "livekit",
    message:
      agvCleanBroadcastText(body.message, "Broadcast mode is off.") ||
      "Broadcast mode is off."
  });

  return res.json({
    ok: true,
    state: next
  });
});



// PASS_BCAST3_CLOUDFLARE_STREAM_RTMP_FOUNDATION
// SERVER FIRST — Cloudflare Stream / RTMP Foundation.
// This adds Cloudflare broadcast configuration and start/stop endpoints.
// It does not start LiveKit Egress yet.
// It does not expose stream keys or API tokens.

function agvCloudflareBroadcastConfig() {
  const playbackUrl =
    process.env.AGV_CLOUDFLARE_PLAYBACK_URL ||
    process.env.CLOUDFLARE_STREAM_PLAYBACK_URL ||
    "";

  const embedUrl =
    process.env.AGV_CLOUDFLARE_EMBED_URL ||
    process.env.CLOUDFLARE_STREAM_EMBED_URL ||
    "";

  const hlsUrl =
    process.env.AGV_CLOUDFLARE_HLS_URL ||
    process.env.CLOUDFLARE_STREAM_HLS_URL ||
    "";

  const rtmpIngestUrl =
    process.env.AGV_CLOUDFLARE_RTMP_INGEST_URL ||
    process.env.CLOUDFLARE_RTMP_INGEST_URL ||
    "";

  const srtIngestUrl =
    process.env.AGV_CLOUDFLARE_SRT_INGEST_URL ||
    process.env.CLOUDFLARE_SRT_INGEST_URL ||
    "";

  const streamKey =
    process.env.AGV_CLOUDFLARE_STREAM_KEY ||
    process.env.CLOUDFLARE_STREAM_KEY ||
    "";

  const accountId =
    process.env.AGV_CLOUDFLARE_ACCOUNT_ID ||
    process.env.CLOUDFLARE_ACCOUNT_ID ||
    "";

  const apiToken =
    process.env.AGV_CLOUDFLARE_API_TOKEN ||
    process.env.CLOUDFLARE_API_TOKEN ||
    "";

  return {
    provider: "cloudflare",
    playbackUrl: agvCleanBroadcastUrl(playbackUrl),
    embedUrl: agvCleanBroadcastUrl(embedUrl),
    hlsUrl: agvCleanBroadcastUrl(hlsUrl),
    hasPlaybackUrl: Boolean(playbackUrl || embedUrl || hlsUrl),
    rtmpIngestUrlConfigured: Boolean(rtmpIngestUrl),
    srtIngestUrlConfigured: Boolean(srtIngestUrl),
    streamKeyConfigured: Boolean(streamKey),
    accountIdConfigured: Boolean(accountId),
    apiTokenConfigured: Boolean(apiToken),
  };
}

function agvChooseCloudflarePlayback(body = {}) {
  const envConfig = agvCloudflareBroadcastConfig();

  const bodyEmbedUrl = agvCleanBroadcastUrl(body.embedUrl);
  const bodyPlaybackUrl = agvCleanBroadcastUrl(body.playbackUrl);
  const bodyHlsUrl = agvCleanBroadcastUrl(body.hlsUrl);

  return {
    embedUrl: bodyEmbedUrl || envConfig.embedUrl || "",
    playbackUrl: bodyPlaybackUrl || envConfig.playbackUrl || "",
    hlsUrl: bodyHlsUrl || envConfig.hlsUrl || "",
  };
}

app.get("/api/broadcast/cloudflare/health", (req, res) => {
  const state = agvReadBroadcastState();
  const config = agvCloudflareBroadcastConfig();

  return res.json({
    ok: true,
    service: "AGV Cloudflare Broadcast Foundation",
    pass: "BCAST-3",
    provider: "cloudflare",
    broadcastStatus: state.status,
    isLive: Boolean(state.isLive),
    viewerMode: state.viewerMode || "livekit",
    roomId: state.roomId || "main-hall",
    hasPlaybackUrl: Boolean(state.playbackUrl || state.embedUrl || state.hlsUrl || config.hasPlaybackUrl),
    cloudflare: {
      hasEnvPlaybackUrl: config.hasPlaybackUrl,
      rtmpIngestUrlConfigured: config.rtmpIngestUrlConfigured,
      srtIngestUrlConfigured: config.srtIngestUrlConfigured,
      streamKeyConfigured: config.streamKeyConfigured,
      accountIdConfigured: config.accountIdConfigured,
      apiTokenConfigured: config.apiTokenConfigured,
    },
    timestamp: new Date().toISOString(),
  });
});

app.get("/api/broadcast/cloudflare/config-check", (req, res) => {
  const config = agvCloudflareBroadcastConfig();

  return res.json({
    ok: true,
    service: "AGV Cloudflare Stream Config Check",
    pass: "BCAST-3",
    expected: {
      playback: "AGV_CLOUDFLARE_EMBED_URL or AGV_CLOUDFLARE_PLAYBACK_URL or AGV_CLOUDFLARE_HLS_URL",
      ingest: "AGV_CLOUDFLARE_RTMP_INGEST_URL or AGV_CLOUDFLARE_SRT_INGEST_URL plus AGV_CLOUDFLARE_STREAM_KEY",
      secrets: "Stream keys and API tokens are never returned by this endpoint.",
    },
    current: {
      hasPlaybackUrl: config.hasPlaybackUrl,
      rtmpIngestUrlConfigured: config.rtmpIngestUrlConfigured,
      srtIngestUrlConfigured: config.srtIngestUrlConfigured,
      streamKeyConfigured: config.streamKeyConfigured,
      accountIdConfigured: config.accountIdConfigured,
      apiTokenConfigured: config.apiTokenConfigured,
    },
    timestamp: new Date().toISOString(),
  });
});

app.post("/api/broadcast/cloudflare/start", (req, res) => {
  const body = req.body || {};
  const playback = agvChooseCloudflarePlayback(body);

  const next = agvWriteBroadcastState({
    provider: "cloudflare",
    status: "live",
    isLive: true,
    roomId: agvCleanBroadcastText(body.roomId, "main-hall") || "main-hall",
    title: agvCleanBroadcastText(body.title, "AGV Cloudflare Broadcast") || "AGV Cloudflare Broadcast",
    playbackUrl: playback.playbackUrl,
    embedUrl: playback.embedUrl,
    hlsUrl: playback.hlsUrl,
    viewerMode: "broadcast",
    message:
      agvCleanBroadcastText(body.message, "Cloudflare broadcast mode is live.") ||
      "Cloudflare broadcast mode is live.",
    rtmpIngestUrlConfigured: agvCloudflareBroadcastConfig().rtmpIngestUrlConfigured,
  });

  return res.json({
    ok: true,
    service: "AGV Cloudflare Broadcast Start",
    pass: "BCAST-3",
    state: next,
    note:
      playback.embedUrl || playback.playbackUrl || playback.hlsUrl
        ? "Cloudflare broadcast state is live with a playback URL."
        : "Cloudflare broadcast state is live, but no playback URL is configured yet.",
  });
});

app.post("/api/broadcast/cloudflare/stop", (req, res) => {
  const body = req.body || {};

  const next = agvWriteBroadcastState({
    status: "off",
    isLive: false,
    viewerMode: agvCleanBroadcastText(body.viewerMode, "livekit") || "livekit",
    message:
      agvCleanBroadcastText(body.message, "Cloudflare broadcast mode is off.") ||
      "Cloudflare broadcast mode is off.",
  });

  return res.json({
    ok: true,
    service: "AGV Cloudflare Broadcast Stop",
    pass: "BCAST-3",
    state: next,
  });
});



// PASS_BCAST4_LIVEKIT_EGRESS_CLOUDFLARE_RTMP
// SERVER — LiveKit Egress to Cloudflare RTMP.
// This starts/stops LiveKit Room Composite Egress to Cloudflare RTMPS.
// It does not change client camera, screen share, tickets, chat, bulletin, rooms, payments, or Super Admin logic.

function agvLiveKitHttpUrl() {
  const raw =
    process.env.LIVEKIT_URL ||
    process.env.AGv_LIVEKIT_URL ||
    "";

  return String(raw || "")
    .trim()
    .replace(/^wss:\/\//i, "https://")
    .replace(/^ws:\/\//i, "http://");
}

function agvLiveKitEgressConfig() {
  const livekitUrl = agvLiveKitHttpUrl();
  const apiKey = String(process.env.LIVEKIT_API_KEY || "").trim();
  const apiSecret = String(process.env.LIVEKIT_API_SECRET || "").trim();
  const cf = agvCloudflareBroadcastConfig();

  return {
    livekitUrl,
    livekitConfigured: Boolean(livekitUrl && apiKey && apiSecret),
    apiKeyConfigured: Boolean(apiKey),
    apiSecretConfigured: Boolean(apiSecret),
    cloudflarePlaybackConfigured: Boolean(cf.hasPlaybackUrl),
    cloudflareRtmpConfigured: Boolean(cf.rtmpIngestUrlConfigured),
    cloudflareStreamKeyConfigured: Boolean(cf.streamKeyConfigured),
  };
}

function agvCloudflareRtmpStreamUrl() {
  const ingest =
    process.env.AGV_CLOUDFLARE_RTMP_INGEST_URL ||
    process.env.CLOUDFLARE_RTMP_INGEST_URL ||
    "";

  const streamKey =
    process.env.AGV_CLOUDFLARE_STREAM_KEY ||
    process.env.CLOUDFLARE_STREAM_KEY ||
    "";

  const cleanIngest = String(ingest || "").trim();
  const cleanKey = String(streamKey || "").trim();

  if (!cleanIngest || !cleanKey) {
    return "";
  }

  if (!cleanIngest.startsWith("rtmp://") && !cleanIngest.startsWith("rtmps://")) {
    return "";
  }

  if (cleanIngest.includes(cleanKey)) {
    return cleanIngest;
  }

  if (cleanIngest.endsWith("/")) {
    return cleanIngest + cleanKey;
  }

  return cleanIngest + "/" + cleanKey;
}

// PASS_BCAST4A_FIX_EGRESS_BIGINT_JSON
function agvSafeJsonValue(value) {
  if (typeof value === "bigint") {
    return value.toString();
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (Array.isArray(value)) {
    return value.map((item) => agvSafeJsonValue(item));
  }

  if (value && typeof value === "object") {
    const clean = {};

    for (const [key, item] of Object.entries(value)) {
      clean[key] = agvSafeJsonValue(item);
    }

    return clean;
  }

  return value;
}

// PASS_BCAST7_EGRESS_RECORD_AGV_LAYOUT_URL
function agvClientBroadcastBaseUrl() {
  const raw =
    process.env.AGV_CLIENT_BASE_URL ||
    process.env.AGV_BROADCAST_CLIENT_BASE_URL ||
    "https://agv-client.vercel.app";

  return String(raw || "https://agv-client.vercel.app").trim().replace(/\/+$/, "");
}

function agvBuildBroadcastLayoutUrl(roomId, body = {}) {
  const override =
    agvCleanBroadcastUrl(body.broadcastLayoutUrl) ||
    agvCleanBroadcastUrl(process.env.AGV_BROADCAST_LAYOUT_URL) ||
    "";

  if (override) {
    return override;
  }

  const base = agvClientBroadcastBaseUrl();
  const cleanRoom = encodeURIComponent(roomId || "main-hall");

  return `${base}/?agvBroadcastLayout=1&roomId=${cleanRoom}`;
}

// PASS_BCAST7A_V2_TEACHING_SCREENSHARE_LAYOUT_RESOLVER
// SERVER FIRST — Resolve AGV teaching layouts into LiveKit room-composite layouts.
// Goal: make screen share become the main teaching surface instead of a thumbnail.
function agvResolveTeachingEgressLayout(body = {}) {
  const requested =
    agvCleanBroadcastText(body.broadcastLayout, "") ||
    agvCleanBroadcastText(body.layout, "") ||
    "";

  const clean = String(requested || "").trim().toLowerCase();

  if (
    clean === "teaching-screen-share" ||
    clean === "screen-share-teaching" ||
    clean === "screenshare" ||
    clean === "screen-share" ||
    clean === "screen-share-dark"
  ) {
    return "screen-share";
  }

  if (clean === "grid" || clean === "grid-dark") {
    return clean;
  }

  if (clean === "speaker" || clean === "speaker-dark") {
    return clean;
  }

  // Safer AGV teaching default: speaker layout for camera-only,
  // while screen-share requests can explicitly become screen-share.
  return "speaker";
}

function agvSafeEgressSummary(info) {
  if (!info) return null;

  const safeInfo = agvSafeJsonValue(info);

  return {
    egressId: String(safeInfo.egressId || safeInfo.egress_id || safeInfo.id || ""),
    roomName: String(safeInfo.roomName || safeInfo.room_name || ""),
    status: String(safeInfo.status || ""),
    startedAt: String(safeInfo.startedAt || safeInfo.started_at || ""),
    updatedAt: String(safeInfo.updatedAt || safeInfo.updated_at || ""),
  };
}

app.get("/api/broadcast/egress/health", (req, res) => {
  const state = agvReadBroadcastState();
  const config = agvLiveKitEgressConfig();

  return res.json({
    ok: true,
    service: "AGV LiveKit Egress to Cloudflare RTMP",
    pass: "BCAST-4",
    broadcastStatus: state.status,
    viewerMode: state.viewerMode || "livekit",
    roomId: state.roomId || "main-hall",
    // PASS_BCAST4B_CLEAR_STOPPED_EGRESS_DISPLAY
    egressId: state.status === "live" ? state.egressId || "" : "",
    egressStatus:
      state.status === "live"
        ? state.egressStatus || ""
        : state.egressStatus === "not-found"
          ? "not-found"
          : state.egressStatus === "start-error"
            ? "start-error"
            : state.egressStatus === "stop-error"
              ? "stop-error"
              : "stopped",
    lastEgressId: state.lastEgressId || (state.status === "live" ? "" : state.egressId || ""),
    config: {
      livekitConfigured: config.livekitConfigured,
      apiKeyConfigured: config.apiKeyConfigured,
      apiSecretConfigured: config.apiSecretConfigured,
      cloudflarePlaybackConfigured: config.cloudflarePlaybackConfigured,
      cloudflareRtmpConfigured: config.cloudflareRtmpConfigured,
      cloudflareStreamKeyConfigured: config.cloudflareStreamKeyConfigured,
    },
    timestamp: new Date().toISOString(),
  });
});

app.post("/api/broadcast/egress/start", async (req, res) => {
  try {
    const body = req.body || {};
    const roomId = agvCleanBroadcastText(body.roomId, "main-hall") || "main-hall";
    const title =
      agvCleanBroadcastText(body.title, "AGV Live Broadcast") ||
      "AGV Live Broadcast";

    const config = agvLiveKitEgressConfig();

    if (!config.livekitConfigured) {
      return res.status(500).json({
        ok: false,
        pass: "BCAST-4",
        error: "LiveKit egress is not configured. Check LIVEKIT_URL, LIVEKIT_API_KEY, and LIVEKIT_API_SECRET.",
      });
    }

    if (!config.cloudflareRtmpConfigured || !config.cloudflareStreamKeyConfigured) {
      return res.status(500).json({
        ok: false,
        pass: "BCAST-4",
        error: "Cloudflare RTMPS ingest is not configured. Check AGV_CLOUDFLARE_RTMP_INGEST_URL and AGV_CLOUDFLARE_STREAM_KEY.",
      });
    }

    const streamUrl = agvCloudflareRtmpStreamUrl();

    if (!streamUrl) {
      return res.status(500).json({
        ok: false,
        pass: "BCAST-4",
        error: "Could not build Cloudflare RTMPS stream URL.",
      });
    }

    const {
      EgressClient,
      StreamOutput,
      StreamProtocol,
    } = require("livekit-server-sdk");

    const egressClient = new EgressClient(
      config.livekitUrl,
      process.env.LIVEKIT_API_KEY,
      process.env.LIVEKIT_API_SECRET
    );

    let output;

    try {
      output = new StreamOutput({
        protocol: StreamProtocol.RTMP,
        urls: [streamUrl],
      });
    } catch {
      output = {
        protocol: StreamProtocol.RTMP,
        urls: [streamUrl],
      };
    }

    // PASS_BCAST4F_RESTORE_ROOM_COMPOSITE_EGRESS
    // Restore stable LiveKit Room Composite Egress.
    // Web egress to AGV layout caused blank Cloudflare recordings/output on this build.
    const layout = agvResolveTeachingEgressLayout(body);

// PASS_BCAST4_FIX_SELECTED_LAYOUT_MODE_DEFAULTS
// BCAST-4 uses room-composite egress. These defaults prevent undefined
// layout/exchange fields when writing broadcast state.
const selectedLayoutMode = "room-composite";
const selectedLayoutName = layout;
const selectedExchangeMode = "room-composite";
const useScreenShareLayout = false;
const selectedScreenShare = {
  screenShareTrackId: "",
  screenShareParticipant: ""
};

// PASS_BCAST4_FIX_SELECTED_TRACKS_DEFAULTS
// Room-composite egress does not require manually selected host tracks.
const selectedTracks = {
  videoTrackId: "",
  audioTrackId: "",
  participantIdentity: ""
};

    const info = await egressClient.startRoomCompositeEgress(
      roomId,
      output,
      layout
    );

    const safeInfo = agvSafeEgressSummary(info);
    const egressId = safeInfo?.egressId || info?.egressId || "";

    const playback = agvChooseCloudflarePlayback(body);

    
// PASS_BCAST4F_PRESERVE_CLOUDFLARE_EMBED_URL
// SERVER FIRST — Preserve Cloudflare player URLs during LiveKit egress start.
const agvBcast4EmbedUrl =
  process.env.AGV_CLOUDFLARE_EMBED_URL ||
  process.env.CLOUDFLARE_STREAM_EMBED_URL ||
  "";

const agvBcast4HlsUrl =
  process.env.AGV_CLOUDFLARE_HLS_URL ||
  process.env.CLOUDFLARE_STREAM_HLS_URL ||
  "";

const agvBcast4PlaybackUrl =
  process.env.AGV_CLOUDFLARE_PLAYBACK_URL ||
  process.env.CLOUDFLARE_STREAM_PLAYBACK_URL ||
  agvBcast4EmbedUrl ||
  agvBcast4HlsUrl ||
  "";

const next = agvWriteBroadcastState({
      provider: "cloudflare",
      status: "live",
      isLive: true,
      viewerMode: "broadcast",
      roomId,
      title,
      playbackUrl: agvBcast4PlaybackUrl,
      embedUrl: agvBcast4EmbedUrl || agvBcast4PlaybackUrl,
      hlsUrl: agvBcast4HlsUrl,
      message:
        agvCleanBroadcastText(body.message, "LiveKit is sending the stage to Cloudflare broadcast.") ||
        "LiveKit is sending the stage to Cloudflare broadcast.",
      rtmpIngestUrlConfigured: true,
      egressId,
      egressStatus: safeInfo?.status || "started",
      egressStartedAt: new Date().toISOString(),
      egressUpdatedAt: new Date().toISOString(),
      egressLayoutMode: selectedLayoutMode,
      egressLayout: selectedLayoutName,
      selectedExchangeMode,
      screenShareDetected: useScreenShareLayout,
      selectedScreenShareTrackId: selectedScreenShare.screenShareTrackId,
      selectedScreenShareParticipant: selectedScreenShare.screenShareParticipant,
      selectedVideoTrackId: selectedTracks.videoTrackId,
      selectedAudioTrackId: selectedTracks.audioTrackId,
      selectedVideoParticipant: selectedTracks.videoParticipant,
      egressError: "",
    });

    return res.json({
      ok: true,
      service: "AGV LiveKit Egress Start",
      pass: "BCAST-4",
      state: next,
      egress: safeInfo,
      layout,
      note: "LiveKit room composite egress is sending the room to Cloudflare RTMPS.",
    });
  } catch (error) {
    const message = error?.message || String(error);

    // PASS_BCAST4D_EGRESS_FAILURE_AUTO_ROLLBACK
    // If LiveKit egress fails, do not leave viewers trapped in broadcast mode.
    const next = agvWriteBroadcastState({
      status: "off",
      isLive: false,
      viewerMode: "livekit",
      egressId: "",
      egressStatus: "start-error",
      egressError: message,
      egressUpdatedAt: new Date().toISOString(),
      message: "Broadcast start failed. AGV returned viewers to LiveKit mode.",
    });

    return res.status(500).json({
      ok: false,
      service: "AGV LiveKit Egress Start",
      pass: "BCAST-4",
      rollback: true,
      state: next,
      error: message,
    });
  }
});

app.post("/api/broadcast/egress/stop", async (req, res) => {
  try {
    const body = req.body || {};
    const current = agvReadBroadcastState();
    const egressId = agvCleanBroadcastText(body.egressId || current.egressId, "");

    if (!egressId) {
      const next = agvWriteBroadcastState({
        status: "off",
        isLive: false,
        viewerMode: "livekit",
        lastEgressId: current.lastEgressId || current.egressId || "",
        egressId: "",
        egressStatus: "not-found",
        egressUpdatedAt: new Date().toISOString(),
        message:
          agvCleanBroadcastText(body.message, "Broadcast egress was marked off.") ||
          "Broadcast egress was marked off.",
      });

      return res.json({
        ok: true,
        service: "AGV LiveKit Egress Stop",
        pass: "BCAST-4",
        state: next,
        note: "No egressId was saved, so AGV marked broadcast mode off.",
      });
    }

    const config = agvLiveKitEgressConfig();

    if (!config.livekitConfigured) {
      return res.status(500).json({
        ok: false,
        pass: "BCAST-4",
        error: "LiveKit egress is not configured.",
      });
    }

    const { EgressClient } = require("livekit-server-sdk");

    const egressClient = new EgressClient(
      config.livekitUrl,
      process.env.LIVEKIT_API_KEY,
      process.env.LIVEKIT_API_SECRET
    );

    const info = await egressClient.stopEgress(egressId);
    const safeInfo = agvSafeEgressSummary(info);

    const next = agvWriteBroadcastState({
      status: "off",
      isLive: false,
      viewerMode: "livekit",
      lastEgressId: egressId,
      egressId: "",
      egressStatus: "stopped",
      egressUpdatedAt: new Date().toISOString(),
      egressError: "",
      message:
        agvCleanBroadcastText(body.message, "LiveKit egress to Cloudflare is off.") ||
        "LiveKit egress to Cloudflare is off.",
    });

    return res.json({
      ok: true,
      service: "AGV LiveKit Egress Stop",
      pass: "BCAST-4",
      state: next,
      egress: safeInfo,
    });
  } catch (error) {
    const message = error?.message || String(error);

    const next = agvWriteBroadcastState({
      status: "off",
      isLive: false,
      viewerMode: "livekit",
      lastEgressId: current?.egressId || current?.lastEgressId || "",
      egressId: "",
      egressStatus: "stop-error",
      egressError: message,
      egressUpdatedAt: new Date().toISOString(),
    });

    return res.status(500).json({
      ok: false,
      service: "AGV LiveKit Egress Stop",
      pass: "BCAST-4",
      state: next,
      error: message,
    });
  }
});





// PASS_BCAST_DIRECT1_DIRECT_CLOUDFLARE_BROADCAST_MODE
// SERVER — Direct Cloudflare Broadcast Mode.
// This turns AGV broadcast mode on/off without starting LiveKit Egress.
// Video source should come directly from OBS/encoder into Cloudflare RTMPS.
// AGV viewers watch the existing Cloudflare HLS/player URL.

app.get("/api/broadcast/direct/health", (req, res) => {
  const state = agvReadBroadcastState();
  const cf = agvCloudflareBroadcastConfig();

  return res.json({
    ok: true,
    service: "AGV Direct Cloudflare Broadcast Mode",
    pass: "BCAST-DIRECT-1",
    broadcastStatus: state.status || "off",
    isLive: Boolean(state.isLive),
    viewerMode: state.viewerMode || "livekit",
    provider: state.provider || "manual",
    roomId: state.roomId || "main-hall",
    hasPlaybackUrl: Boolean(cf.hasPlaybackUrl),
    hlsUrlConfigured: Boolean(cf.hlsUrl),
    embedUrlConfigured: Boolean(cf.embedUrl),
    rtmpIngestUrlConfigured: Boolean(cf.rtmpIngestUrlConfigured),
    streamKeyConfigured: Boolean(cf.streamKeyConfigured),
    directMode: Boolean(state.directMode),
    // PASS_SCALE2_CONNECT_DIRECT_BROADCAST_TO_SOURCE_REGISTRY
    sourceRegistryConnected: typeof agvReadBroadcastSources === "function",
    note: "Direct mode expects a registered broadcast source feeding Cloudflare RTMPS.",
    timestamp: new Date().toISOString(),
  });
});

app.post("/api/broadcast/direct/start", async (req, res) => {
  try {
    // PASS_SCALE4_USE_SUPABASE_SOURCE_REGISTRY_FOR_DIRECT_BROADCAST
    // Scale-first: Direct Broadcast starts from Supabase source registry when available.
    const body = req.body || {};
    const cf = agvCloudflareBroadcastConfig();

    const roomId =
      typeof agvNormalizeBroadcastRoomId === "function"
        ? agvNormalizeBroadcastRoomId(body.roomId)
        : agvCleanBroadcastText(body.roomId, "main-hall") || "main-hall";

    let supabaseSource = null;
    let supabaseUsed = false;
    let supabaseError = "";

    try {
      const dbConfig =
        typeof agvSupabaseBroadcastConfig === "function"
          ? agvSupabaseBroadcastConfig()
          : null;

      const dbClient =
        typeof agvGetSupabaseBroadcastClient === "function"
          ? agvGetSupabaseBroadcastClient()
          : null;

      if (dbClient && dbConfig?.table) {
        const { data, error } = await dbClient
          .from(dbConfig.table)
          .select("*")
          .eq("room_id", roomId)
          .maybeSingle();

        if (error) {
          supabaseError = error.message || String(error);
        } else if (data) {
          supabaseSource = agvBroadcastSourceRowToApi(data);
          supabaseUsed = true;
        }
      }
    } catch (error) {
      supabaseError = error?.message || String(error);
    }

    const jsonSources =
      typeof agvReadBroadcastSources === "function"
        ? agvReadBroadcastSources()
        : {};

    const jsonSource =
      jsonSources[roomId] ||
      (typeof agvDefaultBroadcastSource === "function"
        ? agvDefaultBroadcastSource(roomId, body)
        : null);

    const selectedSource = supabaseSource || jsonSource || null;

    const playback = agvChooseCloudflarePlayback({
      ...body,
      hlsUrl: selectedSource?.hlsUrl || body.hlsUrl,
      playbackUrl: selectedSource?.playbackUrl || body.playbackUrl,
      embedUrl: selectedSource?.embedUrl || body.embedUrl,
    });

    const hasSourcePlayback =
      Boolean(selectedSource?.hasPlaybackUrl) ||
      Boolean(selectedSource?.hlsUrl) ||
      Boolean(selectedSource?.playbackUrl) ||
      Boolean(selectedSource?.embedUrl) ||
      Boolean(playback.hlsUrl) ||
      Boolean(playback.playbackUrl) ||
      Boolean(playback.embedUrl) ||
      Boolean(cf.hasPlaybackUrl);

    if (!hasSourcePlayback) {
      return res.status(500).json({
        ok: false,
        service: "AGV Direct Cloudflare Broadcast Start",
        pass: "SCALE-4",
        error: "No Cloudflare playback source is configured for this room. Register a Supabase broadcast source or check AGV_CLOUDFLARE_HLS_URL.",
        roomId,
        supabaseUsed,
        supabaseError,
      });
    }

    const sourceName =
      agvCleanBroadcastText(body.sourceName, selectedSource?.sourceName || "") ||
      selectedSource?.sourceName ||
      "AGV Direct Cloudflare Broadcast";

    const title =
      agvCleanBroadcastText(body.title, sourceName) ||
      sourceName ||
      "AGV Direct Cloudflare Broadcast";

    const now = new Date().toISOString();
    let nextSource = selectedSource || {};
    let dbUpdateOk = false;

    if (supabaseUsed && typeof agvGetSupabaseBroadcastClient === "function") {
      try {
        const dbConfig = agvSupabaseBroadcastConfig();
        const dbClient = agvGetSupabaseBroadcastClient();

        const rowUpdate = {
          status: "live",
          last_status_message:
            agvCleanBroadcastText(body.message, "AGV direct broadcast source is live.") ||
            "AGV direct broadcast source is live.",
          updated_at: now,
        };

        const { data, error } = await dbClient
          .from(dbConfig.table)
          .update(rowUpdate)
          .eq("room_id", roomId)
          .select("*")
          .maybeSingle();

        if (error) {
          supabaseError = error.message || String(error);
        } else if (data) {
          nextSource = agvBroadcastSourceRowToApi(data);
          dbUpdateOk = true;
        }
      } catch (error) {
        supabaseError = error?.message || String(error);
      }
    }

    if (!supabaseUsed) {
      if (typeof agvMergeBroadcastSource === "function") {
        nextSource = agvMergeBroadcastSource(selectedSource, {
          roomId,
          status: "live",
          lastStatusMessage:
            agvCleanBroadcastText(body.message, "AGV direct broadcast source is live.") ||
            "AGV direct broadcast source is live.",
          updatedAt: now,
        });
      } else {
        nextSource = {
          ...(selectedSource || {}),
          roomId,
          status: "live",
          updatedAt: now,
        };
      }

      if (typeof agvWriteBroadcastSources === "function") {
        jsonSources[roomId] = nextSource;
        agvWriteBroadcastSources(jsonSources);
      }
    }

    const next = agvWriteBroadcastState({
      provider: "cloudflare-direct",
      status: "live",
      isLive: true,
      viewerMode: "broadcast",
      roomId,
      eventId: nextSource?.eventId || body.eventId || "",
      title,
      sourceName,
      sourceType: nextSource?.sourceType || "direct-rtmps",
      playbackUrl: playback.playbackUrl || nextSource?.playbackUrl || "",
      embedUrl: playback.embedUrl || nextSource?.embedUrl || "",
      hlsUrl: playback.hlsUrl || nextSource?.hlsUrl || "",
      message:
        agvCleanBroadcastText(body.message, "AGV is receiving a direct Cloudflare broadcast feed.") ||
        "AGV is receiving a direct Cloudflare broadcast feed.",
      directMode: true,
      sourceRegistryConnected: true,
      sourceRegistryType: supabaseUsed ? "supabase" : "json",
      supabaseSourceUsed: Boolean(supabaseUsed),
      supabaseSourceUpdated: Boolean(dbUpdateOk),
      supabaseError,
      egressId: "",
      egressStatus: "not-used",
      egressError: "",
      egressLayoutMode: "direct-cloudflare",
      egressUpdatedAt: now,
      rtmpIngestUrlConfigured: Boolean(nextSource?.rtmpConfigured || cf.rtmpIngestUrlConfigured),
      streamKeyConfigured: Boolean(nextSource?.streamKeyConfigured || cf.streamKeyConfigured),
    });

    return res.json({
      ok: true,
      service: "AGV Direct Cloudflare Broadcast Start",
      pass: "SCALE-4",
      state: next,
      source: nextSource,
      sourceRegistryType: supabaseUsed ? "supabase" : "json",
      supabaseSourceUsed: Boolean(supabaseUsed),
      supabaseSourceUpdated: Boolean(dbUpdateOk),
      supabaseError,
      note: supabaseUsed
        ? "AGV viewer mode is now broadcast using the Supabase registered Cloudflare source."
        : "AGV viewer mode is now broadcast using the JSON registered Cloudflare source fallback.",
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      service: "AGV Direct Cloudflare Broadcast Start",
      pass: "SCALE-4",
      error: error?.message || String(error),
    });
  }
});

app.post("/api/broadcast/direct/stop", async (req, res) => {
  try {
    // PASS_SCALE4_USE_SUPABASE_SOURCE_REGISTRY_FOR_DIRECT_BROADCAST
    // Scale-first: Direct Broadcast stops update Supabase source registry when available.
    const body = req.body || {};
    const current = agvReadBroadcastState();

    const roomId =
      typeof agvNormalizeBroadcastRoomId === "function"
        ? agvNormalizeBroadcastRoomId(body.roomId || current.roomId || "main-hall")
        : agvCleanBroadcastText(body.roomId || current.roomId, "main-hall") || "main-hall";

    let supabaseSource = null;
    let supabaseUsed = false;
    let supabaseError = "";
    let dbUpdateOk = false;

    try {
      const dbConfig =
        typeof agvSupabaseBroadcastConfig === "function"
          ? agvSupabaseBroadcastConfig()
          : null;

      const dbClient =
        typeof agvGetSupabaseBroadcastClient === "function"
          ? agvGetSupabaseBroadcastClient()
          : null;

      if (dbClient && dbConfig?.table) {
        const { data, error } = await dbClient
          .from(dbConfig.table)
          .update({
            status: "standby",
            last_status_message:
              agvCleanBroadcastText(body.message, "Direct Cloudflare broadcast mode is off.") ||
              "Direct Cloudflare broadcast mode is off.",
            updated_at: new Date().toISOString(),
          })
          .eq("room_id", roomId)
          .select("*")
          .maybeSingle();

        if (error) {
          supabaseError = error.message || String(error);
        } else if (data) {
          supabaseSource = agvBroadcastSourceRowToApi(data);
          supabaseUsed = true;
          dbUpdateOk = true;
        }
      }
    } catch (error) {
      supabaseError = error?.message || String(error);
    }

    const sources =
      typeof agvReadBroadcastSources === "function"
        ? agvReadBroadcastSources()
        : {};

    let nextSource = supabaseSource || sources[roomId] || null;

    if (!supabaseUsed && nextSource && typeof agvMergeBroadcastSource === "function") {
      nextSource = agvMergeBroadcastSource(nextSource, {
        roomId,
        status: "standby",
        lastStatusMessage:
          agvCleanBroadcastText(body.message, "Direct Cloudflare broadcast mode is off.") ||
          "Direct Cloudflare broadcast mode is off.",
      });

      sources[roomId] = nextSource;

      if (typeof agvWriteBroadcastSources === "function") {
        agvWriteBroadcastSources(sources);
      }
    }

    const next = agvWriteBroadcastState({
      provider: current.provider || "cloudflare-direct",
      status: "off",
      isLive: false,
      viewerMode: "livekit",
      roomId,
      egressId: "",
      egressStatus: "not-used",
      egressError: "",
      directMode: false,
      sourceRegistryConnected: Boolean(nextSource),
      sourceRegistryType: supabaseUsed ? "supabase" : nextSource ? "json" : "",
      supabaseSourceUsed: Boolean(supabaseUsed),
      supabaseSourceUpdated: Boolean(dbUpdateOk),
      supabaseError,
      egressLayoutMode: "direct-cloudflare",
      egressUpdatedAt: new Date().toISOString(),
      message:
        agvCleanBroadcastText(body.message, "Direct Cloudflare broadcast mode is off.") ||
        "Direct Cloudflare broadcast mode is off.",
    });

    return res.json({
      ok: true,
      service: "AGV Direct Cloudflare Broadcast Stop",
      pass: "SCALE-4",
      state: next,
      source: nextSource,
      sourceRegistryType: supabaseUsed ? "supabase" : nextSource ? "json" : "",
      supabaseSourceUsed: Boolean(supabaseUsed),
      supabaseSourceUpdated: Boolean(dbUpdateOk),
      supabaseError,
      note: supabaseUsed
        ? "AGV viewer mode returned to LiveKit and the Supabase registered broadcast source was marked standby."
        : "AGV viewer mode returned to LiveKit and JSON source fallback was used.",
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      service: "AGV Direct Cloudflare Broadcast Stop",
      pass: "SCALE-4",
      error: error?.message || String(error),
    });
  }
});



// PASS_SCALE1_BROADCAST_SOURCE_REGISTRY
// SERVER — Broadcast Source Registry.
// Scale-first foundation for mapping AGV rooms/events to Cloudflare broadcast sources.
// This does not start LiveKit egress and does not change client UI.

const AGV_BROADCAST_SOURCES_FILE =
  process.env.AGV_BROADCAST_SOURCES_FILE ||
  path.join(__dirname, "agv-broadcast-sources.json");

function agvReadBroadcastSources() {
  try {
    if (!fs.existsSync(AGV_BROADCAST_SOURCES_FILE)) {
      return {};
    }

    const raw = fs.readFileSync(AGV_BROADCAST_SOURCES_FILE, "utf8");
    const parsed = JSON.parse(raw || "{}");

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }

    return parsed;
  } catch {
    return {};
  }
}

function agvWriteBroadcastSources(nextSources) {
  const clean =
    nextSources && typeof nextSources === "object" && !Array.isArray(nextSources)
      ? nextSources
      : {};

  fs.writeFileSync(
    AGV_BROADCAST_SOURCES_FILE,
    JSON.stringify(clean, null, 2),
    "utf8"
  );

  return clean;
}

function agvNormalizeBroadcastRoomId(roomId) {
  return agvCleanBroadcastText(roomId, "main-hall") || "main-hall";
}

function agvDefaultBroadcastSource(roomId = "main-hall", body = {}) {
  const cf = agvCloudflareBroadcastConfig();
  const playback = agvChooseCloudflarePlayback(body || {});
  const cleanRoomId = agvNormalizeBroadcastRoomId(roomId);

  return {
    roomId: cleanRoomId,
    eventId: agvCleanBroadcastText(body.eventId, "") || "",
    sourceName:
      agvCleanBroadcastText(body.sourceName, "AGV Main Broadcast Source") ||
      "AGV Main Broadcast Source",
    provider: agvCleanBroadcastText(body.provider, "cloudflare") || "cloudflare",
    sourceType:
      agvCleanBroadcastText(body.sourceType, "direct-rtmps") || "direct-rtmps",
    status: agvCleanBroadcastText(body.status, "standby") || "standby",
    hlsUrl: playback.hlsUrl || "",
    playbackUrl: playback.playbackUrl || "",
    embedUrl: playback.embedUrl || "",
    rtmpConfigured: Boolean(cf.rtmpIngestUrlConfigured),
    streamKeyConfigured: Boolean(cf.streamKeyConfigured),
    hasPlaybackUrl: Boolean(cf.hasPlaybackUrl),
    notes:
      agvCleanBroadcastText(
        body.notes,
        "Broadcast source feeds Cloudflare RTMPS and AGV viewers watch Cloudflare playback."
      ) ||
      "Broadcast source feeds Cloudflare RTMPS and AGV viewers watch Cloudflare playback.",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function agvMergeBroadcastSource(existing, incoming) {
  const now = new Date().toISOString();

  return {
    ...(existing || {}),
    ...incoming,
    roomId: incoming.roomId || existing?.roomId || "main-hall",
    createdAt: existing?.createdAt || incoming.createdAt || now,
    updatedAt: now,
  };
}

app.get("/api/broadcast/sources/health", (req, res) => {
  const sources = agvReadBroadcastSources();
  const cf = agvCloudflareBroadcastConfig();

  return res.json({
    ok: true,
    service: "AGV Broadcast Source Registry",
    pass: "SCALE-1",
    sourceCount: Object.keys(sources).length,
    defaultRoomId: "main-hall",
    cloudflare: {
      hasPlaybackUrl: Boolean(cf.hasPlaybackUrl),
      hlsUrlConfigured: Boolean(cf.hlsUrl),
      embedUrlConfigured: Boolean(cf.embedUrl),
      rtmpIngestUrlConfigured: Boolean(cf.rtmpIngestUrlConfigured),
      streamKeyConfigured: Boolean(cf.streamKeyConfigured),
    },
    file: path.basename(AGV_BROADCAST_SOURCES_FILE),
    note: "Scale-first registry maps AGV rooms/events to Cloudflare broadcast sources.",
    timestamp: new Date().toISOString(),
  });
});

app.get("/api/broadcast/sources/list", (req, res) => {
  const sources = agvReadBroadcastSources();

  return res.json({
    ok: true,
    service: "AGV Broadcast Source Registry",
    pass: "SCALE-1",
    sources: Object.values(sources),
    count: Object.keys(sources).length,
    timestamp: new Date().toISOString(),
  });
});

app.get("/api/broadcast/sources/:roomId", (req, res) => {
  const roomId = agvNormalizeBroadcastRoomId(req.params.roomId);
  const sources = agvReadBroadcastSources();

  const source = sources[roomId] || agvDefaultBroadcastSource(roomId);

  return res.json({
    ok: true,
    service: "AGV Broadcast Source Registry",
    pass: "SCALE-1",
    source,
    exists: Boolean(sources[roomId]),
    timestamp: new Date().toISOString(),
  });
});

app.post("/api/broadcast/sources/register", (req, res) => {
  try {
    const body = req.body || {};
    const roomId = agvNormalizeBroadcastRoomId(body.roomId);
    const sources = agvReadBroadcastSources();

    const incoming = agvDefaultBroadcastSource(roomId, body);
    const nextSource = agvMergeBroadcastSource(sources[roomId], incoming);

    sources[roomId] = nextSource;
    agvWriteBroadcastSources(sources);

    return res.json({
      ok: true,
      service: "AGV Broadcast Source Registry",
      pass: "SCALE-1",
      source: nextSource,
      message: "Broadcast source registered.",
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      service: "AGV Broadcast Source Registry",
      pass: "SCALE-1",
      error: error?.message || String(error),
      timestamp: new Date().toISOString(),
    });
  }
});

app.post("/api/broadcast/sources/status", (req, res) => {
  try {
    const body = req.body || {};
    const roomId = agvNormalizeBroadcastRoomId(body.roomId);
    const sources = agvReadBroadcastSources();

    const current = sources[roomId] || agvDefaultBroadcastSource(roomId, body);

    const allowedStatuses = [
      "standby",
      "ready",
      "live",
      "offline",
      "testing",
      "error",
    ];

    const requestedStatus =
      agvCleanBroadcastText(body.status, current.status || "standby") ||
      "standby";

    const status = allowedStatuses.includes(requestedStatus)
      ? requestedStatus
      : "standby";

    const nextSource = agvMergeBroadcastSource(current, {
      status,
      notes: agvCleanBroadcastText(body.notes, current.notes || "") || current.notes || "",
      lastStatusMessage:
        agvCleanBroadcastText(body.message, "") ||
        agvCleanBroadcastText(body.lastStatusMessage, "") ||
        "",
    });

    sources[roomId] = nextSource;
    agvWriteBroadcastSources(sources);

    return res.json({
      ok: true,
      service: "AGV Broadcast Source Registry",
      pass: "SCALE-1",
      source: nextSource,
      message: "Broadcast source status updated.",
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      service: "AGV Broadcast Source Registry",
      pass: "SCALE-1",
      error: error?.message || String(error),
      timestamp: new Date().toISOString(),
    });
  }
});



// PASS_SCALE3_SUPABASE_BROADCAST_SOURCE_REGISTRY
// SERVER — Supabase Broadcast Source Registry.
// Adds database-backed broadcast source routes for scale.
// Existing JSON registry and Direct Broadcast routes remain untouched in this pass.

const AGV_SUPABASE_BROADCAST_SOURCES_TABLE =
  process.env.AGV_SUPABASE_BROADCAST_SOURCES_TABLE ||
  "agv_broadcast_sources";

let agvSupabaseClientCache = null;

function agvSupabaseBroadcastConfig() {
  const url =
    process.env.AGV_SUPABASE_URL ||
    process.env.SUPABASE_URL ||
    process.env.VITE_SUPABASE_URL ||
    "";

  const key =
    process.env.AGV_SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.AGV_SUPABASE_ANON_KEY ||
    process.env.SUPABASE_ANON_KEY ||
    process.env.VITE_SUPABASE_ANON_KEY ||
    "";

  return {
    url: String(url || "").trim(),
    key: String(key || "").trim(),
    urlConfigured: Boolean(String(url || "").trim()),
    keyConfigured: Boolean(String(key || "").trim()),
    table: AGV_SUPABASE_BROADCAST_SOURCES_TABLE,
  };
}

function agvGetSupabaseBroadcastClient() {
  const config = agvSupabaseBroadcastConfig();

  if (!config.url || !config.key) {
    return null;
  }

  if (agvSupabaseClientCache) {
    return agvSupabaseClientCache;
  }

  const { createClient } = require("@supabase/supabase-js");

  agvSupabaseClientCache = createClient(config.url, config.key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });

  return agvSupabaseClientCache;
}

function agvBroadcastSourceRowToApi(row) {
  if (!row) return null;

  return {
    id: row.id || "",
    roomId: row.room_id || "",
    eventId: row.event_id || "",
    sourceName: row.source_name || "",
    provider: row.provider || "cloudflare",
    sourceType: row.source_type || "direct-rtmps",
    status: row.status || "standby",
    hlsUrl: row.hls_url || "",
    playbackUrl: row.playback_url || "",
    embedUrl: row.embed_url || "",
    rtmpConfigured: Boolean(row.rtmp_configured),
    streamKeyConfigured: Boolean(row.stream_key_configured),
    hasPlaybackUrl: Boolean(row.has_playback_url),
    notes: row.notes || "",
    lastStatusMessage: row.last_status_message || "",
    ownerAccountId: row.owner_account_id || "",
    createdAt: row.created_at || "",
    updatedAt: row.updated_at || "",
  };
}

function agvBroadcastSourceApiToRow(source) {
  const now = new Date().toISOString();

  return {
    room_id: source.roomId || "main-hall",
    event_id: source.eventId || "",
    source_name: source.sourceName || "AGV Broadcast Source",
    provider: source.provider || "cloudflare",
    source_type: source.sourceType || "direct-rtmps",
    status: source.status || "standby",
    hls_url: source.hlsUrl || "",
    playback_url: source.playbackUrl || "",
    embed_url: source.embedUrl || "",
    rtmp_configured: Boolean(source.rtmpConfigured),
    stream_key_configured: Boolean(source.streamKeyConfigured),
    has_playback_url: Boolean(source.hasPlaybackUrl),
    notes: source.notes || "",
    last_status_message: source.lastStatusMessage || "",
    owner_account_id: source.ownerAccountId || "",
    updated_at: now,
  };
}

function agvBuildSupabaseBroadcastSource(roomId, body = {}) {
  const cleanRoomId =
    typeof agvNormalizeBroadcastRoomId === "function"
      ? agvNormalizeBroadcastRoomId(roomId || body.roomId)
      : agvCleanBroadcastText(roomId || body.roomId, "main-hall") || "main-hall";

  const cf = agvCloudflareBroadcastConfig();
  const playback = agvChooseCloudflarePlayback(body || {});

  return {
    roomId: cleanRoomId,
    eventId: agvCleanBroadcastText(body.eventId, "") || "",
    sourceName:
      agvCleanBroadcastText(body.sourceName, "AGV Supabase Broadcast Source") ||
      "AGV Supabase Broadcast Source",
    provider:
      agvCleanBroadcastText(body.provider, "cloudflare") ||
      "cloudflare",
    sourceType:
      agvCleanBroadcastText(body.sourceType, "direct-rtmps") ||
      "direct-rtmps",
    status:
      agvCleanBroadcastText(body.status, "standby") ||
      "standby",
    hlsUrl: playback.hlsUrl || body.hlsUrl || "",
    playbackUrl: playback.playbackUrl || body.playbackUrl || "",
    embedUrl: playback.embedUrl || body.embedUrl || "",
    rtmpConfigured: Boolean(cf.rtmpIngestUrlConfigured),
    streamKeyConfigured: Boolean(cf.streamKeyConfigured),
    hasPlaybackUrl:
      Boolean(cf.hasPlaybackUrl) ||
      Boolean(playback.hlsUrl) ||
      Boolean(playback.playbackUrl) ||
      Boolean(playback.embedUrl),
    notes:
      agvCleanBroadcastText(
        body.notes,
        "Supabase-backed broadcast source for scale-first AGV delivery."
      ) ||
      "Supabase-backed broadcast source for scale-first AGV delivery.",
    lastStatusMessage:
      agvCleanBroadcastText(body.lastStatusMessage || body.message, "") || "",
    ownerAccountId:
      agvCleanBroadcastText(body.ownerAccountId, "") || "",
  };
}

app.get("/api/broadcast/sources-db/health", async (req, res) => {
  try {
    const config = agvSupabaseBroadcastConfig();
    const client = agvGetSupabaseBroadcastClient();

    if (!client) {
      return res.status(500).json({
        ok: false,
        service: "AGV Supabase Broadcast Source Registry",
        pass: "SCALE-3",
        configured: {
          urlConfigured: config.urlConfigured,
          keyConfigured: config.keyConfigured,
          table: config.table,
        },
        error: "Supabase is not configured. Check SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.",
        timestamp: new Date().toISOString(),
      });
    }

    const { count, error } = await client
      .from(config.table)
      .select("id", { count: "exact", head: true });

    if (error) {
      return res.status(500).json({
        ok: false,
        service: "AGV Supabase Broadcast Source Registry",
        pass: "SCALE-3",
        configured: {
          urlConfigured: config.urlConfigured,
          keyConfigured: config.keyConfigured,
          table: config.table,
        },
        error: error.message || String(error),
        timestamp: new Date().toISOString(),
      });
    }

    return res.json({
      ok: true,
      service: "AGV Supabase Broadcast Source Registry",
      pass: "SCALE-3",
      sourceCount: count || 0,
      configured: {
        urlConfigured: config.urlConfigured,
        keyConfigured: config.keyConfigured,
        table: config.table,
      },
      note: "Supabase registry is ready for scale-first broadcast source storage.",
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      service: "AGV Supabase Broadcast Source Registry",
      pass: "SCALE-3",
      error: error?.message || String(error),
      timestamp: new Date().toISOString(),
    });
  }
});

app.get("/api/broadcast/sources-db/list", async (req, res) => {
  try {
    const config = agvSupabaseBroadcastConfig();
    const client = agvGetSupabaseBroadcastClient();

    if (!client) {
      return res.status(500).json({
        ok: false,
        service: "AGV Supabase Broadcast Source Registry",
        pass: "SCALE-3",
        error: "Supabase is not configured.",
        timestamp: new Date().toISOString(),
      });
    }

    const { data, error } = await client
      .from(config.table)
      .select("*")
      .order("updated_at", { ascending: false });

    if (error) {
      return res.status(500).json({
        ok: false,
        service: "AGV Supabase Broadcast Source Registry",
        pass: "SCALE-3",
        error: error.message || String(error),
        timestamp: new Date().toISOString(),
      });
    }

    const sources = (data || []).map(agvBroadcastSourceRowToApi);

    return res.json({
      ok: true,
      service: "AGV Supabase Broadcast Source Registry",
      pass: "SCALE-3",
      sources,
      count: sources.length,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      service: "AGV Supabase Broadcast Source Registry",
      pass: "SCALE-3",
      error: error?.message || String(error),
      timestamp: new Date().toISOString(),
    });
  }
});

app.get("/api/broadcast/sources-db/:roomId", async (req, res) => {
  try {
    const config = agvSupabaseBroadcastConfig();
    const client = agvGetSupabaseBroadcastClient();

    if (!client) {
      return res.status(500).json({
        ok: false,
        service: "AGV Supabase Broadcast Source Registry",
        pass: "SCALE-3",
        error: "Supabase is not configured.",
        timestamp: new Date().toISOString(),
      });
    }

    const roomId =
      typeof agvNormalizeBroadcastRoomId === "function"
        ? agvNormalizeBroadcastRoomId(req.params.roomId)
        : agvCleanBroadcastText(req.params.roomId, "main-hall") || "main-hall";

    const { data, error } = await client
      .from(config.table)
      .select("*")
      .eq("room_id", roomId)
      .maybeSingle();

    if (error) {
      return res.status(500).json({
        ok: false,
        service: "AGV Supabase Broadcast Source Registry",
        pass: "SCALE-3",
        error: error.message || String(error),
        timestamp: new Date().toISOString(),
      });
    }

    return res.json({
      ok: true,
      service: "AGV Supabase Broadcast Source Registry",
      pass: "SCALE-3",
      source: agvBroadcastSourceRowToApi(data),
      exists: Boolean(data),
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      service: "AGV Supabase Broadcast Source Registry",
      pass: "SCALE-3",
      error: error?.message || String(error),
      timestamp: new Date().toISOString(),
    });
  }
});

app.post("/api/broadcast/sources-db/register", async (req, res) => {
  try {
    const config = agvSupabaseBroadcastConfig();
    const client = agvGetSupabaseBroadcastClient();

    if (!client) {
      return res.status(500).json({
        ok: false,
        service: "AGV Supabase Broadcast Source Registry",
        pass: "SCALE-3",
        error: "Supabase is not configured.",
        timestamp: new Date().toISOString(),
      });
    }

    const body = req.body || {};
    const source = agvBuildSupabaseBroadcastSource(body.roomId, body);
    const row = agvBroadcastSourceApiToRow(source);

    const { data, error } = await client
      .from(config.table)
      .upsert(row, { onConflict: "room_id" })
      .select("*")
      .single();

    if (error) {
      return res.status(500).json({
        ok: false,
        service: "AGV Supabase Broadcast Source Registry",
        pass: "SCALE-3",
        error: error.message || String(error),
        timestamp: new Date().toISOString(),
      });
    }

    return res.json({
      ok: true,
      service: "AGV Supabase Broadcast Source Registry",
      pass: "SCALE-3",
      source: agvBroadcastSourceRowToApi(data),
      message: "Supabase broadcast source registered.",
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      service: "AGV Supabase Broadcast Source Registry",
      pass: "SCALE-3",
      error: error?.message || String(error),
      timestamp: new Date().toISOString(),
    });
  }
});

app.post("/api/broadcast/sources-db/status", async (req, res) => {
  try {
    const config = agvSupabaseBroadcastConfig();
    const client = agvGetSupabaseBroadcastClient();

    if (!client) {
      return res.status(500).json({
        ok: false,
        service: "AGV Supabase Broadcast Source Registry",
        pass: "SCALE-3",
        error: "Supabase is not configured.",
        timestamp: new Date().toISOString(),
      });
    }

    const body = req.body || {};
    const roomId =
      typeof agvNormalizeBroadcastRoomId === "function"
        ? agvNormalizeBroadcastRoomId(body.roomId)
        : agvCleanBroadcastText(body.roomId, "main-hall") || "main-hall";

    const allowedStatuses = [
      "standby",
      "ready",
      "live",
      "offline",
      "testing",
      "error",
    ];

    const requestedStatus =
      agvCleanBroadcastText(body.status, "standby") ||
      "standby";

    const status = allowedStatuses.includes(requestedStatus)
      ? requestedStatus
      : "standby";

    const { data, error } = await client
      .from(config.table)
      .update({
        status,
        last_status_message:
          agvCleanBroadcastText(body.message || body.lastStatusMessage, "") || "",
        updated_at: new Date().toISOString(),
      })
      .eq("room_id", roomId)
      .select("*")
      .maybeSingle();

    if (error) {
      return res.status(500).json({
        ok: false,
        service: "AGV Supabase Broadcast Source Registry",
        pass: "SCALE-3",
        error: error.message || String(error),
        timestamp: new Date().toISOString(),
      });
    }

    if (!data) {
      return res.status(404).json({
        ok: false,
        service: "AGV Supabase Broadcast Source Registry",
        pass: "SCALE-3",
        error: "Broadcast source not found for room.",
        roomId,
        timestamp: new Date().toISOString(),
      });
    }

    return res.json({
      ok: true,
      service: "AGV Supabase Broadcast Source Registry",
      pass: "SCALE-3",
      source: agvBroadcastSourceRowToApi(data),
      message: "Supabase broadcast source status updated.",
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      service: "AGV Supabase Broadcast Source Registry",
      pass: "SCALE-3",
      error: error?.message || String(error),
      timestamp: new Date().toISOString(),
    });
  }
});



// PASS_SCALE7_LIVEKIT_TO_CLOUDFLARE_EGRESS_BRIDGE
// SERVER — LiveKit room to Cloudflare RTMPS bridge.
// Adds a controlled bridge route that starts LiveKit Room Composite Egress into Cloudflare.
// This is the source bridge: Host Camera/Screen -> LiveKit -> Cloudflare RTMPS -> AGV Viewer.

function agvBridgeCleanText(value, fallback = "") {
  if (typeof agvCleanBroadcastText === "function") {
    return agvCleanBroadcastText(value, fallback);
  }

  const raw = value == null ? "" : String(value);
  const clean = raw.trim();
  return clean || fallback;
}

function agvBridgeRoomId(value) {
  if (typeof agvNormalizeBroadcastRoomId === "function") {
    return agvNormalizeBroadcastRoomId(value || "main-hall");
  }

  return agvBridgeCleanText(value, "main-hall") || "main-hall";
}

function agvBridgeEgressLayout(value) {
  const clean = agvBridgeCleanText(value, "speaker-dark") || "speaker-dark";
  const allowed = new Set([
    "speaker",
    "speaker-dark",
    "grid",
    "grid-dark",
    "screen-share",
    "screen-share-dark",
  ]);

  return allowed.has(clean) ? clean : "speaker-dark";
}

async function agvBridgeGetSupabaseSource(roomId) {
  try {
    if (
      typeof agvSupabaseBroadcastConfig !== "function" ||
      typeof agvGetSupabaseBroadcastClient !== "function" ||
      typeof agvBroadcastSourceRowToApi !== "function"
    ) {
      return null;
    }

    const dbConfig = agvSupabaseBroadcastConfig();
    const dbClient = agvGetSupabaseBroadcastClient();

    if (!dbClient || !dbConfig?.table) return null;

    const { data, error } = await dbClient
      .from(dbConfig.table)
      .select("*")
      .eq("room_id", roomId)
      .maybeSingle();

    if (error || !data) return null;

    return agvBroadcastSourceRowToApi(data);
  } catch {
    return null;
  }
}

async function agvBridgeUpdateSupabaseSource(roomId, status, message = "") {
  try {
    if (
      typeof agvSupabaseBroadcastConfig !== "function" ||
      typeof agvGetSupabaseBroadcastClient !== "function" ||
      typeof agvBroadcastSourceRowToApi !== "function"
    ) {
      return null;
    }

    const dbConfig = agvSupabaseBroadcastConfig();
    const dbClient = agvGetSupabaseBroadcastClient();

    if (!dbClient || !dbConfig?.table) return null;

    const { data, error } = await dbClient
      .from(dbConfig.table)
      .update({
        status,
        last_status_message: agvBridgeCleanText(message, ""),
        updated_at: new Date().toISOString(),
      })
      .eq("room_id", roomId)
      .select("*")
      .maybeSingle();

    if (error || !data) return null;

    return agvBroadcastSourceRowToApi(data);
  } catch {
    return null;
  }
}

async function agvBridgeCheckLiveKitRoom(config, roomId) {
  try {
    const sdk = require("livekit-server-sdk");
    const RoomServiceClient = sdk.RoomServiceClient;

    if (!RoomServiceClient) {
      return {
        checked: false,
        exists: false,
        note: "RoomServiceClient unavailable in SDK; egress start will be the room existence check.",
      };
    }

    const roomClient = new RoomServiceClient(
      config.livekitUrl,
      process.env.LIVEKIT_API_KEY,
      process.env.LIVEKIT_API_SECRET
    );

    let rooms = [];

    try {
      rooms = await roomClient.listRooms([roomId]);
    } catch {
      rooms = await roomClient.listRooms();
    }

    const list = Array.isArray(rooms) ? rooms : [];
    const found = list.some((room) => {
      const name = room?.name || room?.room?.name || room?.roomName || "";
      return String(name) === String(roomId);
    });

    return {
      checked: true,
      exists: found,
      count: list.length,
      note: found
        ? "LiveKit room exists."
        : "LiveKit room was not found. Host must join/start camera before bridge start.",
    };
  } catch (error) {
    return {
      checked: false,
      exists: false,
      error: error?.message || String(error),
      note: "Room check failed; egress start will still report the final result.",
    };
  }
}

async function agvBridgeStartRoomCompositeEgress(egressClient, roomId, output, layout) {
  const attempts = [
    async () => egressClient.startRoomCompositeEgress(roomId, output, { layout }),
    async () => egressClient.startRoomCompositeEgress(roomId, output, layout),
    async () => egressClient.startRoomCompositeEgress(roomId, output),
  ];

  let lastError = null;

  for (const attempt of attempts) {
    try {
      return await attempt();
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error("LiveKit Room Composite Egress could not start.");
}

app.get("/api/broadcast/bridge/health", async (req, res) => {
  try {
    const state = agvReadBroadcastState();
    const config = agvLiveKitEgressConfig();
    const cf = agvCloudflareBroadcastConfig();

    return res.json({
      ok: true,
      service: "AGV LiveKit to Cloudflare Egress Bridge",
      pass: "SCALE-7",
      bridgeReady:
        Boolean(config.livekitConfigured) &&
        Boolean(cf.rtmpIngestUrlConfigured) &&
        Boolean(cf.streamKeyConfigured),
      broadcastStatus: state.status || "off",
      viewerMode: state.viewerMode || "livekit",
      roomId: state.roomId || "main-hall",
      egressId: state.egressId || "",
      egressStatus: state.egressStatus || "",
      egressLayoutMode: state.egressLayoutMode || "",
      egressLayout: state.egressLayout || "",
      sourceRegistryType: state.sourceRegistryType || "",
      supabaseSourceUsed: Boolean(state.supabaseSourceUsed),
      config: {
        livekitConfigured: Boolean(config.livekitConfigured),
        cloudflareRtmpConfigured: Boolean(cf.rtmpIngestUrlConfigured),
        cloudflareStreamKeyConfigured: Boolean(cf.streamKeyConfigured),
        cloudflarePlaybackConfigured: Boolean(cf.hasPlaybackUrl),
      },
      note:
        "Bridge expects the host to already be live in the LiveKit room before starting egress.",
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      service: "AGV LiveKit to Cloudflare Egress Bridge",
      pass: "SCALE-7",
      error: error?.message || String(error),
      timestamp: new Date().toISOString(),
    });
  }
});



// PASS_SCALE7C_BRIDGE_PREFLIGHT_ROOM_TRACK_CHECK
// SERVER — Verify the LiveKit room has an active video source before starting egress.
// Prevents bridge attempts that fail with "End reason: Source closed."

function agvBridgeTrackKindText(track) {
  const raw =
    track?.type ||
    track?.kind ||
    track?.source ||
    track?.trackType ||
    track?.track_type ||
    "";

  return String(raw || "").toLowerCase();
}

function agvBridgeTrackLooksVideo(track) {
  const text = agvBridgeTrackKindText(track);

  return (
    text.includes("video") ||
    text.includes("camera") ||
    text.includes("screen") ||
    Number(track?.type) === 1 ||
    Number(track?.source) === 1 ||
    Number(track?.source) === 3
  );
}

function agvBridgeTrackIsMuted(track) {
  return Boolean(
    track?.muted === true ||
    track?.isMuted === true ||
    track?.disabled === true
  );
}

function agvBridgeParticipantName(participant) {
  return (
    participant?.identity ||
    participant?.name ||
    participant?.sid ||
    participant?.participantIdentity ||
    "unknown"
  );
}

function agvBridgeNormalizeParticipants(result) {
  if (!result) return [];

  if (Array.isArray(result)) return result;

  if (Array.isArray(result.participants)) return result.participants;
  if (Array.isArray(result.items)) return result.items;
  if (Array.isArray(result.results)) return result.results;

  return [result];
}

async function agvBridgePreflightRoomTracks(config, roomId) {
  try {
    const sdk = require("livekit-server-sdk");
    const RoomServiceClient = sdk.RoomServiceClient;

    if (!RoomServiceClient) {
      return {
        ok: false,
        checked: false,
        roomReady: false,
        error: "RoomServiceClient unavailable in LiveKit SDK.",
        roomId,
        participantCount: 0,
        videoTrackCount: 0,
        activeVideoTrackCount: 0,
        note: "Could not verify LiveKit room tracks before starting bridge.",
      };
    }

    const roomClient = new RoomServiceClient(
      config.livekitUrl,
      process.env.LIVEKIT_API_KEY,
      process.env.LIVEKIT_API_SECRET
    );

    let participantsRaw = [];

    try {
      participantsRaw = await roomClient.listParticipants(roomId);
    } catch (error) {
      return {
        ok: false,
        checked: true,
        roomReady: false,
        error: error?.message || String(error),
        roomId,
        participantCount: 0,
        videoTrackCount: 0,
        activeVideoTrackCount: 0,
        note: "Could not list LiveKit participants. Host may not be fully connected.",
      };
    }

    const participants = agvBridgeNormalizeParticipants(participantsRaw);

    const participantSummaries = participants.map((participant) => {
      const tracks = Array.isArray(participant?.tracks)
        ? participant.tracks
        : Array.isArray(participant?.trackPublications)
          ? participant.trackPublications
          : [];

      const videoTracks = tracks.filter(agvBridgeTrackLooksVideo);
      const activeVideoTracks = videoTracks.filter(
        (track) => !agvBridgeTrackIsMuted(track)
      );

      return {
        identity: agvBridgeParticipantName(participant),
        trackCount: tracks.length,
        videoTrackCount: videoTracks.length,
        activeVideoTrackCount: activeVideoTracks.length,
        tracks: tracks.map((track) => ({
          sid: track?.sid || track?.trackSid || "",
          name: track?.name || "",
          kind: track?.kind || track?.type || "",
          source: track?.source || "",
          muted: Boolean(track?.muted),
        })),
      };
    });

    const participantCount = participants.length;
    const videoTrackCount = participantSummaries.reduce(
      (sum, item) => sum + item.videoTrackCount,
      0
    );
    const activeVideoTrackCount = participantSummaries.reduce(
      (sum, item) => sum + item.activeVideoTrackCount,
      0
    );

    const roomReady = participantCount > 0 && activeVideoTrackCount > 0;

    return {
      ok: roomReady,
      checked: true,
      roomReady,
      roomId,
      participantCount,
      videoTrackCount,
      activeVideoTrackCount,
      participants: participantSummaries,
      note: roomReady
        ? "LiveKit room has at least one active video track and is ready for bridge egress."
        : "LiveKit room is not ready. Start Host Camera, confirm a viewer can see video, then wait 5 seconds before starting bridge.",
    };
  } catch (error) {
    return {
      ok: false,
      checked: false,
      roomReady: false,
      error: error?.message || String(error),
      roomId,
      participantCount: 0,
      videoTrackCount: 0,
      activeVideoTrackCount: 0,
      note: "Bridge preflight failed before egress start.",
    };
  }
}

app.post("/api/broadcast/bridge/start", async (req, res) => {
  try {
    const body = req.body || {};
    const roomId = agvBridgeRoomId(body.roomId || "main-hall");
    const title =
      agvBridgeCleanText(body.title, "AGV LiveKit to Cloudflare Broadcast") ||
      "AGV LiveKit to Cloudflare Broadcast";
    const message =
      agvBridgeCleanText(
        body.message,
        "AGV is bridging the LiveKit room to Cloudflare."
      ) || "AGV is bridging the LiveKit room to Cloudflare.";
    const layout = agvBridgeEgressLayout(body.layout || "speaker-dark");

    const config = agvLiveKitEgressConfig();
    const cf = agvCloudflareBroadcastConfig();

    if (!config.livekitConfigured) {
      return res.status(500).json({
        ok: false,
        service: "AGV LiveKit to Cloudflare Bridge Start",
        pass: "SCALE-7",
        error:
          "LiveKit egress is not configured. Check LIVEKIT_URL, LIVEKIT_API_KEY, and LIVEKIT_API_SECRET.",
        roomId,
      });
    }

    if (!cf.rtmpIngestUrlConfigured || !cf.streamKeyConfigured) {
      return res.status(500).json({
        ok: false,
        service: "AGV LiveKit to Cloudflare Bridge Start",
        pass: "SCALE-7",
        error:
          "Cloudflare RTMPS is not configured. Check AGV_CLOUDFLARE_RTMP_INGEST_URL and AGV_CLOUDFLARE_STREAM_KEY.",
        roomId,
      });
    }

    const roomCheck = await agvBridgeCheckLiveKitRoom(config, roomId);

    if (roomCheck.checked && !roomCheck.exists && !body.force) {
      return res.status(409).json({
        ok: false,
        service: "AGV LiveKit to Cloudflare Bridge Start",
        pass: "SCALE-7C",
        error:
          "LiveKit room does not exist yet. Start Host Camera first, then start the bridge.",
        roomId,
        roomCheck,
      });
    }

    const trackPreflight = await agvBridgePreflightRoomTracks(config, roomId);

    if (!trackPreflight.roomReady && !body.force) {
      return res.status(409).json({
        ok: false,
        service: "AGV LiveKit to Cloudflare Bridge Start",
        pass: "SCALE-7C",
        error:
          "LiveKit room is not ready for bridge egress. Start Host Camera, confirm video is visible in LiveKit viewer mode, wait 5 seconds, then start bridge.",
        roomId,
        roomCheck,
        trackPreflight,
      });
    }

    const streamUrl = agvCloudflareRtmpStreamUrl();

    if (!streamUrl) {
      return res.status(500).json({
        ok: false,
        service: "AGV LiveKit to Cloudflare Bridge Start",
        pass: "SCALE-7",
        error: "Could not build Cloudflare RTMPS stream URL.",
        roomId,
      });
    }

    const {
      EgressClient,
      StreamOutput,
      StreamProtocol,
    } = require("livekit-server-sdk");

    const egressClient = new EgressClient(
      config.livekitUrl,
      process.env.LIVEKIT_API_KEY,
      process.env.LIVEKIT_API_SECRET
    );

    let output;

    try {
      output = new StreamOutput({
        protocol: StreamProtocol.RTMP,
        urls: [streamUrl],
      });
    } catch {
      output = {
        protocol: StreamProtocol.RTMP,
        urls: [streamUrl],
      };
    }

    const selectedTracks = agvExchangeSelectHostTracks(trackPreflight);
    const selectedScreenShare = agvExchangeSelectScreenShareTrack(trackPreflight);
    const useScreenShareLayout = Boolean(selectedScreenShare.screenShareDetected);

    if (!useScreenShareLayout && !selectedTracks.videoTrackId && !body.force) {
      return res.status(409).json({
        ok: false,
        service: "AGV Cloudflare Exchange Start",
        pass: "SCALE-12",
        error:
          "No active host video track ID was found. Start Host Camera, confirm the viewer can see video in LiveKit mode, wait 5 seconds, then go live again.",
        roomId,
        trackPreflight,
        selectedTracks,
        selectedScreenShare,
      });
    }

    let info;
    let selectedExchangeMode = "host-track";
    let selectedLayoutMode = "host-track-composite";
    let selectedLayoutName = "host-track";

    if (useScreenShareLayout) {
      selectedExchangeMode = "screen-share-layout";
      selectedLayoutMode = "room-composite-screen-share";
      selectedLayoutName = "screen-share";

      info = await agvBridgeStartRoomCompositeEgress(
        egressClient,
        roomId,
        output,
        "screen-share"
      );
    } else {
      info = await agvExchangeStartHostTrackEgress(
        egressClient,
        roomId,
        output,
        selectedTracks
      );
    }

    const safeInfo = agvSafeEgressSummary(info);
    const egressId =
      safeInfo?.egressId ||
      info?.egressId ||
      info?.egress_id ||
      info?.id ||
      "";

    const playback = agvChooseCloudflarePlayback(body);
    const source = await agvBridgeUpdateSupabaseSource(roomId, "live", message);

    const next = agvWriteBroadcastState({
      provider: "cloudflare-bridge",
      status: "live",
      isLive: true,
      viewerMode: "broadcast",
      roomId,
      eventId: source?.eventId || body.eventId || "",
      title,
      sourceName: source?.sourceName || "AGV LiveKit Bridge Source",
      sourceType: useScreenShareLayout ? "livekit-screen-share-layout-rtmps" : "livekit-host-track-rtmps",
      playbackUrl: playback.playbackUrl || source?.playbackUrl || "",
      embedUrl: playback.embedUrl || source?.embedUrl || "",
      hlsUrl: playback.hlsUrl || source?.hlsUrl || "",
      message,
      directMode: false,
      bridgeMode: true,
      sourceRegistryConnected: Boolean(source),
      sourceRegistryType: source ? "supabase" : "",
      supabaseSourceUsed: Boolean(source),
      supabaseSourceUpdated: Boolean(source),
      egressId,
      egressStatus: safeInfo?.status || "started",
      egressError: "",
      egressLayoutMode: "room-composite",
      egressLayout: layout,
      egressStartedAt: new Date().toISOString(),
      egressUpdatedAt: new Date().toISOString(),
      rtmpIngestUrlConfigured: true,
      streamKeyConfigured: true,
    });

    return res.json({
      ok: true,
      service: "AGV LiveKit to Cloudflare Bridge Start",
      pass: "SCALE-7C",
      state: next,
      source,
      egress: safeInfo,
      roomCheck,
      trackPreflight,
      note:
        "LiveKit Room Composite Egress started and is sending the room feed to Cloudflare RTMPS.",
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    const message = error?.message || String(error);

    const next = agvWriteBroadcastState({
      status: "off",
      isLive: false,
      viewerMode: "livekit",
      bridgeMode: false,
      egressId: "",
      egressStatus: "bridge-start-error",
      egressError: message,
      egressUpdatedAt: new Date().toISOString(),
      message:
        "LiveKit to Cloudflare bridge failed. AGV returned viewers to LiveKit mode.",
    });

    return res.status(500).json({
      ok: false,
      service: "AGV LiveKit to Cloudflare Bridge Start",
      pass: "SCALE-7C",
      rollback: true,
      state: next,
      error: message,
      timestamp: new Date().toISOString(),
    });
  }
});

app.post("/api/broadcast/bridge/stop", async (req, res) => {
  try {
    const body = req.body || {};
    const current = agvReadBroadcastState();
    const roomId = agvBridgeRoomId(body.roomId || current.roomId || "main-hall");
    const egressId =
      agvBridgeCleanText(body.egressId, "") ||
      agvBridgeCleanText(current.egressId, "");

    const config = agvLiveKitEgressConfig();
    let stopError = "";
    let stopped = false;

    if (egressId && config.livekitConfigured) {
      try {
        const { EgressClient } = require("livekit-server-sdk");
        const egressClient = new EgressClient(
          config.livekitUrl,
          process.env.LIVEKIT_API_KEY,
          process.env.LIVEKIT_API_SECRET
        );

        await egressClient.stopEgress(egressId);
        stopped = true;
      } catch (error) {
        stopError = error?.message || String(error);
      }
    }

    const stopMessage =
      agvBridgeCleanText(
        body.message,
        "LiveKit to Cloudflare bridge stopped."
      ) || "LiveKit to Cloudflare bridge stopped.";

    const source = await agvBridgeUpdateSupabaseSource(
      roomId,
      "standby",
      stopMessage
    );

    const next = agvWriteBroadcastState({
      provider: current.provider || "cloudflare-bridge",
      status: "off",
      isLive: false,
      viewerMode: "livekit",
      roomId,
      directMode: false,
      bridgeMode: false,
      sourceRegistryConnected: Boolean(source),
      sourceRegistryType: source ? "supabase" : "",
      supabaseSourceUsed: Boolean(source),
      supabaseSourceUpdated: Boolean(source),
      egressId: "",
      lastEgressId: egressId || current.lastEgressId || "",
      egressStatus: stopError ? "bridge-stop-warning" : stopped ? "stopped" : "not-used",
      egressError: stopError,
      egressLayoutMode: "host-track-composite",
      egressUpdatedAt: new Date().toISOString(),
      message: stopMessage,
    });

    return res.json({
      ok: true,
      service: "AGV LiveKit to Cloudflare Bridge Stop",
      pass: "SCALE-7",
      state: next,
      source,
      stopped,
      stopError,
      note: stopError
        ? "AGV returned viewers to LiveKit, but LiveKit egress stop reported a warning."
        : "AGV stopped the LiveKit to Cloudflare bridge and returned viewers to LiveKit.",
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      service: "AGV LiveKit to Cloudflare Bridge Stop",
      pass: "SCALE-7",
      error: error?.message || String(error),
      timestamp: new Date().toISOString(),
    });
  }
});



// PASS_SCALE7B_BRIDGE_EGRESS_STATUS_TRACKER
// SERVER — Bridge Egress Status Tracker.
// Adds routes to inspect LiveKit egress state after bridge start.

function agvBridgeStatusCleanText(value, fallback = "") {
  if (typeof agvBridgeCleanText === "function") {
    return agvBridgeCleanText(value, fallback);
  }

  if (typeof agvCleanBroadcastText === "function") {
    return agvCleanBroadcastText(value, fallback);
  }

  const raw = value == null ? "" : String(value);
  const clean = raw.trim();
  return clean || fallback;
}

function agvBridgeGetEgressClient() {
  const config = agvLiveKitEgressConfig();

  if (!config.livekitConfigured) {
    return {
      client: null,
      config,
      error:
        "LiveKit egress is not configured. Check LIVEKIT_URL, LIVEKIT_API_KEY, and LIVEKIT_API_SECRET.",
    };
  }

  const { EgressClient } = require("livekit-server-sdk");

  return {
    client: new EgressClient(
      config.livekitUrl,
      process.env.LIVEKIT_API_KEY,
      process.env.LIVEKIT_API_SECRET
    ),
    config,
    error: "",
  };
}

function agvBridgeNormalizeEgressList(result) {
  if (!result) return [];

  if (Array.isArray(result)) return result;

  if (Array.isArray(result.items)) return result.items;
  if (Array.isArray(result.egress)) return result.egress;
  if (Array.isArray(result.egresses)) return result.egresses;
  if (Array.isArray(result.results)) return result.results;

  return [result];
}

function agvBridgeEgressIdFromInfo(info) {
  return (
    info?.egressId ||
    info?.egress_id ||
    info?.id ||
    info?.egress?.egressId ||
    info?.egress?.egress_id ||
    ""
  );
}

function agvBridgeEgressStatusFromInfo(info) {
  const raw =
    info?.status ||
    info?.egressStatus ||
    info?.state ||
    info?.egress?.status ||
    "";

  if (typeof raw === "number") return String(raw);
  return String(raw || "");
}

function agvBridgeEgressErrorFromInfo(info) {
  return (
    info?.error ||
    info?.errorMessage ||
    info?.failureReason ||
    info?.details ||
    info?.egress?.error ||
    ""
  );
}

function agvBridgeEgressToApi(info) {
  if (!info) return null;

  const safe =
    typeof agvSafeEgressSummary === "function"
      ? agvSafeEgressSummary(info)
      : {};

  return {
    egressId:
      safe?.egressId ||
      agvBridgeEgressIdFromInfo(info),
    roomName:
      safe?.roomName ||
      info?.roomName ||
      info?.room_name ||
      info?.room?.name ||
      "",
    status:
      safe?.status ||
      agvBridgeEgressStatusFromInfo(info),
    error:
      agvBridgeEgressErrorFromInfo(info),
    startedAt:
      safe?.startedAt ||
      info?.startedAt ||
      info?.started_at ||
      "",
    updatedAt:
      safe?.updatedAt ||
      info?.updatedAt ||
      info?.updated_at ||
      "",
    rawType: info?.constructor?.name || typeof info,
  };
}

async function agvBridgeListEgressById(egressId) {
  const cleanEgressId = agvBridgeStatusCleanText(egressId, "");

  if (!cleanEgressId) {
    return {
      ok: false,
      error: "Missing egressId.",
      list: [],
    };
  }

  const { client, config, error } = agvBridgeGetEgressClient();

  if (!client) {
    return {
      ok: false,
      error,
      config,
      list: [],
    };
  }

  const attempts = [
    async () => client.listEgress({ egressId: cleanEgressId }),
    async () => client.listEgress({ egress_id: cleanEgressId }),
    async () => client.listEgress(cleanEgressId),
    async () => client.listEgress(),
  ];

  let lastError = "";

  for (const attempt of attempts) {
    try {
      const result = await attempt();
      const list = agvBridgeNormalizeEgressList(result);
      const filtered = list.filter((item) => {
        const id = agvBridgeEgressIdFromInfo(item);
        return String(id) === String(cleanEgressId);
      });

      if (filtered.length) {
        return {
          ok: true,
          error: "",
          config,
          list: filtered,
          allCount: list.length,
        };
      }

      if (list.length && attempt === attempts[3]) {
        return {
          ok: true,
          error: "",
          config,
          list: [],
          allCount: list.length,
          note: "Egress ID was not found in current LiveKit egress list.",
        };
      }
    } catch (err) {
      lastError = err?.message || String(err);
    }
  }

  return {
    ok: false,
    error: lastError || "Could not list LiveKit egress status.",
    config,
    list: [],
  };
}

app.get("/api/broadcast/bridge/egress/current", async (req, res) => {
  try {
    const state = agvReadBroadcastState();
    const egressId =
      agvBridgeStatusCleanText(state.egressId, "") ||
      agvBridgeStatusCleanText(state.lastEgressId, "");

    if (!egressId) {
      return res.json({
        ok: true,
        service: "AGV Bridge Egress Status Tracker",
        pass: "SCALE-7B",
        found: false,
        egressId: "",
        state: {
          broadcastStatus: state.status || "off",
          viewerMode: state.viewerMode || "livekit",
          egressStatus: state.egressStatus || "",
          egressError: state.egressError || "",
          lastEgressId: state.lastEgressId || "",
        },
        note: "No active or last egressId is currently stored in AGV state.",
        timestamp: new Date().toISOString(),
      });
    }

    const result = await agvBridgeListEgressById(egressId);
    const egress = result.list?.[0] ? agvBridgeEgressToApi(result.list[0]) : null;

    return res.json({
      ok: Boolean(result.ok),
      service: "AGV Bridge Egress Status Tracker",
      pass: "SCALE-7B",
      found: Boolean(egress),
      egressId,
      egress,
      allCount: result.allCount || 0,
      error: result.error || "",
      note:
        result.note ||
        (egress
          ? "Current/last bridge egress status found."
          : "Current/last bridge egress was not found in LiveKit list."),
      state: {
        broadcastStatus: state.status || "off",
        viewerMode: state.viewerMode || "livekit",
        egressStatus: state.egressStatus || "",
        egressError: state.egressError || "",
        lastEgressId: state.lastEgressId || "",
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      service: "AGV Bridge Egress Status Tracker",
      pass: "SCALE-7B",
      error: error?.message || String(error),
      timestamp: new Date().toISOString(),
    });
  }
});

app.get("/api/broadcast/bridge/egress/:egressId", async (req, res) => {
  try {
    const egressId = agvBridgeStatusCleanText(req.params.egressId, "");

    if (!egressId) {
      return res.status(400).json({
        ok: false,
        service: "AGV Bridge Egress Status Tracker",
        pass: "SCALE-7B",
        error: "Missing egressId.",
        timestamp: new Date().toISOString(),
      });
    }

    const result = await agvBridgeListEgressById(egressId);
    const egress = result.list?.[0] ? agvBridgeEgressToApi(result.list[0]) : null;

    return res.json({
      ok: Boolean(result.ok),
      service: "AGV Bridge Egress Status Tracker",
      pass: "SCALE-7B",
      found: Boolean(egress),
      egressId,
      egress,
      allCount: result.allCount || 0,
      error: result.error || "",
      note:
        result.note ||
        (egress
          ? "Bridge egress status found."
          : "Bridge egress was not found in LiveKit list."),
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      service: "AGV Bridge Egress Status Tracker",
      pass: "SCALE-7B",
      error: error?.message || String(error),
      timestamp: new Date().toISOString(),
    });
  }
});



// PASS_SCALE8B_CLOUDFLARE_PLAYBACK_URL_VERIFY
// SERVER — Verify Cloudflare playback URLs before relying on broadcast viewer mode.

function agvPlaybackVerifyCleanText(value, fallback = "") {
  const raw = value == null ? "" : String(value);
  const clean = raw.trim();
  return clean || fallback;
}

function agvPlaybackVerifyRoomId(value) {
  if (typeof agvNormalizeBroadcastRoomId === "function") {
    return agvNormalizeBroadcastRoomId(value || "main-hall");
  }

  return agvPlaybackVerifyCleanText(value, "main-hall") || "main-hall";
}

function agvPlaybackVerifyCloudflareEmbedFromHls(url) {
  const raw = agvPlaybackVerifyCleanText(url, "");

  if (!raw) return "";

  try {
    const parsed = new URL(raw);
    const parts = parsed.pathname.split("/").filter(Boolean);

    if (
      parsed.hostname.includes("cloudflarestream.com") &&
      parts.length >= 3 &&
      parts[1] === "manifest" &&
      parts[2] === "video.m3u8"
    ) {
      return parsed.origin + "/" + parts[0] + "/iframe";
    }
  } catch {}

  return "";
}

async function agvPlaybackVerifyFetch(url, method = "HEAD") {
  const raw = agvPlaybackVerifyCleanText(url, "");

  if (!raw) {
    return {
      ok: false,
      checked: false,
      url: "",
      method,
      status: 0,
      statusText: "",
      error: "Missing URL.",
    };
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);

    let response;
    try {
      response = await fetch(raw, {
        method,
        redirect: "follow",
        signal: controller.signal,
      });
    } catch (error) {
      if (method === "HEAD") {
        clearTimeout(timer);
        return agvPlaybackVerifyFetch(raw, "GET");
      }

      throw error;
    }

    clearTimeout(timer);

    return {
      ok: Boolean(response.ok),
      checked: true,
      url: raw,
      method,
      status: response.status,
      statusText: response.statusText || "",
      contentType: response.headers.get("content-type") || "",
    };
  } catch (error) {
    return {
      ok: false,
      checked: true,
      url: raw,
      method,
      status: 0,
      statusText: "",
      error: error?.message || String(error),
    };
  }
}

async function agvPlaybackVerifyGetSource(roomId) {
  try {
    if (typeof agvBridgeGetSupabaseSource === "function") {
      const source = await agvBridgeGetSupabaseSource(roomId);
      if (source) return source;
    }
  } catch {}

  try {
    if (typeof agvReadBroadcastSources === "function") {
      const list = agvReadBroadcastSources();
      const found = Array.isArray(list)
        ? list.find((item) => String(item.roomId || "") === String(roomId))
        : null;
      if (found) return found;
    }
  } catch {}

  return null;
}

async function agvPlaybackVerifyBuildReport(roomIdInput) {
  const roomId = agvPlaybackVerifyRoomId(roomIdInput || "main-hall");
  const state = agvReadBroadcastState();
  const cf = agvCloudflareBroadcastConfig();
  const source = await agvPlaybackVerifyGetSource(roomId);

  const stateHls = agvPlaybackVerifyCleanText(state.hlsUrl, "");
  const sourceHls = agvPlaybackVerifyCleanText(source?.hlsUrl, "");
  const cfHls = agvPlaybackVerifyCleanText(cf.hlsUrl, "");

  const hlsUrl = stateHls || sourceHls || cfHls;
  const embedUrl =
    agvPlaybackVerifyCleanText(state.embedUrl, "") ||
    agvPlaybackVerifyCleanText(source?.embedUrl, "") ||
    agvPlaybackVerifyCleanText(cf.embedUrl, "") ||
    agvPlaybackVerifyCloudflareEmbedFromHls(hlsUrl);

  const playbackUrl =
    agvPlaybackVerifyCleanText(state.playbackUrl, "") ||
    agvPlaybackVerifyCleanText(source?.playbackUrl, "") ||
    embedUrl ||
    hlsUrl;

  const hlsCheck = await agvPlaybackVerifyFetch(hlsUrl, "HEAD");
  const embedCheck = embedUrl
    ? await agvPlaybackVerifyFetch(embedUrl, "HEAD")
    : {
        ok: false,
        checked: false,
        url: "",
        method: "HEAD",
        status: 0,
        statusText: "",
        error: "No embed URL available.",
      };

  const playbackReady = Boolean(hlsCheck.ok || embedCheck.ok);

  return {
    ok: true,
    service: "AGV Cloudflare Playback URL Verification",
    pass: "SCALE-8B-A",
    roomId,
    playbackReady,
    viewerMode: state.viewerMode || "livekit",
    broadcastStatus: state.status || "off",
    bridgeMode: Boolean(state.bridgeMode),
    directMode: Boolean(state.directMode),
    sourceStatus: source?.status || "",
    provider: state.provider || source?.provider || "",
    urls: {
      hlsUrl,
      embedUrl,
      playbackUrl,
      hlsConfigured: Boolean(hlsUrl),
      embedConfigured: Boolean(embedUrl),
      playbackConfigured: Boolean(playbackUrl),
    },
    checks: {
      hls: hlsCheck,
      embed: embedCheck,
    },
    source: source
      ? {
          roomId: source.roomId || "",
          sourceName: source.sourceName || "",
          sourceType: source.sourceType || "",
          status: source.status || "",
          hasPlaybackUrl: Boolean(source.hasPlaybackUrl || source.hlsUrl || source.embedUrl || source.playbackUrl),
        }
      : null,
    note: playbackReady
      ? "Cloudflare playback URL responded. Viewer can attempt broadcast playback."
      : "Cloudflare playback URL is not responding yet. Keep viewer in waiting screen or LiveKit mode.",
    timestamp: new Date().toISOString(),
  };
}

app.get("/api/broadcast/playback/verify", async (req, res) => {
  try {
    const report = await agvPlaybackVerifyBuildReport(req.query?.roomId || "main-hall");
    return res.json(report);
  } catch (error) {
    return res.status(500).json({
      ok: false,
      service: "AGV Cloudflare Playback URL Verification",
      pass: "SCALE-8B-A",
      error: error?.message || String(error),
      timestamp: new Date().toISOString(),
    });
  }
});

app.post("/api/broadcast/playback/verify", async (req, res) => {
  try {
    const report = await agvPlaybackVerifyBuildReport(req.body?.roomId || "main-hall");
    return res.json(report);
  } catch (error) {
    return res.status(500).json({
      ok: false,
      service: "AGV Cloudflare Playback URL Verification",
      pass: "SCALE-8B-A",
      error: error?.message || String(error),
      timestamp: new Date().toISOString(),
    });
  }
});



// PASS_SCALE8D_CLOUDFLARE_LIVE_INPUT_PLAYBACK_DEBUG
// SERVER — Debug Cloudflare playback chain without claiming video frames are visible.
// This separates: URL ready, source live, egress active, viewer broadcast, and actual browser video visibility.

function agvPlaybackDebugCleanText(value, fallback = "") {
  const raw = value == null ? "" : String(value);
  const clean = raw.trim();
  return clean || fallback;
}

function agvPlaybackDebugBool(value) {
  return Boolean(value === true || value === "true" || value === 1 || value === "1");
}

async function agvPlaybackDebugGetCurrentEgress() {
  try {
    const state = agvReadBroadcastState();
    const egressId =
      agvPlaybackDebugCleanText(state.egressId, "") ||
      agvPlaybackDebugCleanText(state.lastEgressId, "");

    if (!egressId) {
      return {
        checked: true,
        found: false,
        egressId: "",
        status: "",
        error: "",
        note: "No current egressId is stored.",
      };
    }

    if (typeof agvBridgeListEgressById !== "function") {
      return {
        checked: false,
        found: false,
        egressId,
        status: "",
        error: "agvBridgeListEgressById is unavailable.",
        note: "SCALE-7B egress tracker helper was not available.",
      };
    }

    const result = await agvBridgeListEgressById(egressId);
    const info = result?.list?.[0] || null;
    const api =
      info && typeof agvBridgeEgressToApi === "function"
        ? agvBridgeEgressToApi(info)
        : null;

    return {
      checked: true,
      found: Boolean(api),
      egressId,
      status: api?.status || "",
      error: api?.error || result?.error || "",
      roomName: api?.roomName || "",
      startedAt: api?.startedAt || "",
      updatedAt: api?.updatedAt || "",
      rawType: api?.rawType || "",
      allCount: result?.allCount || 0,
      note: api
        ? "Current bridge egress was found."
        : result?.note || "Current bridge egress was not found.",
    };
  } catch (error) {
    return {
      checked: false,
      found: false,
      egressId: "",
      status: "",
      error: error?.message || String(error),
      note: "Could not inspect current bridge egress.",
    };
  }
}

function agvPlaybackDebugInterpret(report, egress) {
  const viewerBroadcast = report.viewerMode === "broadcast";
  const sourceLive = report.sourceStatus === "live";
  const broadcastLive = report.broadcastStatus === "live";
  const urlReady = Boolean(report.playbackReady);
  const egressFound = Boolean(egress?.found);
  const egressError = agvPlaybackDebugCleanText(egress?.error, "");
  const egressStatusText = String(egress?.status || "");
  const egressActive =
    egressFound &&
    !egressError &&
    egressStatusText !== "3" &&
    !egressStatusText.toLowerCase().includes("complete") &&
    !egressStatusText.toLowerCase().includes("failed") &&
    !egressStatusText.toLowerCase().includes("ended");

  const chainReady = Boolean(urlReady && viewerBroadcast && sourceLive && broadcastLive);
  const bridgeLikelyActive = Boolean(chainReady && egressActive);

  const blockers = [];

  if (!urlReady) blockers.push("Cloudflare playback URL did not verify as ready.");
  if (!sourceLive) blockers.push("Supabase source is not live.");
  if (!viewerBroadcast) blockers.push("AGV viewer mode is not broadcast.");
  if (!broadcastLive) blockers.push("AGV broadcast state is not live.");
  if (!egressFound && viewerBroadcast) blockers.push("No current LiveKit egress was found.");
  if (egressError) blockers.push("LiveKit egress error: " + egressError);

  return {
    urlReady,
    sourceLive,
    viewerBroadcast,
    broadcastLive,
    egressFound,
    egressActive,
    chainReady,
    bridgeLikelyActive,
    browserVideoConfirmed: false,
    browserVideoConfirmedNote:
      "Server can verify URL, source, state, and egress. Only the browser/player can confirm visible video frames.",
    blockers,
    recommendation:
      blockers.length === 0
        ? "Server-side chain looks ready. If viewer is blank, inspect Cloudflare dashboard preview or browser player events."
        : "Fix the listed blockers before expecting visible Cloudflare playback.",
  };
}

app.get("/api/broadcast/playback/debug", async (req, res) => {
  try {
    const roomId = req.query?.roomId || "main-hall";
    const report = await agvPlaybackVerifyBuildReport(roomId);
    const egress = await agvPlaybackDebugGetCurrentEgress();
    const interpretation = agvPlaybackDebugInterpret(report, egress);
    const state = agvReadBroadcastState();

    return res.json({
      ok: true,
      service: "AGV Cloudflare Live Input Playback Debug",
      pass: "SCALE-8D-A",
      roomId: report.roomId || roomId,
      summary: {
        playbackReady: Boolean(report.playbackReady),
        player: report.urls?.embedConfigured ? "Cloudflare iframe" : "HLS fallback",
        viewerMode: report.viewerMode || "",
        broadcastStatus: report.broadcastStatus || "",
        sourceStatus: report.sourceStatus || "",
        bridgeMode: Boolean(report.bridgeMode),
        directMode: Boolean(report.directMode),
        egressFound: Boolean(egress.found),
        egressActive: Boolean(interpretation.egressActive),
        serverChainReady: Boolean(interpretation.chainReady),
        browserVideoConfirmed: false,
      },
      interpretation,
      urls: report.urls || {},
      checks: report.checks || {},
      egress,
      state: {
        provider: state.provider || "",
        roomId: state.roomId || "",
        title: state.title || "",
        egressId: state.egressId || "",
        lastEgressId: state.lastEgressId || "",
        egressStatus: state.egressStatus || "",
        egressError: state.egressError || "",
        egressLayoutMode: state.egressLayoutMode || "",
        egressLayout: state.egressLayout || "",
        message: state.message || "",
        updatedAt: state.updatedAt || "",
      },
      source: report.source || null,
      note:
        "URL ready does not guarantee video frames are visible. Browser/player events or Cloudflare dashboard preview are required to confirm visible video.",
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      service: "AGV Cloudflare Live Input Playback Debug",
      pass: "SCALE-8D-A",
      error: error?.message || String(error),
      timestamp: new Date().toISOString(),
    });
  }
});



// PASS_SCALE10A_AGV_CLOUDFLARE_EXCHANGE_ROUTES
// SERVER — One-button AGV Cloudflare Exchange Mode.
// Product flow: Host Camera -> LiveKit -> Cloudflare RTMPS -> AGV Viewer.
// These routes combine the earlier bridge, preflight, source registry, playback verify, and egress status pieces.

function agvExchangeCleanText(value, fallback = "") {
  if (typeof agvBridgeCleanText === "function") {
    return agvBridgeCleanText(value, fallback);
  }

  const raw = value == null ? "" : String(value);
  const clean = raw.trim();
  return clean || fallback;
}

function agvExchangeRoomId(value) {
  if (typeof agvBridgeRoomId === "function") {
    return agvBridgeRoomId(value || "main-hall");
  }

  return agvExchangeCleanText(value, "main-hall") || "main-hall";
}

function agvExchangeLayout(value) {
  if (typeof agvBridgeEgressLayout === "function") {
    return agvBridgeEgressLayout(value || "speaker-dark");
  }

  return agvExchangeCleanText(value, "speaker-dark") || "speaker-dark";
}

function agvExchangeStatusIsActive(status) {
  const text = String(status == null ? "" : status).toLowerCase();

  return (
    text === "1" ||
    text.includes("active") ||
    text.includes("starting") ||
    text.includes("started") ||
    text.includes("running")
  );
}

async function agvExchangeCurrentEgress() {
  const state = agvReadBroadcastState();
  const egressId =
    agvExchangeCleanText(state.egressId, "") ||
    agvExchangeCleanText(state.lastEgressId, "");

  if (!egressId) {
    return {
      found: false,
      active: false,
      egressId: "",
      status: "",
      error: "",
      note: "No egressId is stored.",
    };
  }

  try {
    if (typeof agvBridgeListEgressById !== "function") {
      return {
        found: false,
        active: false,
        egressId,
        status: "",
        error: "Egress status helper is unavailable.",
        note: "SCALE-7B helper missing.",
      };
    }

    const result = await agvBridgeListEgressById(egressId);
    const info = result?.list?.[0] || null;
    const api =
      info && typeof agvBridgeEgressToApi === "function"
        ? agvBridgeEgressToApi(info)
        : null;

    return {
      found: Boolean(api),
      active: Boolean(api && agvExchangeStatusIsActive(api.status) && !api.error),
      egressId,
      status: api?.status || "",
      error: api?.error || result?.error || "",
      roomName: api?.roomName || "",
      startedAt: api?.startedAt || "",
      updatedAt: api?.updatedAt || "",
      note: api ? "Current egress found." : result?.note || "Egress not found.",
    };
  } catch (error) {
    return {
      found: false,
      active: false,
      egressId,
      status: "",
      error: error?.message || String(error),
      note: "Could not inspect current egress.",
    };
  }
}

async function agvExchangeBuildStatus(roomIdInput = "main-hall") {
  const roomId = agvExchangeRoomId(roomIdInput);
  const state = agvReadBroadcastState();
  const playback = await agvPlaybackVerifyBuildReport(roomId);
  const egress = await agvExchangeCurrentEgress();

  const sourceLive = playback.sourceStatus === "live";
  const viewerBroadcast = playback.viewerMode === "broadcast";
  const broadcastLive = playback.broadcastStatus === "live";

  return {
    ok: true,
    service: "AGV One-Button Cloudflare Exchange Mode",
    pass: "SCALE-12",
    roomId,
    exchangeReady: Boolean(playback.playbackReady),
    exchangeLive: Boolean(sourceLive && viewerBroadcast && broadcastLive),
    playbackReady: Boolean(playback.playbackReady),
    player: playback.urls?.embedConfigured ? "Cloudflare iframe" : "HLS fallback",
    viewerMode: playback.viewerMode || "livekit",
    broadcastStatus: playback.broadcastStatus || "off",
    sourceStatus: playback.sourceStatus || "",
    bridgeMode: Boolean(state.bridgeMode),
    directMode: Boolean(state.directMode),
    egress,
    state: {
      provider: state.provider || "",
      roomId: state.roomId || roomId,
      title: state.title || "",
      egressId: state.egressId || "",
      lastEgressId: state.lastEgressId || "",
      egressStatus: state.egressStatus || "",
      egressError: state.egressError || "",
      egressLayoutMode: state.egressLayoutMode || "",
      egressLayout: state.egressLayout || "",
      message: state.message || "",
      updatedAt: state.updatedAt || "",
    },
    urls: playback.urls || {},
    note: "Exchange mode combines LiveKit bridge, Supabase source state, and Cloudflare playback readiness.",
    timestamp: new Date().toISOString(),
  };
}


// PASS_SCALE11_HOST_TRACK_TO_CLOUDFLARE_RTMPS_EXCHANGE
// SERVER — Use the active host video track as the Cloudflare RTMPS source.
// This avoids depending on LiveKit room-composite layout rendering for the first visible Cloudflare proof.

function agvExchangeTrackText(value) {
  return String(value == null ? "" : value).toLowerCase();
}

function agvExchangeTrackLooksVideo(track) {
  const text =
    agvExchangeTrackText(track?.kind) +
    " " +
    agvExchangeTrackText(track?.source) +
    " " +
    agvExchangeTrackText(track?.name);

  return (
    text.includes("video") ||
    text.includes("camera") ||
    text.includes("screen") ||
    String(track?.kind || "") === "1" ||
    String(track?.source || "") === "1" ||
    String(track?.source || "") === "3"
  );
}

function agvExchangeTrackLooksAudio(track) {
  const text =
    agvExchangeTrackText(track?.kind) +
    " " +
    agvExchangeTrackText(track?.source) +
    " " +
    agvExchangeTrackText(track?.name);

  return (
    text.includes("audio") ||
    text.includes("microphone") ||
    String(track?.kind || "") === "0" ||
    String(track?.source || "") === "2"
  );
}


// PASS_SCALE12_PREFER_SCREEN_SHARE_LAYOUT_FOR_CLOUDFLARE_EXCHANGE
// SERVER — Detect screen share and prefer LiveKit screen-share room layout for Cloudflare exchange.

function agvExchangeTrackLooksScreenShare(track) {
  const text =
    agvExchangeTrackText(track?.kind) +
    " " +
    agvExchangeTrackText(track?.source) +
    " " +
    agvExchangeTrackText(track?.name);

  return (
    text.includes("screen") ||
    text.includes("share") ||
    text.includes("screenshare") ||
    text.includes("screen_share") ||
    String(track?.source || "") === "3"
  );
}

function agvExchangeSelectScreenShareTrack(trackPreflight) {
  const participants = Array.isArray(trackPreflight?.participants)
    ? trackPreflight.participants
    : [];

  const allTracks = [];

  for (const participant of participants) {
    const tracks = Array.isArray(participant?.tracks) ? participant.tracks : [];

    for (const track of tracks) {
      allTracks.push({
        participantIdentity: participant?.identity || "",
        sid: track?.sid || track?.trackSid || track?.track_sid || "",
        name: track?.name || "",
        kind: track?.kind || "",
        source: track?.source || "",
        muted: Boolean(track?.muted),
      });
    }
  }

  const screenTrack =
    allTracks.find((track) => track.sid && !track.muted && agvExchangeTrackLooksScreenShare(track)) ||
    allTracks.find((track) => track.sid && agvExchangeTrackLooksScreenShare(track));

  return {
    screenShareDetected: Boolean(screenTrack?.sid),
    screenShareTrackId: screenTrack?.sid || "",
    screenShareParticipant: screenTrack?.participantIdentity || "",
    screenShareTrackName: screenTrack?.name || "",
    trackCount: allTracks.length,
  };
}

function agvExchangeSelectHostTracks(trackPreflight) {
  const participants = Array.isArray(trackPreflight?.participants)
    ? trackPreflight.participants
    : [];

  const allTracks = [];

  for (const participant of participants) {
    const tracks = Array.isArray(participant?.tracks) ? participant.tracks : [];

    for (const track of tracks) {
      allTracks.push({
        participantIdentity: participant?.identity || "",
        sid: track?.sid || track?.trackSid || track?.track_sid || "",
        name: track?.name || "",
        kind: track?.kind || "",
        source: track?.source || "",
        muted: Boolean(track?.muted),
        raw: track,
      });
    }
  }

  const activeVideo =
    allTracks.find((track) => track.sid && !track.muted && agvExchangeTrackLooksVideo(track)) ||
    allTracks.find((track) => track.sid && agvExchangeTrackLooksVideo(track));

  const activeAudio =
    allTracks.find((track) => track.sid && !track.muted && agvExchangeTrackLooksAudio(track)) ||
    allTracks.find((track) => track.sid && agvExchangeTrackLooksAudio(track));

  return {
    videoTrackId: activeVideo?.sid || "",
    audioTrackId: activeAudio?.sid || "",
    videoParticipant: activeVideo?.participantIdentity || "",
    audioParticipant: activeAudio?.participantIdentity || "",
    videoTrackName: activeVideo?.name || "",
    audioTrackName: activeAudio?.name || "",
    trackCount: allTracks.length,
    tracks: allTracks.map((track) => ({
      participantIdentity: track.participantIdentity,
      sid: track.sid,
      name: track.name,
      kind: track.kind,
      source: track.source,
      muted: track.muted,
    })),
  };
}

async function agvExchangeStartHostTrackEgress(egressClient, roomId, output, selectedTracks) {
  const videoTrackId = selectedTracks?.videoTrackId || "";
  const audioTrackId = selectedTracks?.audioTrackId || "";

  if (!videoTrackId) {
    throw new Error("No active host video track ID was available for Track Composite Egress.");
  }

  const attempts = [
    async () =>
      egressClient.startTrackCompositeEgress(roomId, output, {
        videoTrackId,
        audioTrackId,
      }),
    async () =>
      egressClient.startTrackCompositeEgress(
        roomId,
        output,
        audioTrackId || "",
        videoTrackId
      ),
    async () =>
      egressClient.startTrackCompositeEgress(roomId, output, "", videoTrackId),
  ];

  let lastError = null;

  for (const attempt of attempts) {
    try {
      return await attempt();
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error("LiveKit host track egress could not start.");
}

app.get("/api/broadcast/exchange/status", async (req, res) => {
  try {
    const report = await agvExchangeBuildStatus(req.query?.roomId || "main-hall");
    return res.json(report);
  } catch (error) {
    return res.status(500).json({
      ok: false,
      service: "AGV One-Button Cloudflare Exchange Mode",
      pass: "SCALE-12",
      error: error?.message || String(error),
      timestamp: new Date().toISOString(),
    });
  }
});

app.post("/api/broadcast/exchange/start", async (req, res) => {
  try {
    const body = req.body || {};
    const roomId = agvExchangeRoomId(body.roomId || "main-hall");
    const title =
      agvExchangeCleanText(body.title, "AGV Cloudflare Live Exchange") ||
      "AGV Cloudflare Live Exchange";
    const layout = agvExchangeLayout(body.layout || "speaker-dark");
    const message =
      agvExchangeCleanText(
        body.message,
        "AGV is live through the LiveKit to Cloudflare exchange."
      ) || "AGV is live through the LiveKit to Cloudflare exchange.";

    const config = agvLiveKitEgressConfig();
    const cf = agvCloudflareBroadcastConfig();

    if (!config.livekitConfigured) {
      return res.status(500).json({
        ok: false,
        service: "AGV Cloudflare Exchange Start",
        pass: "SCALE-12",
        error:
          "LiveKit is not configured. Check LIVEKIT_URL, LIVEKIT_API_KEY, and LIVEKIT_API_SECRET.",
        roomId,
      });
    }

    if (!cf.rtmpIngestUrlConfigured || !cf.streamKeyConfigured) {
      return res.status(500).json({
        ok: false,
        service: "AGV Cloudflare Exchange Start",
        pass: "SCALE-12",
        error:
          "Cloudflare RTMPS is not configured. Check AGV_CLOUDFLARE_RTMP_INGEST_URL and AGV_CLOUDFLARE_STREAM_KEY.",
        roomId,
      });
    }

    const playbackBefore = await agvPlaybackVerifyBuildReport(roomId);

    if (!playbackBefore.playbackReady && !body.force) {
      return res.status(409).json({
        ok: false,
        service: "AGV Cloudflare Exchange Start",
        pass: "SCALE-12",
        error:
          "Cloudflare playback URL is not ready. Verify playback before going live.",
        roomId,
        playback: playbackBefore,
      });
    }

    const roomCheck = await agvBridgeCheckLiveKitRoom(config, roomId);

    if (roomCheck.checked && !roomCheck.exists && !body.force) {
      return res.status(409).json({
        ok: false,
        service: "AGV Cloudflare Exchange Start",
        pass: "SCALE-12",
        error:
          "LiveKit room does not exist yet. Start Host Camera first, then go live to Cloudflare.",
        roomId,
        roomCheck,
      });
    }

    const trackPreflight = await agvBridgePreflightRoomTracks(config, roomId);

    if (!trackPreflight.roomReady && !body.force) {
      return res.status(409).json({
        ok: false,
        service: "AGV Cloudflare Exchange Start",
        pass: "SCALE-12",
        error:
          "LiveKit room is not ready. Start Host Camera, confirm viewer can see video, wait 5 seconds, then go live.",
        roomId,
        roomCheck,
        trackPreflight,
      });
    }

    const streamUrl = agvCloudflareRtmpStreamUrl();

    if (!streamUrl) {
      return res.status(500).json({
        ok: false,
        service: "AGV Cloudflare Exchange Start",
        pass: "SCALE-12",
        error: "Could not build Cloudflare RTMPS stream URL.",
        roomId,
      });
    }

    const {
      EgressClient,
      StreamOutput,
      StreamProtocol,
    } = require("livekit-server-sdk");

    const egressClient = new EgressClient(
      config.livekitUrl,
      process.env.LIVEKIT_API_KEY,
      process.env.LIVEKIT_API_SECRET
    );

    let output;

    try {
      output = new StreamOutput({
        protocol: StreamProtocol.RTMP,
        urls: [streamUrl],
      });
    } catch {
      output = {
        protocol: StreamProtocol.RTMP,
        urls: [streamUrl],
      };
    }

    const info = await agvBridgeStartRoomCompositeEgress(
      egressClient,
      roomId,
      output,
      layout
    );

    const safeInfo = agvSafeEgressSummary(info);
    const egressId =
      safeInfo?.egressId ||
      info?.egressId ||
      info?.egress_id ||
      info?.id ||
      "";

    const source = await agvBridgeUpdateSupabaseSource(roomId, "live", message);
    const playbackAfter = await agvPlaybackVerifyBuildReport(roomId);

    const playbackUrl =
      playbackAfter.urls?.playbackUrl ||
      playbackAfter.urls?.embedUrl ||
      playbackAfter.urls?.hlsUrl ||
      "";

    const next = agvWriteBroadcastState({
      provider: "cloudflare-exchange",
      status: "live",
      isLive: true,
      viewerMode: "broadcast",
      roomId,
      eventId: source?.eventId || body.eventId || "",
      title,
      sourceName: source?.sourceName || "AGV Cloudflare Exchange Source",
      sourceType: "livekit-egress-rtmps",
      playbackUrl: playbackAfter.urls?.playbackUrl || "",
      embedUrl: playbackAfter.urls?.embedUrl || "",
      hlsUrl: playbackAfter.urls?.hlsUrl || "",
      message,
      directMode: false,
      bridgeMode: true,
      exchangeMode: true,
      sourceRegistryConnected: Boolean(source),
      sourceRegistryType: source ? "supabase" : "",
      supabaseSourceUsed: Boolean(source),
      supabaseSourceUpdated: Boolean(source),
      egressId,
      lastEgressId: egressId,
      egressStatus: safeInfo?.status || "started",
      egressError: "",
      egressLayoutMode: "room-composite",
      egressLayout: layout,
      egressStartedAt: new Date().toISOString(),
      egressUpdatedAt: new Date().toISOString(),
      rtmpIngestUrlConfigured: true,
      streamKeyConfigured: true,
    });

    return res.json({
      ok: true,
      service: "AGV Cloudflare Exchange Start",
      pass: "SCALE-12",
      state: next,
      source,
      playback: {
        playbackReady: Boolean(playbackAfter.playbackReady),
        player: playbackAfter.urls?.embedConfigured ? "Cloudflare iframe" : "HLS fallback",
        playbackUrl,
        hlsUrl: playbackAfter.urls?.hlsUrl || "",
        embedUrl: playbackAfter.urls?.embedUrl || "",
      },
      roomCheck,
      trackPreflight,
      egress: safeInfo,
      egressId,
      selectedTracks,
      selectedScreenShare,
      selectedExchangeMode,
      note: useScreenShareLayout
        ? "AGV Cloudflare Exchange is live. Screen share layout is being sent to Cloudflare RTMPS with the shared screen prioritized."
        : "AGV Cloudflare Exchange is live. The active host video track is being sent to Cloudflare RTMPS and viewers are routed to Cloudflare playback.",
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    const message = error?.message || String(error);

    const next = agvWriteBroadcastState({
      status: "off",
      isLive: false,
      viewerMode: "livekit",
      directMode: false,
      bridgeMode: false,
      exchangeMode: false,
      egressId: "",
      egressStatus: "exchange-start-error",
      egressError: message,
      egressUpdatedAt: new Date().toISOString(),
      message:
        "AGV Cloudflare Exchange failed. AGV returned viewers to LiveKit mode.",
    });

    return res.status(500).json({
      ok: false,
      service: "AGV Cloudflare Exchange Start",
      pass: "SCALE-12",
      rollback: true,
      state: next,
      error: message,
      timestamp: new Date().toISOString(),
    });
  }
});

app.post("/api/broadcast/exchange/stop", async (req, res) => {
  try {
    const body = req.body || {};
    const current = agvReadBroadcastState();
    const roomId = agvExchangeRoomId(body.roomId || current.roomId || "main-hall");
    const egressId =
      agvExchangeCleanText(body.egressId, "") ||
      agvExchangeCleanText(current.egressId, "") ||
      agvExchangeCleanText(current.lastEgressId, "");

    const config = agvLiveKitEgressConfig();
    let stopError = "";
    let stopped = false;

    if (egressId && config.livekitConfigured) {
      try {
        const { EgressClient } = require("livekit-server-sdk");
        const egressClient = new EgressClient(
          config.livekitUrl,
          process.env.LIVEKIT_API_KEY,
          process.env.LIVEKIT_API_SECRET
        );

        await egressClient.stopEgress(egressId);
        stopped = true;
      } catch (error) {
        stopError = error?.message || String(error);

        if (
          stopError.toLowerCase().includes("egress_complete") ||
          stopError.toLowerCase().includes("complete") ||
          stopError.toLowerCase().includes("not found")
        ) {
          stopped = false;
        }
      }
    }

    const stopMessage =
      agvExchangeCleanText(
        body.message,
        "AGV Cloudflare Exchange stopped. Viewers returned to LiveKit."
      ) || "AGV Cloudflare Exchange stopped. Viewers returned to LiveKit.";

    const source = await agvBridgeUpdateSupabaseSource(
      roomId,
      "standby",
      stopMessage
    );

    const next = agvWriteBroadcastState({
      provider: "cloudflare-exchange",
      status: "off",
      isLive: false,
      viewerMode: "livekit",
      roomId,
      directMode: false,
      bridgeMode: false,
      exchangeMode: false,
      sourceRegistryConnected: Boolean(source),
      sourceRegistryType: source ? "supabase" : "",
      supabaseSourceUsed: Boolean(source),
      supabaseSourceUpdated: Boolean(source),
      egressId: "",
      lastEgressId: egressId || current.lastEgressId || "",
      egressStatus: stopError ? "exchange-stop-warning" : stopped ? "stopped" : "state-reset",
      egressError: stopError,
      egressLayoutMode: "room-composite",
      egressUpdatedAt: new Date().toISOString(),
      message: stopMessage,
    });

    return res.json({
      ok: true,
      service: "AGV Cloudflare Exchange Stop",
      pass: "SCALE-12",
      state: next,
      source,
      stopped,
      stopError,
      note: stopError
        ? "AGV returned viewers to LiveKit, but LiveKit egress stop reported a warning."
        : "AGV Cloudflare Exchange stopped and viewers returned to LiveKit.",
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      service: "AGV Cloudflare Exchange Stop",
      pass: "SCALE-12",
      error: error?.message || String(error),
      timestamp: new Date().toISOString(),
    });
  }
});


/* AGV PASS PRICING-1 — REVENUE POLICY FOUNDATION */
const AGV_REVENUE_POLICY = Object.freeze({
  ok: true,
  service: "AGV Revenue Policy Foundation",
  pass: "PASS PRICING-1",
  currency: "USD",
  monthlySubscriptionPurpose: "Platform access",
  subscriptionRule: "Monthly subscriptions provide access to the AGV platform, rooms, host tools, viewer tools, event controls, and plan features. Monthly subscription pricing does not include unlimited broadcast delivery.",
  agvTicketPlatformFeePercent: 7,
  ticketFeeRule: "Paid ticketed events include a 7% AGV ticket platform fee. This is AGV monetization revenue and is separate from broadcast delivery and payment processing.",
  broadcastDeliveryFeeRule: "Broadcast delivery fees are billed separately based on audience size, watch time, streaming usage, Cloudflare delivery, storage, and related broadcast infrastructure costs.",
  paymentProcessingRule: "Payment processing fees are passed through separately and are not included in the AGV 7% ticket platform fee.",
  largeEventRule: "Large audience broadcasts, international events, conventions, high-viewer programs, and unusual streaming loads may require a custom quote before going live.",
  planPricingPurpose: {
    free: "Free platform access for limited testing and basic use.",
    creator: "Creator platform access for independent creators and smaller paid events.",
    ministryPro: "Ministry / Pro platform access for ministries, teachers, podcasters, and professional programs.",
    convention: "Convention platform access for larger organized events. Large audience delivery may still require a custom quote."
  },
  feeModel: {
    monthlySubscription: "Platform access",
    ticketPlatformFee: "7% AGV monetization fee",
    broadcastDeliveryFee: "Separate usage-based fee to cover Cloudflare and streaming delivery",
    paymentProcessing: "Passed through separately",
    largeEvents: "Custom quote"
  },
  customerFacingSummary: "AGV monthly plans provide platform access. Paid ticketed events include a 7% AGV platform fee. Broadcast delivery fees are billed separately based on audience size, watch time, and streaming usage. Standard payment processing fees are passed through separately. Large audience events may require a custom quote."
});

function agvRevenuePolicyResponse(extra = {}) {
  return {
    ...AGV_REVENUE_POLICY,
    ...extra,
    timestamp: new Date().toISOString()
  };
}

app.get("/api/revenue-policy", (req, res) => {
  res.json(agvRevenuePolicyResponse({
    endpoint: "/api/revenue-policy"
  }));
});

app.get("/api/pricing-policy", (req, res) => {
  res.json(agvRevenuePolicyResponse({
    endpoint: "/api/pricing-policy"
  }));
});

app.get("/api/agv-fees", (req, res) => {
  res.json(agvRevenuePolicyResponse({
    endpoint: "/api/agv-fees"
  }));
});
/* END AGV PASS PRICING-1 */


server.listen(PORT, () => {
  const usersFileExists = fs.existsSync(USERS_FILE);

  console.log(`SERVER RUNNING ON ${PORT}`);
  console.log(`DATA FILE: ${DATA_FILE}`);
  console.log(`USERS FILE: ${USERS_FILE}`);

  if (!usersFileExists) {
    console.log("DEFAULT ADMIN USERNAME:", DEFAULT_ADMIN_USERNAME);
    console.log(
      "DEFAULT ADMIN PASSWORD is loaded from AGV_ADMIN_PASSWORD or the fallback in index.js."
    );
    console.log("Change the seeded admin password before exposing this server.");
  }
});