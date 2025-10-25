// src/audioUtils.js

// Decode a single μ-law byte to a signed 16-bit PCM sample
function muLawDecodeSample(muByte) {
  let mu = ~muByte & 0xff;
  const sign = mu & 0x80;
  const exponent = (mu >> 4) & 0x07;
  const mantissa = mu & 0x0f;

  // μ-law decode to 14-bit-ish value (standard algorithm)
  let sample = ((mantissa << 4) + 0x08) << exponent; // base
  sample += 0x84;                                     // bias
  sample = sign ? -sample : sample;

  // Clamp to 16-bit
  if (sample > 32767) sample = 32767;
  if (sample < -32768) sample = -32768;
  return sample;
}

// Simple linear 2x upsample: 8k → 16k
function upsampleLinear2x(int16) {
  if (int16.length === 0) return new Int16Array(0);
  const out = new Int16Array(int16.length * 2);

  let j = 0;
  for (let i = 0; i < int16.length - 1; i++) {
    const a = int16[i];
    const b = int16[i + 1];
    out[j++] = a;
    out[j++] = (a + b) >> 1; // midpoint
  }

  // copy last sample twice
  const last = int16[int16.length - 1];
  out[j++] = last;
  out[j++] = last;

  return out;
}

/**
 * Convert base64 μ-law audio (Twilio media.payload) to PCM16 @ 16kHz.
 * @param {string} base64
 * @returns {Int16Array}
 */
export function twilioMuLawToPCM16(base64) {
  const u8 = Buffer.from(base64, "base64");
  // μ-law decode @ 8k
  const pcm8k = new Int16Array(u8.length);
  for (let i = 0; i < u8.length; i++) {
    pcm8k[i] = muLawDecodeSample(u8[i]);
  }
  // 8k → 16k
  return upsampleLinear2x(pcm8k);
}
