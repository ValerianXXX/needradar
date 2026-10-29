import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const raw = readFileSync(new URL('../config/local-encoder.json', import.meta.url), 'utf8').replaceAll('\r\n', '\n');
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
export const encoderSpec = freeze(JSON.parse(raw));
export const encoderId = createHash('sha256').update(raw).digest('hex');

export function embeddingInput(draft) {
  if (!draft || typeof draft !== 'object') throw new TypeError('EMBEDDING_IDENTITY_REQUIRED');
  const values = ['persona', 'jobToBeDone', 'desiredOutcome'].map(field => {
    const value = draft[field] ?? (field === 'desiredOutcome' ? '' : null);
    if (typeof value !== 'string' || (field !== 'desiredOutcome' && !value.trim())) throw new TypeError('EMBEDDING_IDENTITY_REQUIRED');
    return value.normalize('NFKC').replace(/\s+/gu, ' ').trim();
  });
  const text = `${encoderSpec.prefix}User: ${values[0]}\nTask: ${values[1]}\nOutcome: ${values[2]}`;
  if (Buffer.byteLength(text) > 16000) throw new TypeError('EMBEDDING_TEXT_LIMIT');
  return { text, inputDigest: createHash('sha256').update(text).digest('hex') };
}

export function normalizedVector(value) {
  if ((!Array.isArray(value) && !(value instanceof Float32Array)) || value.length !== encoderSpec.dimensions
    || !value.every(item => typeof item === 'number' && Number.isFinite(item))) throw new TypeError('INVALID_EMBEDDING_VECTOR');
  const norm = Math.hypot(...value);
  if (!Number.isFinite(norm) || norm <= 0) throw new TypeError('INVALID_EMBEDDING_VECTOR');
  return Float32Array.from(value, item => item / norm);
}

export function verifyEmbedding(draft, packet) {
  if (!packet || packet.encoderId !== encoderId || packet.inputDigest !== embeddingInput(draft).inputDigest) throw new TypeError('STALE_OR_INCOMPATIBLE_EMBEDDING');
  return normalizedVector(packet.vector);
}
