import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { AccessToken } from "livekit-server-sdk";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 8788;

const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY || process.env.VITE_LIVEKIT_API_KEY || "";
const LIVEKIT_API_SECRET =
  process.env.LIVEKIT_API_SECRET || process.env.LIVEKIT_SECRET || "";
const LIVEKIT_URL =
  process.env.LIVEKIT_URL || "wss://stro-chievery-h77dyr5e.livekit.cloud";

const DATA_DIR = path.join(__dirname, "data");
const ROOMS_FILE = path.join(DATA_DIR, "rooms.json");

app.use(cors());
app.use(express.json({ limit: "2mb" }));

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function nowIso() {
  return new Date().toISOString();
}

function cleanText(value, fallback = "") {
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

function defaultRooms() {
  const names = [
    "Main Convention Hall",
    "Leadership Forum",
    "Youth Experience",
    "Prayer Chapel",
    "Study Hall",
    "Speaker Green Room",
    "Admin Operations",
    "Auxiliary Room A",
  ];

  return names.map((name, index) => {
    const id = index + 1;
    const slug = slugify(name);
    return {
      id,
      room_key: slug,
      slug,
      name,
      type: index === 0 ? "Featured" : "Standard",
      status: index === 0 ? "live" : "ready",
      visibility: index === 5 || index === 6 ? "private" : "public",
      livekitRoom: `stro-chievery-${id}`,
      assignedHost: null,
      moderators: [],
      updatedAt: nowIso(),
      createdAt: nowIso(),
    };
  });
}

function normalizeModerator(mod) {
  return {
    userId: cleanText(mod?.userId),
    displayName: cleanText(mod?.displayName, "Moderator"),
    addedAt: cleanText(mod?.addedAt, nowIso()),
  };
}

function normalizeRoom(room, fallbackId) {
  const id = Number(room?.id) || fallbackId;
  const name = cleanText(room?.name, `Room ${id}`);
  return {
    id,
    room_key: cleanText(room?.room_key, slugify(name)),
    slug: cleanText(room?.slug, slugify(name)),
    name,
    type: cleanText(room?.type, "Standard"),
    status: cleanText(room?.status, "ready"),
    visibility: cleanText(room?.visibility, "public"),
    livekitRoom: cleanText(room?.livekitRoom, `stro-chievery-${id}`),
    assignedHost:
      room?.assignedHost && room.assignedHost.userId
        ? {
            userId: cleanText(room.assignedHost.userId),
            displayName: cleanText(room.assignedHost.displayName, "Host"),
            assignedAt: cleanText(room.assignedHost.assignedAt, nowIso()),
          }
        : null,
    moderators: Array.isArray(room?.moderators)
      ? room.moderators.map(normalizeModerator).filter((m) => m.userId)
      : [],
    updatedAt: cleanText(room?.updatedAt, nowIso()),
    createdAt: cleanText(room?.createdAt, nowIso()),
  };
}

function loadRooms() {
  ensureDataDir();

  if (!fs.existsSync(ROOMS_FILE)) {
    const starter = defaultRooms();
    fs.writeFileSync(ROOMS_FILE, JSON.stringify(starter, null, 2), "utf8");
    return starter;
  }

  try {
    const raw = fs.readFileSync(ROOMS_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      const starter = defaultRooms();
      fs.writeFileSync(ROOMS_FILE, JSON.stringify(starter, null, 2), "utf8");
      return starter;
    }
    return parsed.map((room, index) => normalizeRoom(room, index + 1));
  } catch (error) {
    const starter = defaultRooms();
    fs.writeFileSync(ROOMS_FILE, JSON.stringify(starter, null, 2), "utf8");
    return starter;
  }
}

let rooms = loadRooms();

function saveRooms() {
  ensureDataDir();
  fs.writeFileSync(ROOMS_FILE, JSON.stringify(rooms, null, 2), "utf8");
}

function getViewerIdentity(req) {
  const source = req.method === "GET" ? req.query : req.body;
  const userId = cleanText(source?.userId);
  const displayName = cleanText(source?.displayName, "Guest");
  const email = cleanText(source?.email);
  const invited = Boolean(source?.invited);

  return {
    userId,
    displayName,
    email,
    invited,
  };
}

function findRoomByAny(value) {
  const needle = String(value || "").trim().toLowerCase();
  if (!needle) return null;

  return (
    rooms.find((room) => String(room.id).toLowerCase() === needle) ||
    rooms.find((room) => String(room.room_key || "").toLowerCase() === needle) ||
    rooms.find((room) => String(room.slug || "").toLowerCase() === needle) ||
    rooms.find((room) => String(room.name || "").toLowerCase() === needle) ||
    null
  );
}

function isAssignedHost(room, userId) {
  return Boolean(room?.assignedHost?.userId && room.assignedHost.userId === userId);
}

function isModerator(room, userId) {
  return Array.isArray(room?.moderators)
    ? room.moderators.some((mod) => mod.userId === userId)
    : false;
}

function buildPermissions(room, viewer) {
  const hasUser = Boolean(viewer?.userId);
  const assignedHost = hasUser ? isAssignedHost(room, viewer.userId) : false;
  const moderator = hasUser ? isModerator(room, viewer.userId) : false;

  return {
    isAssignedHost: assignedHost,
    isModerator: moderator,
    serverRole: assignedHost ? "host" : moderator ? "moderator" : "viewer",
    canPublishMedia: assignedHost || moderator,
    canManageModerators: assignedHost,
    canAssignHost: assignedHost,
    canSeePrivateControls: assignedHost || moderator,
  };
}

function roomForClient(room, viewer) {
  return {
    ...room,
    myPermissions: buildPermissions(room, viewer),
  };
}

function upsertHostIfEmpty(room, viewer) {
  if (!room.assignedHost && viewer?.userId && !viewer.invited) {
    room.assignedHost = {
      userId: viewer.userId,
      displayName: viewer.displayName || "Host",
      assignedAt: nowIso(),
    };
    room.updatedAt = nowIso();
    saveRooms();
  }
}

app.get("/rooms", (req, res) => {
  const viewer = getViewerIdentity(req);

  const payload = rooms.map((room) => roomForClient(room, viewer));
  res.json(payload);
});

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    port: PORT,
    livekitConfigured: Boolean(LIVEKIT_API_KEY && LIVEKIT_API_SECRET),
    rooms: rooms.length,
    timestamp: nowIso(),
  });
});

