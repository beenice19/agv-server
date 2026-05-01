const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 8787;

const DATA_DIR = __dirname;
const ROOMS_FILE = path.join(DATA_DIR, "rooms.json");
const CHAT_FILE = path.join(DATA_DIR, "chat.json");
const BULLETIN_FILE = path.join(DATA_DIR, "bulletin.json");

const defaultRooms = [
  {
    id: 1,
    name: "Main Convention Hall",
    meta: "245 watching • Host ready • Main stage",
    visibility: "public",
    accessCode: "",
  },
  {
    id: 2,
    name: "Leadership Forum",
    meta: "82 watching • Panel session • Waiting room open",
    visibility: "public",
    accessCode: "",
  },
  {
    id: 3,
    name: "Youth Experience",
    meta: "128 watching • Interactive session • Music cue loaded",
    visibility: "public",
    accessCode: "",
  },
  {
    id: 4,
    name: "Prayer Chapel",
    meta: "34 watching • Quiet room • Reflection mode",
    visibility: "private",
    accessCode: "PRAYER",
  },
  {
    id: 5,
    name: "Study Hall",
    meta: "56 watching • Notes available • Breakout learning",
    visibility: "public",
    accessCode: "",
  },
  {
    id: 6,
    name: "Speaker Green Room",
    meta: "12 watching • Private prep • Speakers waiting",
    visibility: "private",
    accessCode: "GREENROOM",
  },
  {
    id: 7,
    name: "Admin Operations",
    meta: "9 watching • Moderator desk • Control center",
    visibility: "private",
    accessCode: "ADMIN",
  },
  {
    id: 8,
    name: "Auxiliary Room A",
    meta: "23 watching • Overflow feed • Support session",
    visibility: "public",
    accessCode: "",
  },
];

const defaultGlobalChat = [
  {
    id: 1,
    author: "Convention Desk",
    role: "Moderator",
    text: "Welcome to Stro Chievery. Layout shell is back online.",
    createdAt: new Date().toISOString(),
  },
  {
    id: 2,
    author: "Production",
    role: "Support",
    text: "Screen share dock box is now restored.",
    createdAt: new Date(Date.now() - 60 * 1000).toISOString(),
  },
];

const defaultGlobalBulletin = {
  fileName: "",
  status: "No bulletin file loaded.",
  text: "Convention announcements will appear here after you load a text file.",
  updatedAt: new Date().toISOString(),
};

app.use(cors());
app.use(express.json({ limit: "5mb" }));

function ensureJsonFile(filePath, fallbackData) {
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, JSON.stringify(fallbackData, null, 2), "utf8");
    return;
  }

  try {
    const raw = fs.readFileSync(filePath, "utf8");
    JSON.parse(raw);
  } catch {
    fs.writeFileSync(filePath, JSON.stringify(fallbackData, null, 2), "utf8");
  }
}

function readJson(filePath, fallbackData) {
  ensureJsonFile(filePath, fallbackData);

  try {
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return fallbackData;
  }
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
}

function formatRelativeTime(dateString) {
  const created = new Date(dateString).getTime();
  const now = Date.now();
  const diffMs = Math.max(0, now - created);
  const diffSec = Math.floor(diffMs / 1000);

  if (diffSec < 10) return "Just now";
  if (diffSec < 60) return `${diffSec} sec ago`;

  const diffMin = Math.floor(diffSec / 60);
  if (diffMin === 1) return "1 min ago";
  if (diffMin < 60) return `${diffMin} min ago`;

  const diffHr = Math.floor(diffMin / 60);
  if (diffHr === 1) return "1 hr ago";
  if (diffHr < 24) return `${diffHr} hrs ago`;

  const diffDay = Math.floor(diffHr / 24);
  if (diffDay === 1) return "1 day ago";
  return `${diffDay} days ago`;
}

function normalizeChatMessages(messages) {
  return messages.map((message) => {
    const createdAt = message.createdAt || new Date().toISOString();
    return {
      ...message,
      createdAt,
      time: formatRelativeTime(createdAt),
    };
  });
}

