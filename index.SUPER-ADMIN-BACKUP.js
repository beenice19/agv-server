const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = 8787;

app.use(cors());
app.use(express.json({ limit: "2mb" }));

const DATA_DIR = path.join(__dirname, "data");
const ROOMS_FILE = path.join(DATA_DIR, "rooms.json");

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function nowIso() {
  return new Date().toISOString();
}

function safeText(value, fallback = "") {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  return trimmed || fallback;
}

function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function createDefaultRooms() {
  const baseRooms = [
    { id: 1, name: "Main Convention Hall", meta: "245 watching • Host ready • Main stage" },
    { id: 2, name: "Leadership Forum", meta: "82 watching • Panel session • Waiting room open" },
    { id: 3, name: "Youth Experience", meta: "128 watching • Interactive session • Music cue loaded" },
    { id: 4, name: "Prayer Chapel", meta: "34 watching • Quiet room • Reflection mode" },
    { id: 5, name: "Study Hall", meta: "56 watching • Notes available • Breakout learning" },
    { id: 6, name: "Speaker Green Room", meta: "12 watching • Private prep • Speakers waiting" },
    { id: 7, name: "Admin Operations", meta: "9 watching • Moderator desk • Control center" },
    { id: 8, name: "Auxiliary Room A", meta: "23 watching • Overflow feed • Support session" },
  ];

  return baseRooms.map((room) => ({
    id: room.id,
    name: room.name,
    meta: room.meta,
    slug: slugify(room.name),
    visibility:
      room.name === "Speaker Green Room" || room.name === "Admin Operations"
        ? "private"
        : "public",
    status: room.id === 1 ? "live" : "ready",
    assignedHost: null,
    moderators: [],
    createdAt: nowIso(),
    updatedAt: nowIso(),
  }));
}

function normalizeModerator(mod) {
  return {
    userId: safeText(mod?.userId),
    displayName: safeText(mod?.displayName, "Moderator"),
    addedAt: safeText(mod?.addedAt, nowIso()),
  };
}

function normalizeRoom(room, fallbackId) {
  const id = Number(room?.id) || fallbackId;
  const name = safeText(room?.name, `Room ${id}`);

  return {
    id,
    name,
    meta: safeText(room?.meta, ""),
    slug: safeText(room?.slug, slugify(name)),
    visibility: safeText(room?.visibility, "public"),
    status: safeText(room?.status, "ready"),
    assignedHost:
      room?.assignedHost && room.assignedHost.userId
        ? {
            userId: safeText(room.assignedHost.userId),
            displayName: safeText(room.assignedHost.displayName, "Host"),
            assignedAt: safeText(room.assignedHost.assignedAt, nowIso()),
          }
        : null,
    moderators: Array.isArray(room?.moderators)
      ? room.moderators.map(normalizeModerator).filter((mod) => mod.userId)
      : [],
    createdAt: safeText(room?.createdAt, nowIso()),
    updatedAt: safeText(room?.updatedAt, nowIso()),
  };
}

function loadRooms() {
  ensureDataDir();

  if (!fs.existsSync(ROOMS_FILE)) {
    const starter = createDefaultRooms();
    fs.writeFileSync(ROOMS_FILE, JSON.stringify(starter, null, 2), "utf8");
    return starter;
  }

  try {
    const raw = fs.readFileSync(ROOMS_FILE, "utf8");
    const parsed = JSON.parse(raw);

    if (!Array.isArray(parsed)) {
      const starter = createDefaultRooms();
      fs.writeFileSync(ROOMS_FILE, JSON.stringify(starter, null, 2), "utf8");
      return starter;
    }

    return parsed.map((room, index) => normalizeRoom(room, index + 1));
  } catch (error) {
    console.error("Failed to load rooms file. Rebuilding clean rooms store.", error);
    const starter = createDefaultRooms();
    fs.writeFileSync(ROOMS_FILE, JSON.stringify(starter, null, 2), "utf8");
    return starter;
  }
}

let rooms = loadRooms();

function saveRooms() {
  ensureDataDir();
  fs.writeFileSync(ROOMS_FILE, JSON.stringify(rooms, null, 2), "utf8");
}

function getActor(req) {
  const source = req.method === "GET" ? req.query : req.body;
  return {
    userId: safeText(source?.userId),
    displayName: safeText(source?.displayName, "Guest"),
  };
}

function getRoomById(id) {
  return rooms.find((room) => String(room.id) === String(id));
}

function isAssignedHost(room, userId) {
  return Boolean(room?.assignedHost?.userId && room.assignedHost.userId === userId);
}

function isModerator(room, userId) {
  return Array.isArray(room?.moderators)
    ? room.moderators.some((mod) => mod.userId === userId)
    : false;
}

function buildPermissions(room, actor) {
  const host = actor.userId ? isAssignedHost(room, actor.userId) : false;
  const moderator = actor.userId ? isModerator(room, actor.userId) : false;

  return {
    serverRole: host ? "host" : moderator ? "moderator" : "viewer",
    isAssignedHost: host,
    isModerator: moderator,
    canPublishMedia: host || moderator,
    canAssignHost: host,
    canManageModerators: host,
    canManageRoom: host || moderator,
    canToggleVisibility: host || moderator,
    canToggleStatus: host || moderator,
  };
}

function roomForClient(room, actor) {
  return {
    ...room,
    myPermissions: buildPermissions(room, actor),
  };
}

