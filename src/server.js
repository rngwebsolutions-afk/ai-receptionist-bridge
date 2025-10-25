// =======================
// AI Receptionist (Twilio <-> ElevenLabs)
// =======================

import dotenv from "dotenv";
dotenv.config();

import express from "express";
import WebSocket, { WebSocketServer } from "ws";
import { decode } from "mulaw-js";
import convert from "pcm-convert";

const app = express();
app.use(express.json());

// =============== CONFIG ==================
const PORT = process.env.PORT || 3000;
const ELEVEN_AGENT_ID = process.env.ELEVEN_AGENT_ID;        // e.g. agent_0401k81ckaqsfexr0xx53dghwffw
const ELEVEN_API_KEY = process.env.ELEVENLABS_API_KEY;      // private key
// =========================================

app.get("/", (_, res) => res.send("🤖 AI receptionist (ElevenLabs only) is online!"));

// ---------- Twilio WebSocket entry ----------
const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server listening on port ${PORT}`);
});

// Create local WebSocket endpoint that Twilio connects to
const wss = new WebSocketServer({ noServer: true });

// Upgrade HTTP → WS when Twilio connects
server.on("upgrade", (req, socket, head) => {
  if (req.url === "/stream") {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  }
});

// Twilio sends μ-law @8 kHz; ElevenLabs expects PCM16 @16 kHz
function twilioToPcm16(base64) {
  try {
    const mulawBuffer = Buffer.from(base64, "base64");
    const pcm8 = decode(mulawBuffer);
    const pcm16 = convert(pcm8, { fromRate: 8000, toRate: 16000 });
    return pcm16;
  } catch (err) {
    console.error("Audio conversion error:", err.message);
    return null;
  }
}

// -------------- HANDLE TWILIO STREAM -----------------
wss.on("connection", (twilioSocket) => {
  console.log("📞 Twilio connected to /stream");

  let elevenSocket = null;
  let elReady = false;
  let twilioBuffer = [];

  // Connect to ElevenLabs Agent Realtime API
  console.log("🧠 Connecting to ElevenLabs Agent Realtime API...");
  elevenSocket = new WebSocket(
    `wss://api.elevenlabs.io/v1/convai/conversation?agent_id=${ELEVEN_AGENT_ID}`,
    { headers: { "xi-api-key": ELEVEN_API_KEY } }
  );

  // When ElevenLabs connection opens
  elevenSocket.on("open", () => {
    console.log("🧠 Connected to ElevenLabs Agent Realtime API");
    // Give EL a few moments to send init metadata before streaming audio
    setTimeout(() => {
      if (!elReady) console.warn("⚠️ ElevenLabs still not ready after short delay");
    }, 1500);
  });

  // Receive messages from ElevenLabs (audio + events)
  elevenSocket.on("message", (msg) => {
    try {
      const data = JSON.parse(msg.toString());

      // === Initialization ===
      if (data.conversation_initiation_metadata_event) {
        elReady = true;
        console.log("🧠 EL init meta:", JSON.stringify(data.conversation_initiation_metadata_event, null, 2));

        // Flush any buffered Twilio packets
        if (twilioBuffer.length > 0) {
          console.log(`🚀 Flushing ${twilioBuffer.length} buffered Twilio chunks to EL...`);
          for (const chunk of twilioBuffer) elevenSocket.send(chunk);
          twilioBuffer = [];
        }
      }

      // === Audio out from ElevenLabs (agent speaking) ===
      if (data.agent_output_audio_chunk) {
        const audioB64 = data.agent_output_audio_chunk.audio_chunk;
        // Forward this audio back to Twilio as a media message
        twilioSocket.send(
          JSON.stringify({
            event: "media",
            media: { payload: audioB64 },
          })
        );
        console.log("🎧 Forwarded agent audio chunk to Twilio");
      }

      // === End of speech ===
      if (data.agent_output_audio_end) {
        twilioSocket.send(JSON.stringify({ event: "mark", name: "el_audio_end" }));
        console.log("✅ Agent finished speaking");
      }
    } catch (err) {
      console.error("❌ ElevenLabs message parse error:", err);
    }
  });

  elevenSocket.on("close", () => {
    console.log("❌ ElevenLabs connection closed");
    twilioSocket.close();
  });

  elevenSocket.on("error", (err) => {
    console.error("❌ ElevenLabs socket error:", err);
  });

  // ---------- Incoming messages from Twilio ----------
  twilioSocket.on("message", (msg) => {
    const data = JSON.parse(msg.toString());

    if (data.event === "start") {
      console.log(`▶️ Twilio stream started: ${data.start.streamSid}`);
    }

    // Media packets: convert + forward to ElevenLabs
    if (data.event === "media") {
      const pcm16 = twilioToPcm16(data.media.payload);
      if (!pcm16) return;

      const base64Pcm = Buffer.from(pcm16).toString("base64");
      const chunk = JSON.stringify({
        type: "input_audio_buffer.append",
        audio_chunk: base64Pcm,
      });

      if (elReady && elevenSocket.readyState === WebSocket.OPEN) {
        elevenSocket.send(chunk);
      } else {
        twilioBuffer.push(chunk);
        console.log("⚠️ EL not ready; buffering a Twilio packet");
      }
    }

    if (data.event === "stop") {
      console.log("⏹️ Twilio stream stopped");

      // Tell ElevenLabs we’re done
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

  twilioSocket.on("error", (err) => console.error("❌ Twilio socket error:", err));
});