app.post("/rooms/:roomId/assign-host", (req, res) => {
  const viewer = getViewerIdentity(req);
  const room = findRoomByAny(req.params.roomId);

  if (!room) {
    return res.status(404).json({ error: "Room not found." });
  }

  upsertHostIfEmpty(room, viewer);

  const perms = buildPermissions(room, viewer);
  if (!perms.canAssignHost) {
    return res.status(403).json({ error: "Only the assigned host can assign a new host." });
  }

  const targetUserId = cleanText(req.body?.targetUserId);
  const targetDisplayName = cleanText(req.body?.targetDisplayName, "Host");

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

  return res.json({
    ok: true,
    room: roomForClient(room, viewer),
  });
});

app.post("/rooms/:roomId/moderators", (req, res) => {
  const viewer = getViewerIdentity(req);
  const room = findRoomByAny(req.params.roomId);

  if (!room) {
    return res.status(404).json({ error: "Room not found." });
  }

  upsertHostIfEmpty(room, viewer);

  const perms = buildPermissions(room, viewer);
  if (!perms.canManageModerators) {
    return res.status(403).json({ error: "Only the assigned host can manage moderators." });
  }

  const action = cleanText(req.body?.action);
  const targetUserId = cleanText(req.body?.targetUserId);
  const targetDisplayName = cleanText(req.body?.targetDisplayName, "Moderator");

  if (!targetUserId) {
    return res.status(400).json({ error: "targetUserId is required." });
  }

  if (action !== "add" && action !== "remove") {
    return res.status(400).json({ error: 'action must be "add" or "remove".' });
  }

  if (room.assignedHost?.userId === targetUserId) {
    return res.status(400).json({ error: "Assigned host cannot be added as moderator." });
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
  }

  if (action === "remove") {
    room.moderators = room.moderators.filter((mod) => mod.userId !== targetUserId);
  }

  room.updatedAt = nowIso();
  saveRooms();

  return res.json({
    ok: true,
    room: roomForClient(room, viewer),
  });
});

app.post("/token", async (req, res) => {
  try {
    if (!LIVEKIT_API_KEY || !LIVEKIT_API_SECRET) {
      return res.status(500).json({
        error: "LiveKit server credentials are missing. Add LIVEKIT_API_KEY and LIVEKIT_API_SECRET to your server .env.",
      });
    }

    const viewer = getViewerIdentity(req);
    const roomId = req.body?.roomId;
    const roomNameFromBody = cleanText(req.body?.room);
    const requestedName = cleanText(req.body?.username, viewer.displayName || "Guest");
    const joiningRoom =
      findRoomByAny(roomId) ||
      findRoomByAny(roomNameFromBody) ||
      rooms.find((room) => room.livekitRoom === roomNameFromBody) ||
      null;

    if (!joiningRoom) {
      return res.status(404).json({ error: "Could not find the requested room." });
    }

    upsertHostIfEmpty(joiningRoom, viewer);

    const permissions = buildPermissions(joiningRoom, viewer);
    const participantIdentity =
      cleanText(viewer.userId) ||
      `guest-${slugify(requestedName)}-${Math.random().toString(36).slice(2, 8)}`;

    const token = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
      identity: participantIdentity,
      name: requestedName,
      metadata: JSON.stringify({
        roomId: joiningRoom.id,
        roomName: joiningRoom.name,
        serverRole: permissions.serverRole,
        canPublishMedia: permissions.canPublishMedia,
      }),
    });

    token.addGrant({
      roomJoin: true,
      room: joiningRoom.livekitRoom,
      canPublish: permissions.canPublishMedia,
      canPublishData: true,
      canSubscribe: true,
    });

    return res.json({
      token: await token.toJwt(),
      room: roomForClient(joiningRoom, viewer),
      permissions,
      livekitUrl: LIVEKIT_URL,
    });
  } catch (error) {
    return res.status(500).json({
      error: error?.message || "Could not create token.",
    });
  }
});

app.listen(PORT, () => {
  console.log(`Stro Chievery server running on http://localhost:${PORT}`);
});