// Layer stack defaults when the file or the API gives none.

/**
 * Dielectric thicknesses (top to bottom) of a common 1.6 mm board when the stack is unknown:
 * 2 layers = one 1.5 mm core; 4 layers = JLCPCB's default 7628 stack; more = 0.2 mm outer prepregs
 * with the rest split evenly.
 */
export function assumedDielectricsMm(copperLayers: number): number[] {
  if (copperLayers < 2) return [];
  if (copperLayers === 2) return [1.5];
  if (copperLayers === 4) return [0.21, 1.065, 0.21];
  const inner = +((1.5 - 0.4) / (copperLayers - 3)).toFixed(3);
  return [0.2, ...Array.from({ length: copperLayers - 3 }, () => inner), 0.2];
}
