const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");
const fs = require("fs");
const path = require("path");

const app = express();

app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));

app.use(express.json({ limit: "10mb" }));

const PORT = 8787;

const DATA_FILE = path.join(__dirname, "stro-cheivery-data.json");
const USERS_FILE = path.join(__dirname, "stro-cheivery-users.json");

function loadJSON(file, fallback) {
  try {
    if (!fs.existsSync(file)) {
      fs.writeFileSync(file, JSON.stringify(fallback, null, 2));
      return fallback;
    }
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    console.error("Failed to load JSON:", file, err.message);
    return fallback;
  }
}

function saveJSON(file, data) {
  try {
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error("Failed to save JSON:", file, err.message);
  }
}

const DEFAULT_ROOMS = [
  {
    id: "main-hall",
    name: "Main Hall",
    category: "Convention",
    host: "Admin",
    assignedHost: "Admin",
    moderators: ["Admin"],
    isPrivate: false,
    isLocked: false,
    bulletin: [],
    chat: []
  },
  {
    id: "studio-a",
    name: "Studio A",
    category: "Media",
    host: "Admin",
    assignedHost: "Admin",
    moderators: [],
    isPrivate: false,
    isLocked: false,
    bulletin: [],
    chat: []
  },
  {
    id: "radio-room",
    name: "Radio Room",
    category: "Broadcast",
    host: "Admin",
    assignedHost: "Admin",
    moderators: [],
    isPrivate: false,
    isLocked: false,
    bulletin: [],
    chat: []
  }
];

let rooms = loadJSON(DATA_FILE, DEFAULT_ROOMS);
let users = loadJSON(USERS_FILE, [
  {
    id: "admin",
    username: "admin",
    role: "superadmin",
    displayName: "Admin"
  }
]);

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

function getRoom(roomId) {
  return rooms.find((room) => room.id === roomId);
}

function saveRooms() {
  saveJSON(DATA_FILE, rooms);
}

app.get("/", (req, res) => {
  res.json({
    ok: true,
    name: "Stro Cheivery / Avant Global Vision Server",
    port: PORT
  });
});

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    rooms: rooms.length,
    users: users.length,
    timestamp: new Date().toISOString()
  });
});

app.get("/api/rooms", (req, res) => {
  res.json({
    ok: true,
    rooms
  });
});

app.post("/api/rooms", (req, res) => {
  const body = req.body || {};
  const name = String(body.name || "").trim();

  if (!name) {
    return res.status(400).json({ ok: false, error: "Room name required" });
  }

  const id = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || `room-${Date.now()}`;

  if (rooms.some((room) => room.id === id)) {
    return res.status(409).json({ ok: false, error: "Room already exists" });
  }

  const room = {
    id,
    name,
    category: body.category || "Custom",
    host: body.host || "Admin",
    assignedHost: body.assignedHost || body.host || "Admin",
    moderators: Array.isArray(body.moderators) ? body.moderators : [],
    isPrivate: Boolean(body.isPrivate),
    isLocked: Boolean(body.isLocked),
    bulletin: [],
    chat: []
  };

  rooms.push(room);
  saveRooms();

  io.emit("roomsUpdated", rooms);

  res.json({ ok: true, room });
});

app.put("/api/rooms/:roomId", (req, res) => {
  const room = getRoom(req.params.roomId);

  if (!room) {
    return res.status(404).json({ ok: false, error: "Room not found" });
  }

  Object.assign(room, req.body || {});
  saveRooms();

  io.emit("roomsUpdated", rooms);
  io.to(room.id).emit("roomUpdated", room);

  res.json({ ok: true, room });
});

app.delete("/api/rooms/:roomId", (req, res) => {
  const before = rooms.length;
  rooms = rooms.filter((room) => room.id !== req.params.roomId);

  if (rooms.length === before) {
    return res.status(404).json({ ok: false, error: "Room not found" });
  }

  saveRooms();
  io.emit("roomsUpdated", rooms);

  res.json({ ok: true });
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
  saveRooms();

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

  const item = {
    id: `bulletin-${Date.now()}`,
    text: req.body.text || req.body.message || "",
    createdAt: new Date().toISOString()
  };

  room.bulletin = room.bulletin || [];
  room.bulletin.push(item);
  saveRooms();

  io.to(room.id).emit("bulletinUpdated", room.bulletin);

  res.json({ ok: true, item, bulletin: room.bulletin });
});

app.delete("/api/rooms/:roomId/bulletin", (req, res) => {
  const room = getRoom(req.params.roomId);
  if (!room) return res.status(404).json({ ok: false, error: "Room not found" });

  room.bulletin = [];
  saveRooms();

  io.to(room.id).emit("bulletinUpdated", room.bulletin);

  res.json({ ok: true, bulletin: room.bulletin });
});

io.on("connection", (socket) => {
  console.log("SOCKET CONNECTED:", socket.id);

  socket.on("joinRoom", (payload = {}) => {
    const roomId = payload.roomId || payload.room || "main-hall";
    const username = payload.username || payload.user || "Guest";

    socket.join(roomId);

    socket.data.roomId = roomId;
    socket.data.username = username;

    socket.emit("roomsUpdated", rooms);

    io.to(roomId).emit("presenceUpdated", {
      roomId,
      username,
      socketId: socket.id,
      status: "joined"
    });
  });

  socket.on("leaveRoom", (payload = {}) => {
    const roomId = payload.roomId || socket.data.roomId;
    const username = payload.username || socket.data.username || "Guest";

    if (roomId) {
      socket.leave(roomId);
      io.to(roomId).emit("presenceUpdated", {
        roomId,
        username,
        socketId: socket.id,
        status: "left"
      });
    }
  });

  socket.on("chatMessage", (payload = {}) => {
    const roomId = payload.roomId || socket.data.roomId || "main-hall";
    const room = getRoom(roomId);

    const message = {
      id: `chat-${Date.now()}`,
      user: payload.user || payload.username || socket.data.username || "Guest",
      text: payload.text || payload.message || "",
      createdAt: new Date().toISOString()
    };

    if (room) {
      room.chat = room.chat || [];
      room.chat.push(message);
      saveRooms();
    }

    io.to(roomId).emit("chatMessage", message);
  });

  socket.on("bulletinUpdated", (payload = {}) => {
    const roomId = payload.roomId || socket.data.roomId || "main-hall";
    const room = getRoom(roomId);

    if (room) {
      room.bulletin = Array.isArray(payload.bulletin) ? payload.bulletin : room.bulletin || [];
      saveRooms();
      io.to(roomId).emit("bulletinUpdated", room.bulletin);
    }
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
    const roomId = socket.data.roomId;
    const username = socket.data.username || "Guest";

    if (roomId) {
      io.to(roomId).emit("presenceUpdated", {
        roomId,
        username,
        socketId: socket.id,
        status: "left"
      });
    }

    console.log("SOCKET DISCONNECTED:", socket.id);
  });
});

server.listen(PORT, () => {
  console.log("SERVER RUNNING ON", PORT);
  console.log("DATA FILE:", DATA_FILE);
  console.log("USERS FILE:", USERS_FILE);
});
