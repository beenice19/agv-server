// PASS_SERVER_8790_CLEAN_LOCAL_CAMERA_RECOVERY_1A
// SERVER 8790 — Clean AGV LiveKit Token Server.
// Purpose: restore Creator camera. This server does NOT call the Free Token Wallet Gate.

require("dotenv").config();

const express = require("express");
const cors = require("cors");
const { AccessToken } = require("livekit-server-sdk");

const app = express();

const PORT = Number(process.env.LIVEKIT_TOKEN_PORT || process.env.PORT || 8790);
const LIVEKIT_URL = process.env.LIVEKIT_URL || process.env.VITE_LIVEKIT_URL || "";
const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY || "";
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET || "";

// PASS_SERVER_8790_USAGE_WALLET_BROADCAST_GATE_1A
// SERVER 8790 — before issuing a publisher LiveKit token, check/debit the AGV usage wallet.
const USAGE_WALLET_API_BASE =
  process.env.AGV_USAGE_WALLET_API_URL ||
  process.env.VITE_AGV_FREE_TOKEN_API_URL ||
  process.env.FREE_TOKEN_API_BASE ||
  "http://127.0.0.1:8794";

app.use(cors({
  origin: true,
  credentials: false,
}));

app.use(express.json({ limit: "1mb" }));

function cleanString(value, fallback = "") {
  const text = String(value || "").trim();
  return text || fallback;
}

function normalizePlan(value) {
  const plan = String(value || "CREATOR").trim().toUpperCase();
  if (["FREE", "CREATOR", "MINISTRY", "PRO", "CONVENTION", "OWNER_ADMIN", "ADMIN"].includes(plan)) {
    return plan;
  }
  return "CREATOR";
}

function rolePermissions(role) {
  const cleanRole = String(role || "host").trim().toLowerCase();

  if (cleanRole === "viewer") {
    return {
      roomJoin: true,
      canSubscribe: true,
      canPublish: false,
      canPublishData: true,
    };
  }

  return {
    roomJoin: true,
    canSubscribe: true,
    canPublish: true,
    canPublishData: true,
  };
}

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "AGV Clean LiveKit Token Server",
    port: PORT,
    livekitConfigured: Boolean(LIVEKIT_URL && LIVEKIT_API_KEY && LIVEKIT_API_SECRET),
    freeTokenGate: "enabled-server-side-wallet-gate",
    usageWalletApiBase: USAGE_WALLET_API_BASE,
  });
});


async function requireUsageWalletBeforeLiveToken({ identity, plan, role, roomName }) {
  const cleanPlan = normalizePlan(plan);
  const cleanRole = String(role || "host").trim().toLowerCase();

  // Viewers do not publish camera/screen, so they do not burn host live tokens.
  if (cleanRole === "viewer") {
    return { ok: true, skipped: true, reason: "viewer-token" };
  }

  // Admin bypass stays available for platform recovery.
  if (cleanPlan === "OWNER_ADMIN" || cleanPlan === "ADMIN") {
    return { ok: true, skipped: true, reason: "admin-bypass" };
  }

  const body = {
    userId: identity || "agv-host-local",
    plan: cleanPlan,
    roomId: roomName || "main-hall",
    sessionId: "server-token-gate-" + Date.now(),
    seconds: 60,
    viewerCount: 0,
    screenShare: false,
  };

  let response;
  let data;

  try {
    response = await fetch(USAGE_WALLET_API_BASE + "/api/usage/live-debit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    data = await response.json().catch(() => null);
  } catch (error) {
    return {
      ok: false,
      status: 503,
      error: "USAGE_WALLET_UNREACHABLE",
      message:
        "AGV usage wallet server is unavailable. Broadcast token was not issued.",
      details: error?.message || String(error),
    };
  }

  if (!response.ok || !data?.ok) {
    return {
      ok: false,
      status: response.status || 402,
      error: data?.error || "USAGE_WALLET_BLOCKED",
      message:
        data?.message ||
        "AGV usage wallet did not approve this broadcast token.",
      wallet: data?.wallet || null,
      data,
    };
  }

  return {
    ok: true,
    status: response.status,
    debited: Boolean(data.debited),
    tokensDebited: Number(data.tokensDebited || 0),
    remainingTokens: Number(data.remainingTokens ?? data.wallet?.liveTokensBalance ?? data.wallet?.balance ?? 0),
    wallet: data.wallet || null,
  };
}

app.post("/api/livekit/token", async (req, res) => {
  try {
    if (!LIVEKIT_URL || !LIVEKIT_API_KEY || !LIVEKIT_API_SECRET) {
      return res.status(503).json({
        ok: false,
        error: "LIVEKIT_NOT_CONFIGURED",
        message: "LiveKit credentials are missing on SERVER 8790.",
      });
    }

    const body = req.body || {};

    const roomName = cleanString(
      body.roomName ||
        body.room ||
        body.roomId ||
        body.selectedRoomId,
      "main-hall"
    );

    const role = cleanString(body.role || body.nextRole || body.participantRole, "host");

    const identity = cleanString(
      body.identity ||
        body.userId ||
        body.ownerId ||
        body.participantId ||
        body.email ||
        (role === "viewer" ? "agv-viewer-local" : "agv-host-local"),
      role === "viewer" ? "agv-viewer-local" : "agv-host-local"
    );

    const name = cleanString(
      body.name ||
        body.displayName ||
        body.ownerName ||
        body.email ||
        identity,
      identity
    );

    const plan = normalizePlan(
      body.plan ||
        body.currentPlan ||
        body.createdByPlan ||
        body.accountPlan ||
        body.viewerPlan ||
        "CREATOR"
    );

    const walletGate = await requireUsageWalletBeforeLiveToken({
      identity,
      plan,
      role,
      roomName,
    });

    if (!walletGate.ok) {
      return res.status(walletGate.status || 402).json({
        ok: false,
        error: walletGate.error || "BROADCAST_WALLET_GATE_BLOCKED",
        message: walletGate.message || "AGV usage wallet blocked this broadcast token.",
        walletGate,
        service: "AGV Clean LiveKit Token Server",
      });
    }

    const token = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
      identity,
      name,
    });

    token.addGrant({
      room: roomName,
      ...rolePermissions(role),
    });

    const jwt = await token.toJwt();

    return res.json({
      ok: true,
      token: jwt,
      jwt,
      url: LIVEKIT_URL,
      livekitUrl: LIVEKIT_URL,
      wsUrl: LIVEKIT_URL,
      room: roomName,
      roomName,
      roomId: roomName,
      identity,
      name,
      role,
      plan,
      walletGate,
      freeTokenGateBypassed: false,
      service: "AGV Clean LiveKit Token Server",
    });
  } catch (error) {
    console.error("SERVER 8790 TOKEN ERROR:", error);
    return res.status(500).json({
      ok: false,
      error: "LIVEKIT_TOKEN_ERROR",
      message: error?.message || String(error),
    });
  }
});

app.listen(PORT, "127.0.0.1", () => {
  console.log("AGV Clean LiveKit Token Server running on " + PORT);
  console.log("LiveKit configured:", Boolean(LIVEKIT_URL && LIVEKIT_API_KEY && LIVEKIT_API_SECRET));
  console.log("Free Token Gate: disabled for local Creator camera recovery");
});
