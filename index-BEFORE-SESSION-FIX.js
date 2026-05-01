const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = 8787;

app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));

app.use(express.json({ limit: "10mb" }));

const DATA_FILE = path.join(__dirname, "stro-cheivery-data.json");
const USERS_FILE = path.join(__dirname, "stro-cheivery-users.json");

function readJSON(file, fallback) {
  try {
    if (!fs.existsSync(file)) {
      fs.writeFileSync(file, JSON.stringify(fallback, null, 2));
      return fallback;
    }
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    console.log("JSON READ ERROR:", file, err.message);
    return fallback;
  }
}

function writeJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
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

const DEFAULT_USERS = [
  {
    id: "admin",
    username: "admin",
    email: "admin@agv.local",
    password: "ElizabethT96#",
    role: "superadmin",
    displayName: "Admin"
  },
  {
    id: "viewer",
    username: "viewer",
    email: "viewer@agv.local",
    password: "viewer123",
    role: "viewer",
    displayName: "Viewer"
  }
];

let rooms = readJSON(DATA_FILE, DEFAULT_ROOMS);
let users = readJSON(USERS_FILE, DEFAULT_USERS);

function saveRooms() {
  writeJSON(DATA_FILE, rooms);
}

function saveUsers() {
  writeJSON(USERS_FILE, users);
}

function normalizeUsers() {
  if (!Array.isArray(users)) users = [];

  const hasAdmin = users.some((u) => String(u.username || "").toLowerCase() === "admin");

  if (!hasAdmin) {
    users.unshift(DEFAULT_USERS[0]);
  }

  users = users.map((u) => {
    if (String(u.username || "").toLowerCase() === "admin") {
      return {
        ...u,
        id: u.id || "admin",
        username: "admin",
        email: u.email || "admin@agv.local",
        password: "ElizabethT96#",
        role: "superadmin",
        displayName: u.displayName || "Admin"
      };
    }

    return {
      ...u,
      id: u.id || `user-${Date.now()}`,
      username: u.username || u.name || u.email || "user",
      email: u.email || "",
      password: u.password || u.pass || "viewer123",
      role: u.role || "viewer",
      displayName: u.displayName || u.name || u.username || "User"
    };
  });

  saveUsers();
}

normalizeUsers();

function publicUser(user) {
  return {
    id: user.id,
    username: user.username,
    email: user.email || "",
    name: user.displayName || user.username,
    displayName: user.displayName || user.username,
    role: user.role || "viewer",
    isSuperAdmin: user.role === "superadmin",
    isAdmin: user.role === "superadmin" || user.role === "admin",
    permissions: {
      canView: true,
      canChat: true,
      canUseBulletin: true,
      canControlRooms: user.role === "superadmin" || user.role === "admin" || user.role === "host",
      canUseDrive: user.role === "superadmin" || user.role === "admin",
      canUseControlCenter: user.role === "superadmin" || user.role === "admin"
    }
  };
}

function loginHandler(req, res) {
  const body = req.body || {};

  const login =
    String(body.username || body.email || body.account || body.name || "").trim().toLowerCase();

  const password =
    String(body.password || body.pass || body.code || body.inviteCode || "").trim();

  const user = users.find((u) => {
    const username = String(u.username || "").toLowerCase();
    const email = String(u.email || "").toLowerCase();
    return username === login || email === login;
  });

  if (!user) {
    return res.status(401).json({
      ok: false,
      success: false,
      error: "Login failed"
    });
  }

  const storedPassword = String(user.password || user.pass || "").trim();

  if (storedPassword !== password) {
    return res.status(401).json({
      ok: false,
      success: false,
      error: "Login failed"
    });
  }

  const cleanUser = publicUser(user);

  return res.json({
    ok: true,
    success: true,
    token: "safe-pass-6-token",
    accessToken: "safe-pass-6-token",
    user: cleanUser,
    account: cleanUser
  });
}

function getRoom(roomId) {
  return rooms.find((room) => room.id === roomId);
}

app.get("/", (req, res) => {
  res.json({
    ok: true,
    name: "Avant Global Vision / Stro Cheivery Server",
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

app.post("/api/auth/login", loginHandler);
app.post("/api/login", loginHandler);
app.post("/auth/login", loginHandler);
app.post("/login", loginHandler);

app.get("/api/users", (req, res) => {
  res.json({
    ok: true,
    users: users.map(publicUser)
  });
});

app.get("/api/rooms", (req, res) => {
  res.json({
    ok: true,
    rooms
  });
});

app.post("/api/rooms", (req, res) => {
  const name = String(req.body.name || "").trim();

  if (!name) {
    return res.status(400).json({ ok: false, error: "Room name required" });
  }

  const id =
    name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") ||
    `room-${Date.now()}`;

  if (rooms.some((room) => room.id === id)) {
    return res.status(409).json({ ok: false, error: "Room already exists" });
  }

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

app.get("/api/rooms/:roomId/chat", (req, res) => {
  const room = getRoom(req.params.roomId);

  if (!room) {
    return res.status(404).json({ ok: false, error: "Room not found" });
  }

  res.json({ ok: true, chat: room.chat || [] });
});

app.post("/api/rooms/:roomId/chat", (req, res) => {
  const room = getRoom(req.params.roomId);

  if (!room) {
    return res.status(404).json({ ok: false, error: "Room not found" });
  }

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

  if (!room) {
    return res.status(404).json({ ok: false, error: "Room not found" });
  }

  res.json({ ok: true, bulletin: room.bulletin || [] });
});

app.post("/api/rooms/:roomId/bulletin", (req, res) => {
  const room = getRoom(req.params.roomId);

  if (!room) {
    return res.status(404).json({ ok: false, error: "Room not found" });
  }

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

  if (!room) {
    return res.status(404).json({ ok: false, error: "Room not found" });
  }

  room.bulletin = [];
  saveRooms();

  io.to(room.id).emit("bulletinUpdated", room.bulletin);

  res.json({ ok: true, bulletin: room.bulletin });
});

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
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
    io.to(roomId).emit("chatMessage", payload);
  });

  socket.on("bulletinUpdated", (payload = {}) => {
    const roomId = payload.roomId || socket.data.roomId || "main-hall";
    const room = getRoom(roomId);

    if (room) {
      room.bulletin = Array.isArray(payload.bulletin)
        ? payload.bulletin
        : room.bulletin || [];

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