function normalizeRoom(room, fallbackId = 0) {
  return {
    id: Number(room.id) || fallbackId,
    name: typeof room.name === "string" ? room.name : `Room ${fallbackId}`,
    meta: typeof room.meta === "string" ? room.meta : "Room ready",
    visibility: room.visibility === "private" ? "private" : "public",
    accessCode: typeof room.accessCode === "string" ? room.accessCode : "",
  };
}

function getSafeRooms() {
  const rooms = readJson(ROOMS_FILE, defaultRooms);
  const safeRooms = Array.isArray(rooms) ? rooms : [...defaultRooms];
  return safeRooms.map((room, index) => normalizeRoom(room, index + 1));
}

function nextRoomId(rooms) {
  const maxId = rooms.reduce((max, room) => {
    const currentId = Number(room.id) || 0;
    return currentId > max ? currentId : max;
  }, 0);
  return maxId + 1;
}

function sanitizeRoomForClient(room, includeAccessCode = false) {
  const safe = {
    id: room.id,
    name: room.name,
    meta: room.meta,
    visibility: room.visibility,
    hasAccessCode: !!room.accessCode,
  };

  if (includeAccessCode) {
    safe.accessCode = room.accessCode;
  }

  return safe;
}

function createDefaultChatStore() {
  const store = {};
  for (const room of defaultRooms) {
    store[String(room.id)] = defaultGlobalChat.map((message) => ({
      ...message,
      id: Date.now() + Math.floor(Math.random() * 100000),
    }));
  }
  return store;
}

function createDefaultBulletinStore() {
  const store = {};
  for (const room of defaultRooms) {
    store[String(room.id)] = {
      ...defaultGlobalBulletin,
    };
  }
  return store;
}

function getChatStore() {
  const raw = readJson(CHAT_FILE, createDefaultChatStore());

  if (Array.isArray(raw)) {
    const migrated = createDefaultChatStore();
    migrated["1"] = raw.map((message) => ({
      ...message,
      createdAt: message.createdAt || new Date().toISOString(),
    }));
    writeJson(CHAT_FILE, migrated);
    return migrated;
  }

  const store = {};
  const rooms = getSafeRooms();

  for (const room of rooms) {
    const key = String(room.id);
    const value = raw[key];
    store[key] = Array.isArray(value)
      ? value.map((message) => ({
          ...message,
          createdAt: message.createdAt || new Date().toISOString(),
        }))
      : [];
  }

  return store;
}

function getBulletinStore() {
  const raw = readJson(BULLETIN_FILE, createDefaultBulletinStore());

  if (
    raw &&
    typeof raw === "object" &&
    !Array.isArray(raw) &&
    typeof raw.text === "string"
  ) {
    const migrated = createDefaultBulletinStore();
    migrated["1"] = {
      fileName: typeof raw.fileName === "string" ? raw.fileName : "",
      status: typeof raw.status === "string" ? raw.status : "No bulletin file loaded.",
      text: typeof raw.text === "string" ? raw.text : defaultGlobalBulletin.text,
      updatedAt: raw.updatedAt || new Date().toISOString(),
    };
    writeJson(BULLETIN_FILE, migrated);
    return migrated;
  }

  const store = {};
  const rooms = getSafeRooms();

  for (const room of rooms) {
    const key = String(room.id);
    const value = raw[key];
    store[key] =
      value && typeof value === "object" && !Array.isArray(value)
        ? {
            fileName: typeof value.fileName === "string" ? value.fileName : "",
            status:
              typeof value.status === "string"
                ? value.status
                : "No bulletin file loaded.",
            text:
              typeof value.text === "string"
                ? value.text
                : defaultGlobalBulletin.text,
            updatedAt: value.updatedAt || new Date().toISOString(),
          }
        : { ...defaultGlobalBulletin };
  }

  return store;
}

function ensureRoomIdExists(roomId) {
  const rooms = getSafeRooms();
  return rooms.some((room) => Number(room.id) === Number(roomId));
}

