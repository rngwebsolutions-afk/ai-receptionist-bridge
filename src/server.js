// ==============================
// AI Receptionist Bridge (Render + Twilio + ElevenLabs)
// ==============================

import express from "express";
import WebSocket, { WebSocketServer } from "ws";
import dotenv from "dotenv";
import { decode } from "mulaw-js";
import convert from "pcm-convert";

dotenv.config();

const app = express();
app.use(express.json());

// ====== CONFIG ======
const PORT = process.env.PORT || 10000;
const ELEVEN_AGENT_ID = process.env.ELEVENLABS_AGENT_ID;
const ELEVEN_API_KEY = process.env.ELEVENLABS_API_KEY;
// =====================

app.get("/", (_, res) => {
  res.send("🤖 AI Receptionist Bridge is running on Render!");
});

// Create HTTP server and WebSocket endpoint for Twilio
const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server live on port ${PORT}`);
});

const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  if (req.url === "/stream") {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  }
});

// Convert Twilio audio (μ-law 8kHz) → PCM16 16kHz for ElevenLabs
function twilioToPcm16(base64) {
  try {
    const mulawBuffer = Buffer.from(base64, "base64");
    const pcm8 = decode(mulawBuffer);
    const pcm16 = convert(pcm8, { fromRate: 8000, toRate: 16000 });
    return pcm16;
  } catch (err) {
    console.error("⚠️ Audio conversion error:", err.message);
    return null;
  }
}

// Handle WebSocket connection from Twilio Media Stream
wss.on("connection", (twilioSocket) => {
  console.log("📞 Twilio connected to /stream");

  let elevenSocket = null;
  let elReady = false;
  let twilioBuffer = [];

  // Connect to ElevenLabs Realtime API
  console.log("🧠 Connecting to ElevenLabs Agent API...");
  elevenSocket = new WebSocket(
    `wss://api.elevenlabs.io/v1/convai/conversation?agent_id=${ELEVEN_AGENT_ID}`,
    { headers: { "xi-api-key": ELEVEN_API_KEY } }
  );

  elevenSocket.on("open", () => {
    console.log("🧠 Connected to ElevenLabs API");
    elReady = true;

    // Send buffered Twilio audio once ready
    if (twilioBuffer.length > 0) {
      console.log(`🚀 Sending ${twilioBuffer.length} buffered chunks to ElevenLabs...`);
      twilioBuffer.forEach((chunk) => elevenSocket.send(chunk));
      twilioBuffer = [];
    }
  });

  // Handle messages from ElevenLabs
  elevenSocket.on("message", (msg) => {
    try {
      const data = JSON.parse(msg.toString());

      if (data.agent_output_audio_chunk) {
        const audioB64 = data.agent_output_audio_chunk.audio_chunk;
        twilioSocket.send(JSON.stringify({ event: "media", media: { payload: audioB64 } }));
        console.log("🎧 Sent ElevenLabs audio back to Twilio");
      }

      if (data.agent_output_audio_end) {
        twilioSocket.send(JSON.stringify({ event: "mark", name: "el_audio_end" }));
        console.log("✅ ElevenLabs finished speaking");
      }
    } catch (err) {
      console.error("❌ ElevenLabs message parse error:", err);
    }
  });

  elevenSocket.on("close", () => {
    console.log("❌ ElevenLabs socket closed");
    twilioSocket.close();
  });

  elevenSocket.on("error", (err) => {
    console.error("❌ ElevenLabs connection error:", err.message);
  });

  // Handle Twilio media events
  twilioSocket.on("message", (msg) => {
    const data = JSON.parse(msg.toString());

    if (data.event === "start") {
      console.log(`▶️ Twilio stream started: ${data.start.streamSid}`);
    }

    if (data.event === "media") {
      const pcm16 = twilioToPcm16(data.media.payload);
      if (!pcm16) return;

      const base64Pcm = Buffer.from(pcm16).toString("base64");
      const chunk = JSON.stringify({ type: "input_audio_buffer.append", audio_chunk: base64Pcm });

      if (elReady && elevenSocket.readyState === WebSocket.OPEN) {
        elevenSocket.send(chunk);
      } else {
        twilioBuffer.push(chunk);
        console.log("⚠️ Buffering Twilio audio (ElevenLabs not ready)");
      }
    }

    if (data.event === "stop") {
      console.log("⏹️ Twilio stream stopped");

      if (elevenSocket && elevenSocket.readyState === WebSocket.OPEN) {
        elevenSocket.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
        elevenSocket.send(JSON.stringify({ type: "response.create" }));
      }
    }
  });

  twilioSocket.on("close", () => {
    console.log("❌ Twilio WebSocket closed");
    if (elevenSocket && elevenSocket.readyState === WebSocket.OPEN) {
      elevenSocket.close();
    }
  });

  twilioSocket.on("error", (err) => {
    console.error("❌ Twilio socket error:", err.message);
  });
});

// Graceful shutdown
process.on("SIGINT", () => {
  console.log("🛑 Shutting down server...");
  server.close(() => process.exit(0));
});
