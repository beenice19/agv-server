const express = require("express");
const cors = require("cors");
const http = require("http");
const fs = require("fs");
const path = require("path");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { Server } = require("socket.io");

const app = express();
const PORT = process.env.PORT || 8787;

app.use(cors({
  origin: "*", // we will tighten this after deployment
  methods: ["GET", "POST"],
  allowedHeaders: ["Content-Type", "Authorization"],
}));
app.use(express.json({ limit: "8mb" }));

const server = http.createServer(app);

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
// 🔥 LIVEKIT TOKEN ENDPOINT (MERGED INTO MAIN SERVER)

app.post("/api/livekit/token", requireAuth, async (req, res) => {
  try {
    const { roomName, identity, name } = req.body || {};

    if (!roomName || !identity) {
      return res.status(400).json({
        ok: false,
        error: "roomName and identity required",
      });
    }

    const room = findRoom(cleanName(roomName));

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

    const resolvedRole = getRole(room, req.authUser);
    const canPublishToLiveKit =
      resolvedRole === "superadmin" ||
      resolvedRole === "host" ||
      resolvedRole === "moderator";

    const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY;
    const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET;
    const LIVEKIT_URL = process.env.LIVEKIT_URL;

    if (!LIVEKIT_API_KEY || !LIVEKIT_API_SECRET || !LIVEKIT_URL) {
      return res.status(500).json({
        ok: false,
        error: "LiveKit env not configured",
      });
    }

    const { AccessToken } = require("livekit-server-sdk");

    const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
      identity: cleanName(identity) || req.authUser.username,
      name: cleanName(name) || req.authUser.displayName,
      metadata: JSON.stringify({
        role: resolvedRole,
        displayName: req.authUser.displayName,
        roomId: room.id,
      }),
    });

    at.addGrant({
      room: room.id,
      roomJoin: true,
      canPublish: canPublishToLiveKit,
      canSubscribe: true,
      canPublishData: true,
    });

    const token = await at.toJwt();

    return res.json({
      ok: true,
      participant_token: token,
      server_url: LIVEKIT_URL,
      roomName: room.id,
      role: resolvedRole,
      canPublish: canPublishToLiveKit,
    });
  } catch (error) {
    console.error("LIVEKIT TOKEN ERROR:", error);
    return res.status(500).json({
      ok: false,
      error: "LiveKit token failed",
    });
  }
});io.use((socket, next) => {
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