const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = 8787;

app.use(cors({ origin: "*", methods: ["GET","POST","PUT","DELETE","OPTIONS"], allowedHeaders: ["Content-Type","Authorization"] }));
app.use(express.json({ limit: "10mb" }));

const DATA_FILE = path.join(__dirname, "stro-cheivery-data.json");
const USERS_FILE = path.join(__dirname, "stro-cheivery-users.json");

function loadJSON(file, fallback) {
  try {
    if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify(fallback, null, 2));
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function saveJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

const DEFAULT_USERS = [
  { id: "admin", username: "admin", password: "ElizabethT96#", role: "superadmin", displayName: "Admin" },
  { id: "host", username: "host", password: "host123", role: "host", displayName: "Host" },
  { id: "viewer", username: "viewer", password: "viewer123", role: "viewer", displayName: "Viewer" }
];

const DEFAULT_ROOMS = [
  { id: "main-hall", name: "Main Hall", category: "Convention", host: "Admin", assignedHost: "Admin", moderators: ["Admin"], isPrivate: false, isLocked: false, bulletin: [], chat: [] },
  { id: "studio-a", name: "Studio A", category: "Media", host: "Admin", assignedHost: "Admin", moderators: [], isPrivate: false, isLocked: false, bulletin: [], chat: [] },
  { id: "radio-room", name: "Radio Room", category: "Broadcast", host: "Admin", assignedHost: "Admin", moderators: [], isPrivate: false, isLocked: false, bulletin: [], chat: [] }
];

let users = loadJSON(USERS_FILE, DEFAULT_USERS);
let rooms = loadJSON(DATA_FILE, DEFAULT_ROOMS);

function getRoom(roomId) {
  return rooms.find(r => r.id === roomId);
}

app.get("/", (req, res) => res.json({ ok: true, name: "AGV Server", port: PORT }));

app.get("/api/health", (req, res) => {
  res.json({ ok: true, rooms: rooms.length, users: users.length, timestamp: new Date().toISOString() });
});

app.post("/api/auth/login", (req, res) => {
  const username = String(req.body.username || "").trim();
  const password = String(req.body.password || "").trim();

  const user = users.find(u => String(u.username).toLowerCase() === username.toLowerCase());

  if (!user || String(user.password) !== password) {
    return res.status(401).json({ ok: false, error: "Login failed" });
  }

  res.json({
    ok: true,
    token: "safe-pass-6-token",
    user: {
      id: user.id,
      username: user.username,
      role: user.role,
      displayName: user.displayName || user.username
    }
  });
});

app.get("/api/rooms", (req, res) => res.json({ ok: true, rooms }));

app.post("/api/rooms", (req, res) => {
  const name = String(req.body.name || "").trim();
  if (!name) return res.status(400).json({ ok: false, error: "Room name required" });

  const id = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || `room-${Date.now()}`;
  if (rooms.some(r => r.id === id)) return res.status(409).json({ ok: false, error: "Room already exists" });

  const room = {
    id,
    name,
    category: req.body.category || "Custom",
    host: req.body.host || "Admin",
    assignedHost: req.body.assignedHost || req.body.host || "Admin",
    moderators: Array.isArray(req.body.moderators) ? req.body.moderators : [],
    isPrivate: Boolean(req.body.isPrivate),
    isLocked: Boolean(req.body.isLocked),
    bulletin: [],
    chat: []
  };

  rooms.push(room);
  saveJSON(DATA_FILE, rooms);
  io.emit("roomsUpdated", rooms);
  res.json({ ok: true, room });
});

app.put("/api/rooms/:roomId", (req, res) => {
  const room = getRoom(req.params.roomId);
  if (!room) return res.status(404).json({ ok: false, error: "Room not found" });

  Object.assign(room, req.body || {});
  saveJSON(DATA_FILE, rooms);
  io.emit("roomsUpdated", rooms);
  io.to(room.id).emit("roomUpdated", room);
  res.json({ ok: true, room });
});

app.get("/api/rooms/:roomId/chat", (req, res) => {
  const room = getRoom(req.params.roomId);
  if (!room) return res.status(404).json({ ok: false, error: "Room not found" });
  res.json({ ok: true, chat: room.chat || [] });
});

app.post("/api/rooms/:roomId/chat", (req, res) => {
  const room = getRoom(req.params.roomId);
  if (!room) return res.status(404).json({ ok: false, error: "Room not found" });

  const message = {
    id: `chat-${Date.now()}`,
    user: req.body.user || req.body.username || "Guest",
    text: req.body.text || req.body.message || "",
    createdAt: new Date().toISOString()
  };

  room.chat = room.chat || [];
  room.chat.push(message);
  saveJSON(DATA_FILE, rooms);
  io.to(room.id).emit("chatMessage", message);
  res.json({ ok: true, message });
});

app.get("/api/rooms/:roomId/bulletin", (req, res) => {
  const room = getRoom(req.params.roomId);
  if (!room) return res.status(404).json({ ok: false, error: "Room not found" });
  res.json({ ok: true, bulletin: room.bulletin || [] });
});

app.post("/api/rooms/:roomId/bulletin", (req, res) => {
  const room = getRoom(req.params.roomId);
  if (!room) return res.status(404).json({ ok: false, error: "Room not found" });

  const item = { id: `bulletin-${Date.now()}`, text: req.body.text || req.body.message || "", createdAt: new Date().toISOString() };
  room.bulletin = room.bulletin || [];
  room.bulletin.push(item);
  saveJSON(DATA_FILE, rooms);
  io.to(room.id).emit("bulletinUpdated", room.bulletin);
  res.json({ ok: true, item, bulletin: room.bulletin });
});

const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: "*", methods: ["GET","POST"] }
});

io.on("connection", (socket) => {
  console.log("SOCKET CONNECTED:", socket.id);

  socket.on("joinRoom", (payload = {}) => {
    const roomId = payload.roomId || "main-hall";
    const username = payload.username || "Guest";
    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.username = username;
    socket.emit("roomsUpdated", rooms);
    io.to(roomId).emit("presenceUpdated", { roomId, username, socketId: socket.id, status: "joined" });
  });

  socket.on("chatMessage", (payload = {}) => {
    const roomId = payload.roomId || socket.data.roomId || "main-hall";
    io.to(roomId).emit("chatMessage", payload);
  });

  socket.on("stageState", (payload = {}) => {
    const roomId = payload.roomId || socket.data.roomId || "main-hall";
    socket.to(roomId).emit("stageState", payload);
  });

  socket.on("stageStream", (payload = {}) => {
    const roomId = payload.roomId || socket.data.roomId || "main-hall";
    socket.to(roomId).emit("stageStream", payload);
  });

  socket.on("mediaState", (payload = {}) => {
    const roomId = payload.roomId || socket.data.roomId || "main-hall";
    socket.to(roomId).emit("mediaState", payload);
  });

  socket.on("screenShareState", (payload = {}) => {
    const roomId = payload.roomId || socket.data.roomId || "main-hall";
    socket.to(roomId).emit("screenShareState", payload);
  });

  socket.on("disconnect", () => {
    console.log("SOCKET DISCONNECTED:", socket.id);
  });
});

server.listen(PORT, () => {
  console.log("SERVER RUNNING ON", PORT);
  console.log("DATA FILE:", DATA_FILE);
  console.log("USERS FILE:", USERS_FILE);
});
