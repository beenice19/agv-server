require("dotenv").config();

const express = require("express");
const cors = require("cors");
const { AccessToken } = require("livekit-server-sdk");

const app = express();

app.use(cors());
app.use(express.json());

const PORT = Number(process.env.LIVEKIT_TOKEN_PORT || 8790);

function cleanRoomName(value) {
  return String(value || "main-hall")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-_]/g, "-")
    .slice(0, 80);
}

function cleanIdentity(value) {
  return String(value || `guest-${Date.now()}`)
    .trim()
    .replace(/[^a-zA-Z0-9-_@.]/g, "-")
    .slice(0, 80);
}

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "AGV LiveKit Token Server",
    livekitConfigured: Boolean(
      process.env.LIVEKIT_URL &&
      process.env.LIVEKIT_API_KEY &&
      process.env.LIVEKIT_API_SECRET
    ),
  });
});

app.post("/api/livekit/token", async (req, res) => {
  try {
    const {
      roomName = "main-hall",
      identity,
      name,
      role = "viewer",
    } = req.body || {};

    if (
      !process.env.LIVEKIT_URL ||
      !process.env.LIVEKIT_API_KEY ||
      !process.env.LIVEKIT_API_SECRET
    ) {
      return res.status(500).json({
        ok: false,
        error: "LiveKit environment variables are missing.",
      });
    }

    const safeRoomName = cleanRoomName(roomName);
    const safeIdentity = cleanIdentity(identity || name);

    const isHost = role === "admin" || role === "host" || role === "moderator";

    const token = new AccessToken(
      process.env.LIVEKIT_API_KEY,
      process.env.LIVEKIT_API_SECRET,
      {
        identity: safeIdentity,
        name: String(name || safeIdentity),
        metadata: JSON.stringify({
          role,
          agvRoom: safeRoomName,
        }),
      }
    );

    token.addGrant({
      roomJoin: true,
      room: safeRoomName,
      canPublish: isHost,
      canSubscribe: true,
      canPublishData: true,
    });

    const participantToken = await token.toJwt();

    return res.status(201).json({
      ok: true,
      server_url: process.env.LIVEKIT_URL,
      participant_token: participantToken,
      roomName: safeRoomName,
      role,
      canPublish: isHost,
    });
  } catch (err) {
    console.error("LIVEKIT TOKEN ERROR:", err);
    return res.status(500).json({
      ok: false,
      error: "Failed to create LiveKit token.",
    });
  }
});

app.listen(PORT, () => {
  console.log(`AGV LIVEKIT TOKEN SERVER RUNNING ON ${PORT}`);
  console.log("LIVEKIT URL:", process.env.LIVEKIT_URL || "MISSING");
});