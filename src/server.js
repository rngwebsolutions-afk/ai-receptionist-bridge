import express from "express";
import http from "http";
import { WebSocketServer } from "ws";

const app = express(); // 👈 THIS is the missing line

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get("/", (_, res) => {
  res.send("✅ AI Receptionist Bridge is live and healthy.");
});

app.post("/twiml", (req, res) => {
  const streamUrl = `wss://${req.headers.host}/stream`;
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

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  console.log("✅ Twilio connected to WebSocket stream");
  ws.on("message", (msg) => console.log("Received:", msg.toString()));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
