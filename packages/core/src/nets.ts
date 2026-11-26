// EasyEDA treats net names case-insensitively: 3v3 and 3V3 are one net. The board keeps one
// spelling per net, and every name a user gives (a selected primitive, a CLI flag, a board-info
// row, a stored run) is matched to that spelling.
import type { Board } from './types.js';

export const netKey = (net: string) => net.toLowerCase();
export const sameNet = (a: string | undefined, b: string | undefined) => a !== undefined && b !== undefined && netKey(a) === netKey(b);

/** The board's spelling of `net`, or `net` itself when the board has no such net. */
export function resolveNet(board: Partial<Pick<Board, 'nets' | 'tracks' | 'pads' | 'pours'>>, net: string): string {
  if (!net || board.nets?.includes(net)) return net;
  const k = netKey(net);
  const hit =
    board.nets?.find((n) => netKey(n) === k) ??
    [board.pads ?? [], board.pours ?? [], board.tracks ?? []].flatMap((list) => list.find((p) => p.net && netKey(p.net) === k) ?? [])[0]?.net;
  return hit ?? net;
}

/** `nets` without a second spelling of one net, the first spelling kept. */
export function uniqueNets(nets: string[]): string[] {
  const seen = new Set<string>();
  return nets.filter((n) => !seen.has(netKey(n)) && !!seen.add(netKey(n)));
}

/**
 * Gives every primitive of a net the same spelling: the one most of its primitives use (the first
 * seen on a tie), and a warning naming the spellings that were joined. Changes `board` in place.
 */
export function unifyNetCase(board: Board): Board {
  const prims: { net: string }[] = [...board.tracks, ...board.vias, ...board.pads, ...board.pours];
  const counts = new Map<string, Map<string, number>>();
  for (const name of [...board.nets, ...prims.map((p) => p.net)]) {
    if (!name) continue;
    const byName = counts.get(netKey(name)) ?? new Map<string, number>();
    byName.set(name, (byName.get(name) ?? 0) + 1);
    counts.set(netKey(name), byName);
  }
  const canon = new Map<string, string>();
  for (const [k, byName] of counts) {
    if (byName.size < 2) continue;
    const names = [...byName];
    const best = names.reduce((a, b) => (b[1] > a[1] ? b : a))[0];
    canon.set(k, best);
    const spelt = names.map(([n]) => n);
    board.warnings.push(`Nets ${spelt.slice(0, -1).join(', ')} and ${spelt[spelt.length - 1]} differ only in letter case; EasyEDA takes them as one net, analysed as ${best}.`);
  }
  if (!canon.size) return board;
  const fix = (n: string) => (n && canon.get(netKey(n))) || n;
  for (const p of prims) p.net = fix(p.net);
  board.nets = [...new Set(board.nets.map(fix))].sort();
  return board;
}
