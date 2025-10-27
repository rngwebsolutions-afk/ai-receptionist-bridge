// ==========================
// AI Receptionist Bridge Server
// ==========================

// Import dependencies
import express from "express";
import http from "http";
import { WebSocketServer } from "ws";

// Create Express app
const app = express();

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Root route (for sanity check)
app.get("/", (_, res) => {
  res.send("✅ AI Receptionist Bridge is live and healthy.");
});

// Twilio <Stream> route
app.post("/twiml", (req, res) => {
  const streamUrl = `wss://${req.headers.host}/stream`;
  console.log(`📡 Sending TwiML response for stream: ${streamUrl}`);

  const twiml = `
    <?xml version="1.0" encoding="UTF-8"?>
    <Response>
      <Say>Connecting you to your AI receptionist. Please hold.</Say>
      <Connect>
        <Stream url="${streamUrl}" />
      </Connect>
    </Response>
  `;

  res.type("text/xml");
  res.send(twiml);
});

// WebSocket setup
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  console.log("✅ Twilio connected to WebSocket stream");
  ws.on("message", (message) => console.log("Received:", message.toString()));
});

// Start the server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