function autoAssignFirstHost(room, actor) {
  if (!room.assignedHost && actor.userId) {
    room.assignedHost = {
      userId: actor.userId,
      displayName: actor.displayName || "Host",
      assignedAt: nowIso(),
    };
    room.updatedAt = nowIso();
    saveRooms();
  }
}

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    rooms: rooms.length,
    timestamp: nowIso(),
  });
});

app.get("/api/rooms", (req, res) => {
  const actor = getActor(req);
  res.json({ rooms: rooms.map((room) => roomForClient(room, actor)) });
});

app.get("/api/rooms/:roomId", (req, res) => {
  const actor = getActor(req);
  const room = getRoomById(req.params.roomId);

  if (!room) {
    return res.status(404).json({ error: "Room not found." });
  }

  return res.json({ room: roomForClient(room, actor) });
});

app.post("/api/rooms", (req, res) => {
  const actor = getActor(req);

  const nextId = rooms.length ? Math.max(...rooms.map((room) => room.id)) + 1 : 1;
  const name = safeText(req.body?.name, `Room ${nextId}`);
  const newRoom = {
    id: nextId,
    name,
    meta: safeText(req.body?.meta, "New room"),
    slug: slugify(name),
    visibility: safeText(req.body?.visibility, "public"),
    status: safeText(req.body?.status, "ready"),
    assignedHost: actor.userId
      ? {
          userId: actor.userId,
          displayName: actor.displayName || "Host",
          assignedAt: nowIso(),
        }
      : null,
    moderators: [],
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };

  rooms.push(newRoom);
  saveRooms();

  return res.json({ room: roomForClient(newRoom, actor) });
});

app.patch("/api/rooms/:roomId", (req, res) => {
  const actor = getActor(req);
  const room = getRoomById(req.params.roomId);

  if (!room) {
    return res.status(404).json({ error: "Room not found." });
  }

  autoAssignFirstHost(room, actor);

  const permissions = buildPermissions(room, actor);
  if (!permissions.canManageRoom) {
    return res.status(403).json({ error: "Only host or moderator can edit room settings." });
  }

  room.name = safeText(req.body?.name, room.name);
  room.meta = safeText(req.body?.meta, room.meta);
  room.visibility = safeText(req.body?.visibility, room.visibility);
  room.status = safeText(req.body?.status, room.status);
  room.slug = slugify(room.name);
  room.updatedAt = nowIso();

  saveRooms();
  return res.json({ room: roomForClient(room, actor) });
});

app.delete("/api/rooms/:roomId", (req, res) => {
  const actor = getActor(req);
  const room = getRoomById(req.params.roomId);

  if (!room) {
    return res.status(404).json({ error: "Room not found." });
  }

  autoAssignFirstHost(room, actor);

  const permissions = buildPermissions(room, actor);
  if (!permissions.isAssignedHost) {
    return res.status(403).json({ error: "Only the assigned host can delete a room." });
  }

  rooms = rooms.filter((entry) => String(entry.id) !== String(req.params.roomId));
  saveRooms();

  return res.json({ ok: true });
});

app.post("/api/rooms/:roomId/permissions/assign-host", (req, res) => {
  const actor = getActor(req);
  const room = getRoomById(req.params.roomId);

  if (!room) {
    return res.status(404).json({ error: "Room not found." });
  }

  autoAssignFirstHost(room, actor);

  const permissions = buildPermissions(room, actor);
  if (!permissions.canAssignHost) {
    return res.status(403).json({ error: "Only the assigned host can assign a new host." });
  }

  const targetUserId = safeText(req.body?.targetUserId);
  const targetDisplayName = safeText(req.body?.targetDisplayName, "Host");

  if (!targetUserId) {
    return res.status(400).json({ error: "targetUserId is required." });
  }

  room.assignedHost = {
    userId: targetUserId,
    displayName: targetDisplayName,
    assignedAt: nowIso(),
  };

  room.moderators = room.moderators.filter((mod) => mod.userId !== targetUserId);
  room.updatedAt = nowIso();
  saveRooms();

  return res.json({ room: roomForClient(room, actor) });
});

app.post("/api/rooms/:roomId/permissions/moderators", (req, res) => {
  const actor = getActor(req);
  const room = getRoomById(req.params.roomId);

  if (!room) {
    return res.status(404).json({ error: "Room not found." });
  }

  autoAssignFirstHost(room, actor);

  const permissions = buildPermissions(room, actor);
  if (!permissions.canManageModerators) {
    return res.status(403).json({ error: "Only the assigned host can manage moderators." });
  }

  const action = safeText(req.body?.action);
  const targetUserId = safeText(req.body?.targetUserId);
  const targetDisplayName = safeText(req.body?.targetDisplayName, "Moderator");

  if (!targetUserId) {
    return res.status(400).json({ error: "targetUserId is required." });
  }

  if (room.assignedHost?.userId === targetUserId) {
    return res.status(400).json({ error: "Assigned host cannot also be a moderator." });
  }

  if (action === "add") {
    const exists = room.moderators.some((mod) => mod.userId === targetUserId);
    if (!exists) {
      room.moderators.push({
        userId: targetUserId,
        displayName: targetDisplayName,
        addedAt: nowIso(),
      });
    }
  } else if (action === "remove") {
    room.moderators = room.moderators.filter((mod) => mod.userId !== targetUserId);
  } else {
    return res.status(400).json({ error: 'action must be "add" or "remove".' });
  }

  room.updatedAt = nowIso();
  saveRooms();

  return res.json({ room: roomForClient(room, actor) });
});

app.listen(PORT, () => {
  console.log(`Stro Chievery server listening on port ${PORT}`);
});