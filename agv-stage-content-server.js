const express = require("express");
const cors = require("cors");
const multer = require("multer");
const path = require("path");
const fs = require("fs");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = 8792;

// Storage folder
const uploadDir = path.join(__dirname, "stage-uploads");
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir);
}

// Multer config
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const safe = file.originalname.replace(/\s+/g, "-");
    cb(null, Date.now() + "-" + safe);
  },
});

const upload = multer({ storage });

// Health
app.get("/health", (req, res) => {
  res.json({ ok: true, service: "AGV Stage Content Server" });
});

// Upload
app.post("/upload", upload.single("file"), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ ok: false });
  }

  const url = `http://127.0.0.1:${PORT}/files/${req.file.filename}`;

  res.json({
    ok: true,
    url,
    name: req.file.originalname,
    type: req.file.mimetype,
  });
});

// Static serve
app.use("/files", express.static(uploadDir));

app.listen(PORT, () => {
  console.log("AGV STAGE CONTENT SERVER RUNNING ON", PORT);
});