function ensureRoomDataSlots(roomId) {
  const key = String(roomId);

  const chatStore = getChatStore();
  if (!Array.isArray(chatStore[key])) {
    chatStore[key] = [];
    writeJson(CHAT_FILE, chatStore);
  }

  const bulletinStore = getBulletinStore();
  if (!bulletinStore[key] || typeof bulletinStore[key] !== "object") {
    bulletinStore[key] = { ...defaultGlobalBulletin };
    writeJson(BULLETIN_FILE, bulletinStore);
  }
}

ensureJsonFile(ROOMS_FILE, defaultRooms);
ensureJsonFile(CHAT_FILE, createDefaultChatStore());
ensureJsonFile(BULLETIN_FILE, createDefaultBulletinStore());

app.get("/", (req, res) => {
  res.send("Stro Chievery server is running.");
});

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    app: "stro-chievery-server",
    status: "healthy",
    timestamp: new Date().toISOString(),
  });
});

app.get("/api/rooms", (req, res) => {
  const role = String(req.query.role || "viewer").toLowerCase();
  const rooms = getSafeRooms();
  const includeAccessCode = role === "host";

  res.json(rooms.map((room) => sanitizeRoomForClient(room, includeAccessCode)));
});

app.post("/api/rooms", (req, res) => {
  const name = typeof req.body.name === "string" ? req.body.name.trim() : "";
  const meta = typeof req.body.meta === "string" ? req.body.meta.trim() : "";
  const visibility = req.body.visibility === "private" ? "private" : "public";
  const accessCode =
    typeof req.body.accessCode === "string" ? req.body.accessCode.trim() : "";

  if (!name) {
    return res.status(400).json({ error: "Room name is required." });
  }

  if (visibility === "private" && !accessCode) {
    return res.status(400).json({ error: "Private rooms require an access code." });
  }

  const rooms = getSafeRooms();
  const duplicate = rooms.find(
    (room) => room.name.toLowerCase() === name.toLowerCase()
  );

  if (duplicate) {
    return res.status(400).json({ error: "A room with that name already exists." });
  }

  const newRoom = {
    id: nextRoomId(rooms),
    name,
    meta: meta || "New room • Ready",
    visibility,
    accessCode: visibility === "private" ? accessCode : "",
  };

  rooms.push(newRoom);
  writeJson(ROOMS_FILE, rooms);
  ensureRoomDataSlots(newRoom.id);

  res.status(201).json(sanitizeRoomForClient(newRoom, true));
});

app.put("/api/rooms/:id", (req, res) => {
  const roomId = Number(req.params.id);
  const name = typeof req.body.name === "string" ? req.body.name.trim() : "";
  const meta = typeof req.body.meta === "string" ? req.body.meta.trim() : "";
  const visibility = req.body.visibility === "private" ? "private" : "public";
  const accessCode =
    typeof req.body.accessCode === "string" ? req.body.accessCode.trim() : "";

  if (!roomId) {
    return res.status(400).json({ error: "Valid room id is required." });
  }

  if (!name) {
    return res.status(400).json({ error: "Room name is required." });
  }

  if (visibility === "private" && !accessCode) {
    return res.status(400).json({ error: "Private rooms require an access code." });
  }

  const rooms = getSafeRooms();
  const roomIndex = rooms.findIndex((room) => Number(room.id) === roomId);

  if (roomIndex === -1) {
    return res.status(404).json({ error: "Room not found." });
  }

  const duplicate = rooms.find(
    (room) =>
      Number(room.id) !== roomId &&
      room.name.toLowerCase() === name.toLowerCase()
  );

  if (duplicate) {
    return res.status(400).json({ error: "Another room already uses that name." });
  }

  rooms[roomIndex] = {
    ...rooms[roomIndex],
    name,
    meta: meta || "Updated room • Ready",
    visibility,
    accessCode: visibility === "private" ? accessCode : "",
  };

  writeJson(ROOMS_FILE, rooms);
  ensureRoomDataSlots(roomId);

  res.json(sanitizeRoomForClient(rooms[roomIndex], true));
});

