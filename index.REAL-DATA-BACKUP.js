const express = require("express");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 8787;

app.use(cors());
app.use(express.json());

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
  res.json([
    { id: 1, name: "Main Convention Hall", meta: "245 watching • Host ready • Main stage" },
    { id: 2, name: "Leadership Forum", meta: "82 watching • Panel session • Waiting room open" },
    { id: 3, name: "Youth Experience", meta: "128 watching • Interactive session • Music cue loaded" },
    { id: 4, name: "Prayer Chapel", meta: "34 watching • Quiet room • Reflection mode" },
    { id: 5, name: "Study Hall", meta: "56 watching • Notes available • Breakout learning" },
    { id: 6, name: "Speaker Green Room", meta: "12 watching • Private prep • Speakers waiting" },
    { id: 7, name: "Admin Operations", meta: "9 watching • Moderator desk • Control center" },
    { id: 8, name: "Auxiliary Room A", meta: "23 watching • Overflow feed • Support session" },
  ]);
});

app.post("/api/chat", (req, res) => {
  const { message } = req.body || {};

  res.json({
    ok: true,
    echoedMessage: typeof message === "string" ? message : "",
    timestamp: new Date().toISOString(),
  });
});

app.listen(PORT, () => {
  console.log(`Stro Chievery server listening on http://127.0.0.1:${PORT}`);
});