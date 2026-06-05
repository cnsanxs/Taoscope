// 32-bit FNV-1a. Collisions only delay primed-range invalidation by at most
// one keystroke, so a non-cryptographic hash is the right tool.
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
