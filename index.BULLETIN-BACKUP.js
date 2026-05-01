const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 8787;

const DATA_DIR = __dirname;
const ROOMS_FILE = path.join(DATA_DIR, "rooms.json");
const CHAT_FILE = path.join(DATA_DIR, "chat.json");

const defaultRooms = [
  { id: 1, name: "Main Convention Hall", meta: "245 watching • Host ready • Main stage" },
  { id: 2, name: "Leadership Forum", meta: "82 watching • Panel session • Waiting room open" },
  { id: 3, name: "Youth Experience", meta: "128 watching • Interactive session • Music cue loaded" },
  { id: 4, name: "Prayer Chapel", meta: "34 watching • Quiet room • Reflection mode" },
  { id: 5, name: "Study Hall", meta: "56 watching • Notes available • Breakout learning" },
  { id: 6, name: "Speaker Green Room", meta: "12 watching • Private prep • Speakers waiting" },
  { id: 7, name: "Admin Operations", meta: "9 watching • Moderator desk • Control center" },
  { id: 8, name: "Auxiliary Room A", meta: "23 watching • Overflow feed • Support session" },
];

const defaultChat = [
  {
    id: 1,
    author: "Convention Desk",
    role: "Moderator",
    time: "Just now",
    text: "Welcome to Stro Chievery. Layout shell is back online.",
    createdAt: new Date().toISOString(),
  },
  {
    id: 2,
    author: "Production",
    role: "Support",
    time: "1 min ago",
    text: "Screen share dock box is now restored.",
    createdAt: new Date(Date.now() - 60 * 1000).toISOString(),
  },
];

app.use(cors());
app.use(express.json());

function ensureJsonFile(filePath, fallbackData) {
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, JSON.stringify(fallbackData, null, 2), "utf8");
    return;
  }

  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      fs.writeFileSync(filePath, JSON.stringify(fallbackData, null, 2), "utf8");
    }
  } catch {
    fs.writeFileSync(filePath, JSON.stringify(fallbackData, null, 2), "utf8");
  }
}

function readJsonArray(filePath, fallbackData) {
  ensureJsonFile(filePath, fallbackData);

  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : fallbackData;
  } catch {
    return fallbackData;
  }
}

function writeJsonArray(filePath, data) {
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

ensureJsonFile(ROOMS_FILE, defaultRooms);
ensureJsonFile(CHAT_FILE, defaultChat);

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
  const rooms = readJsonArray(ROOMS_FILE, defaultRooms);
  res.json(rooms);
});

app.get("/api/chat", (req, res) => {
  const chat = readJsonArray(CHAT_FILE, defaultChat);
  const normalized = normalizeChatMessages(chat).sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
  );
  res.json(normalized);
});

app.post("/api/chat", (req, res) => {
  const author = typeof req.body.author === "string" ? req.body.author.trim() : "";
  const role = typeof req.body.role === "string" ? req.body.role.trim() : "Host";
  const text = typeof req.body.text === "string" ? req.body.text.trim() : "";

  if (!text) {
    return res.status(400).json({ error: "Message text is required." });
  }

  const chat = readJsonArray(CHAT_FILE, defaultChat);

  const newMessage = {
    id: Date.now(),
    author: author || "You",
    role: role || "Host",
    text,
    createdAt: new Date().toISOString(),
  };

  chat.push(newMessage);
  writeJsonArray(CHAT_FILE, chat);

  res.status(201).json({
    ...newMessage,
    time: formatRelativeTime(newMessage.createdAt),
  });
});

app.listen(PORT, "127.0.0.1", () => {
  console.log(`Stro Chievery server listening on http://127.0.0.1:${PORT}`);
});