app.delete("/api/rooms/:id", (req, res) => {
  const roomId = Number(req.params.id);

  if (!roomId) {
    return res.status(400).json({ error: "Valid room id is required." });
  }

  const rooms = getSafeRooms();
  const roomExists = rooms.some((room) => Number(room.id) === roomId);

  if (!roomExists) {
    return res.status(404).json({ error: "Room not found." });
  }

  if (rooms.length <= 1) {
    return res.status(400).json({ error: "At least one room must remain." });
  }

  const nextRooms = rooms.filter((room) => Number(room.id) !== roomId);
  writeJson(ROOMS_FILE, nextRooms);

  const chatStore = getChatStore();
  delete chatStore[String(roomId)];
  writeJson(CHAT_FILE, chatStore);

  const bulletinStore = getBulletinStore();
  delete bulletinStore[String(roomId)];
  writeJson(BULLETIN_FILE, bulletinStore);

  res.json({ ok: true, deletedId: roomId });
});

app.get("/api/chat", (req, res) => {
  const roomId = Number(req.query.roomId);

  if (!roomId || !ensureRoomIdExists(roomId)) {
    return res.status(400).json({ error: "Valid roomId is required." });
  }

  const chatStore = getChatStore();
  const roomMessages = Array.isArray(chatStore[String(roomId)])
    ? chatStore[String(roomId)]
    : [];

  const normalized = normalizeChatMessages(roomMessages).sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
  );

  res.json(normalized);
});

app.post("/api/chat", (req, res) => {
  const roomId = Number(req.body.roomId);
  const author = typeof req.body.author === "string" ? req.body.author.trim() : "";
  const role = typeof req.body.role === "string" ? req.body.role.trim() : "Host";
  const text = typeof req.body.text === "string" ? req.body.text.trim() : "";

  if (!roomId || !ensureRoomIdExists(roomId)) {
    return res.status(400).json({ error: "Valid roomId is required." });
  }

  if (!text) {
    return res.status(400).json({ error: "Message text is required." });
  }

  const chatStore = getChatStore();
  const key = String(roomId);
  const safeChat = Array.isArray(chatStore[key]) ? chatStore[key] : [];

  const newMessage = {
    id: Date.now(),
    author: author || "You",
    role: role || "Host",
    text,
    createdAt: new Date().toISOString(),
  };

  safeChat.push(newMessage);
  chatStore[key] = safeChat;
  writeJson(CHAT_FILE, chatStore);

  res.status(201).json({
    ...newMessage,
    time: formatRelativeTime(newMessage.createdAt),
  });
});

app.get("/api/bulletin", (req, res) => {
  const roomId = Number(req.query.roomId);

  if (!roomId || !ensureRoomIdExists(roomId)) {
    return res.status(400).json({ error: "Valid roomId is required." });
  }

  const bulletinStore = getBulletinStore();
  const bulletin = bulletinStore[String(roomId)] || { ...defaultGlobalBulletin };

  res.json({
    fileName: typeof bulletin.fileName === "string" ? bulletin.fileName : "",
    status: typeof bulletin.status === "string" ? bulletin.status : defaultGlobalBulletin.status,
    text: typeof bulletin.text === "string" ? bulletin.text : defaultGlobalBulletin.text,
    updatedAt: bulletin.updatedAt || defaultGlobalBulletin.updatedAt,
  });
});

app.post("/api/bulletin", (req, res) => {
  const roomId = Number(req.body.roomId);
  const fileName =
    typeof req.body.fileName === "string" ? req.body.fileName.trim() : "";
  const text =
    typeof req.body.text === "string" ? req.body.text : "";

  if (!roomId || !ensureRoomIdExists(roomId)) {
    return res.status(400).json({ error: "Valid roomId is required." });
  }

  const nextBulletin = {
    fileName,
    status: fileName ? `Loaded bulletin file: ${fileName}` : "Bulletin updated.",
    text: text.trim().length > 0 ? text : "The selected bulletin file was empty.",
    updatedAt: new Date().toISOString(),
  };

  const bulletinStore = getBulletinStore();
  bulletinStore[String(roomId)] = nextBulletin;
  writeJson(BULLETIN_FILE, bulletinStore);

  res.status(201).json(nextBulletin);
});

app.listen(PORT, "127.0.0.1", () => {
  console.log(`Stro Chievery server listening on http://127.0.0.1:${PORT}`);
});