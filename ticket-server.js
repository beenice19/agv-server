const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");

const app = express();

const PORT = process.env.PORT || 8790;
const DATA_FILE = path.join(__dirname, "agv-tickets.json");

app.use(cors());
app.use(express.json());

function readTickets() {
  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, JSON.stringify({ tickets: [] }, null, 2));
  }

  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  } catch {
    return { tickets: [] };
  }
}

function writeTickets(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

function makeCode() {
  return "AGV-" + Math.random().toString(36).slice(2, 8).toUpperCase();
}

app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: "AGV Ticket Server",
    status: "online",
  });
});

app.get("/api/tickets/health", (req, res) => {
  res.json({
    ok: true,
    service: "AGV Ticket Server",
    status: "healthy",
  });
});

app.post("/api/tickets/create", (req, res) => {
  const data = readTickets();

  const ticket = {
    code: makeCode(),
    buyerName: req.body.buyerName || "Guest",
    buyerEmail: req.body.buyerEmail || "",
    eventName: req.body.eventName || "AGV Live Event",
    roomId: req.body.roomId || "main-hall",
    used: false,
    createdAt: new Date().toISOString(),
    usedAt: null,
  };

  data.tickets.push(ticket);
  writeTickets(data);

  res.json({ ok: true, ticket });
});

app.post("/api/tickets/verify", (req, res) => {
  const code = String(req.body.code || "").trim().toUpperCase();

  if (!code) {
    return res.status(400).json({
      ok: false,
      message: "Ticket code required.",
    });
  }

  const data = readTickets();
  const ticket = data.tickets.find(
    (t) => String(t.code).toUpperCase() === code
  );

  if (!ticket) {
    return res.status(404).json({
      ok: false,
      message: "Invalid ticket code.",
    });
  }

  ticket.used = true;
  ticket.usedAt = new Date().toISOString();
  writeTickets(data);

  res.json({
    ok: true,
    message: "Ticket verified.",
    ticket,
  });
});

app.get("/api/tickets/list", (req, res) => {
  res.json(readTickets());
});

app.listen(PORT, () => {
  console.log("AGV TICKET SERVER RUNNING ON", PORT);
  console.log("TICKET FILE:", DATA_FILE);
});