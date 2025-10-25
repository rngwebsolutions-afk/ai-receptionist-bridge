// =======================
// AI Receptionist (Twilio <-> ElevenLabs)
// =======================

import dotenv from "dotenv";
dotenv.config();

import express from "express";
import WebSocket, { WebSocketServer } from "ws";
import { twilioMuLawToPCM16 } from "./audioUtils.js"; // ← use local decoder

const app = express();
app.use(express.json());

// =============== CONFIG ==================
const PORT = process.env.PORT || 3000;
const ELEVEN_AGENT_ID = process.env.ELEVENLABS_AGENT_ID;   // ← match Render env
const ELEVEN_API_KEY = process.env.ELEVENLABS_API_KEY;
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
    return twilioMuLawToPCM16(base64); // Int16Array @16kHz
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
  const elUrl = `wss://api.elevenlabs.io/v1/convai/conversation?agent_id=${ELEVEN_AGENT_ID}`;
  elevenSocket = new WebSocket(elUrl, { headers: { "xi-api-key": ELEVEN_API_KEY } });

  // When ElevenLabs connection opens
  elevenSocket.on("open", () => {
    console.log("🧠 Connected to ElevenLabs Agent Realtime API");
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

        // ⚠️ NOTE: Twilio Media Streams are one-way (from call → your server).
        // Sending "media" back over the same WebSocket is ignored by Twilio.
        // To play audio to the caller, you must use TwiML <Play>/<Say> or a
        // bidirectional media path (not supported by classic Media Streams).
        // We keep this here only for “local monitoring” or if your infra
        // supports bidirectional media via a different mechanism.
        twilioSocket.send(
          JSON.stringify({
            event: "media",
            media: { payload: audioB64 },
          })
        );
        console.log("🎧 Received agent audio chunk (sent to Twilio socket for monitoring)");
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
