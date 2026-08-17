// Ephemeral store so print_label can return a URL instead of inlining
// megabytes of base64 into the tool result. This is the ONLY state in
// the server; losing it on restart just means re-printing.
import crypto from 'crypto';

const LABEL_TTL_MS = 10 * 60_000;
const MAX_ENTRIES = 200;
const store = new Map(); // token -> {buf, exp}

function sweep() {
  const now = Date.now();
  for (const [k, v] of store) if (v.exp < now) store.delete(k);
  while (store.size > MAX_ENTRIES) store.delete(store.keys().next().value);
}

export function putLabel(buf) {
  sweep();
  const token = crypto.randomBytes(16).toString('hex');
  store.set(token, { buf, exp: Date.now() + LABEL_TTL_MS });
  return token;
}

export function takeLabel(token) {
  sweep();
  return store.get(String(token))?.buf || null;
}
