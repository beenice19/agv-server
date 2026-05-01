const express = require("express");
const cors = require("cors");

const app = express();
const PORT = 8787;

app.use(cors());
app.use(express.json());

function cleanName(value) {
  return String(value || "").trim();
}

function isAdminName(value) {
  return cleanName(value) === "Admin";
}

function uniqueNames(names) {
  const seen = new Set();
  const output = [];

  for (const name of Array.isArray(names) ? names : []) {
    const cleaned = cleanName(name);
    if (!cleaned) continue;
    if (seen.has(cleaned)) continue;
    seen.add(cleaned);
    output.push(cleaned);
  }

  return output;
}

let rooms = [
  {
    id: "main-hall",
    name: "Main Hall",
    category: "Convention",
    isPrivate: false,
    assignedHost: "Admin",
    moderators: ["Admin"],
  },
  {
    id: "studio-a",
    name: "Studio A",
    category: "Media",
    isPrivate: false,
    assignedHost: "Admin",
    moderators: [],
  },
  {
    id: "radio-room",
    name: "Radio Room",
    category: "Broadcast",
    isPrivate: false,
    assignedHost: "Admin",
    moderators: [],
  },
  {
    id: "prayer-room",
    name: "Prayer Room",
    category: "Community",
    isPrivate: true,
    assignedHost: "Admin",
    moderators: [],
  },
  {
    id: "classroom-1",
    name: "Classroom 1",
    category: "Teaching",
    isPrivate: false,
    assignedHost: "Admin",
    moderators: [],
  },
  {
    id: "green-room",
    name: "Green Room",
    category: "Backstage",
    isPrivate: true,
    assignedHost: "Admin",
    moderators: [],
  },
];

function repairRoom(room) {
  const assignedHost = cleanName(room.assignedHost) || "Admin";
  let moderators = uniqueNames(room.moderators);

  // Keep moderator list clean. Assigned host does not need to also sit in moderators.
  moderators = moderators.filter((name) => name !== assignedHost);

  return {
    id: cleanName(room.id),
    name: cleanName(room.name),
    category: cleanName(room.category),
    isPrivate: Boolean(room.isPrivate),
    assignedHost,
    moderators,
  };
}

rooms = rooms.map(repairRoom);

function findRoom(roomId) {
  return rooms.find((room) => room.id === roomId);
}

function getRole(room, displayName) {
  const user = cleanName(displayName);

  if (!user) return "viewer";
  if (isAdminName(user)) return "superadmin";
  if (!room) return "viewer";
  if (room.assignedHost === user) return "host";
  if (Array.isArray(room.moderators) && room.moderators.includes(user)) {
    return "moderator";
  }

  return "viewer";
}

function canAssignHost(room, actingUser) {
  const role = getRole(room, actingUser);
  return role === "superadmin";
}

function canManageModerators(room, actingUser) {
  const role = getRole(room, actingUser);
  return role === "superadmin" || role === "host";
}

function canManagePrivacy(room, actingUser) {
  const role = getRole(room, actingUser);
  return role === "superadmin" || role === "host" || role === "moderator";
}

function normalizeRoom(room, displayName = "") {
  const safeRoom = repairRoom(room);
  const role = getRole(safeRoom, displayName);

  return {
    id: safeRoom.id,
    name: safeRoom.name,
    category: safeRoom.category,
    isPrivate: safeRoom.isPrivate,
    assignedHost: safeRoom.assignedHost,
    moderators: safeRoom.moderators,
    host: safeRoom.assignedHost,
    myRole: role,
    permissions: {
      canAssignHost: role === "superadmin",
      canManageModerators: role === "superadmin" || role === "host",
      canManagePrivacy:
        role === "superadmin" || role === "host" || role === "moderator",
    },
  };
}

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    rooms: rooms.length,
    timestamp: new Date().toISOString(),
  });
});

app.get("/api/rooms", (req, res) => {
  const actingUser = cleanName(req.query.user);

  res.json({
    ok: true,
    rooms: rooms.map((room) => normalizeRoom(room, actingUser)),
  });
});

app.get("/api/rooms/:roomId", (req, res) => {
  const room = findRoom(req.params.roomId);

  if (!room) {
    return res.status(404).json({ ok: false, error: "Room not found" });
  }

  const actingUser = cleanName(req.query.user);

  return res.json({
    ok: true,
    room: normalizeRoom(room, actingUser),
  });
});

app.post("/api/rooms/:roomId/assign-host", (req, res) => {
  const room = findRoom(req.params.roomId);

  if (!room) {
    return res.status(404).json({ ok: false, error: "Room not found" });
  }

  const actingUser = cleanName(req.body?.actingUser);
  const nextHost = cleanName(req.body?.user);

  if (!nextHost) {
    return res.status(400).json({ ok: false, error: "Host name is required" });
  }

  if (!canAssignHost(room, actingUser)) {
    return res.status(403).json({
      ok: false,
      error: "Only Admin can assign a room host",
    });
  }

  room.assignedHost = nextHost;
  room.moderators = uniqueNames(room.moderators).filter((name) => name !== nextHost);

  return res.json({
    ok: true,
    room: normalizeRoom(room, actingUser),
  });
});

app.post("/api/rooms/:roomId/add-moderator", (req, res) => {
  const room = findRoom(req.params.roomId);

  if (!room) {
    return res.status(404).json({ ok: false, error: "Room not found" });
  }

  const actingUser = cleanName(req.body?.actingUser);
  const nextModerator = cleanName(req.body?.user);

  if (!nextModerator) {
    return res
      .status(400)
      .json({ ok: false, error: "Moderator name is required" });
  }

  if (!canManageModerators(room, actingUser)) {
    return res.status(403).json({
      ok: false,
      error: "Only Admin or the assigned host can add moderators",
    });
  }

  if (nextModerator !== room.assignedHost) {
    room.moderators = uniqueNames([...(room.moderators || []), nextModerator]);
  }

  return res.json({
    ok: true,
    room: normalizeRoom(room, actingUser),
  });
});

app.post("/api/rooms/:roomId/remove-moderator", (req, res) => {
  const room = findRoom(req.params.roomId);

  if (!room) {
    return res.status(404).json({ ok: false, error: "Room not found" });
  }

  const actingUser = cleanName(req.body?.actingUser);
  const moderatorToRemove = cleanName(req.body?.user);

  if (!moderatorToRemove) {
    return res
      .status(400)
      .json({ ok: false, error: "Moderator name is required" });
  }

  if (!canManageModerators(room, actingUser)) {
    return res.status(403).json({
      ok: false,
      error: "Only Admin or the assigned host can remove moderators",
    });
  }

  room.moderators = uniqueNames(room.moderators).filter(
    (name) => name !== moderatorToRemove
  );

  return res.json({
    ok: true,
    room: normalizeRoom(room, actingUser),
  });
});

app.post("/api/rooms/:roomId/privacy", (req, res) => {
  const room = findRoom(req.params.roomId);

  if (!room) {
    return res.status(404).json({ ok: false, error: "Room not found" });
  }

  const actingUser = cleanName(req.body?.actingUser);
  const nextValue = Boolean(req.body?.isPrivate);

  if (!canManagePrivacy(room, actingUser)) {
    return res.status(403).json({ ok: false, error: "Not allowed" });
  }

  room.isPrivate = nextValue;

  return res.json({
    ok: true,
    room: normalizeRoom(room, actingUser),
  });
});

app.listen(PORT, () => {
  console.log(`SERVER RUNNING ON ${PORT}`);
});