require("dotenv").config();

const express = require("express");
const cors = require("cors");
const { AccessToken } = require("livekit-server-sdk");

const app = express();

app.use(cors());
app.use(express.json());

const PORT = Number(process.env.LIVEKIT_TOKEN_PORT || 8790);

// PASS_FREE_TOKEN_GATE_8790_1A
// SERVER — Free-tier token wallet gate for LiveKit token issuance.
const FREE_TOKEN_API_BASE =
  process.env.AGV_FREE_TOKEN_API_BASE || "http://127.0.0.1:8794";

async function getFreeTokenWallet(userId, plan) {
  const safeUserId = encodeURIComponent(String(userId || "local-free-user"));
  const safePlan = encodeURIComponent(String(plan || "FREE").toUpperCase());

  const response = await fetch(
    FREE_TOKEN_API_BASE + "/api/free-tokens/wallet?userId=" + safeUserId + "&plan=" + safePlan
  );

  const data = await response.json().catch(() => null);

  if (!response.ok || !data?.ok) {
    throw new Error(data?.message || data?.error || "Free token wallet unavailable.");
  }

  return data;
}

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
    freeTokenGate: true,
    freeTokenApiBase: FREE_TOKEN_API_BASE,
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

    // PASS_FREE_TOKEN_GATE_8790_1A
    // SERVER — do not issue host/publisher LiveKit tokens to exhausted Free users.
    const requestedPlan = String(
      req.body?.plan ||
      req.body?.currentPlan ||
      req.body?.accountPlan ||
      "FREE"
    ).toUpperCase();

    const freeTokenUserId = String(
      req.body?.userId ||
      req.body?.agvUserId ||
      req.body?.ownerId ||
      "local-free-user"
    );

    const isFreeTokenCheckedHost =
      isHost && requestedPlan === "FREE" && role !== "viewer";

    if (isFreeTokenCheckedHost) {
      try {
        const walletData = await getFreeTokenWallet(freeTokenUserId, requestedPlan);
        const balance = Number(walletData?.wallet?.balance || 0);

        if (balance <= 0) {
          return res.status(402).json({
            ok: false,
            blocked: true,
            reason: "FREE_AGV_LIVE_TOKENS_EXHAUSTED",
            error: "Free AGV Live Tokens are exhausted. Upgrade to continue broadcasting.",
            wallet: walletData?.wallet || null,
          });
        }
      } catch (gateError) {
        return res.status(503).json({
          ok: false,
          blocked: true,
          reason: "FREE_TOKEN_GATE_UNAVAILABLE",
          error:
            "Free token wallet gate is unavailable. Start AGV Free Token Server 8794 or upgrade to continue broadcasting.",
          detail: gateError?.message || String(gateError),
        });
      }
    }

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