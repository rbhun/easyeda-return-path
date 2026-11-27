import { MIL, readCanvasOrigin, requireFocusedPcb } from './eda-reader.js';
import type {
  ClearMarkersReplyData,
  FindingSeverity,
  ShowFindingInput,
  ShowFindingsReplyData,
  ShowFindingsRequest,
} from './types.js';

interface RgbaColor {
  r: number;
  g: number;
  b: number;
  alpha: number;
}

const MAX_SHAPES_PER_CALL = 4000;
const DEFAULT_CIRCLE_RADIUS_MM = 0.8;
const DEFAULT_LINE_WIDTH = 3;

/**
 * Pure 0/255 RGB channels with alpha 255 render identically across EasyEDA Pro 3.2
 * (which clips RGB to 0..1) and EasyEDA Pro 4.x (which reads 0..255).
 */
const NAMED_COLORS: Record<string, RgbaColor> = {
  red: { r: 255, g: 0, b: 0, alpha: 255 },
  yellow: { r: 255, g: 255, b: 0, alpha: 255 },
  green: { r: 0, g: 255, b: 0, alpha: 255 },
  cyan: { r: 0, g: 255, b: 255, alpha: 255 },
  blue: { r: 0, g: 0, b: 255, alpha: 255 },
  magenta: { r: 255, g: 0, b: 255, alpha: 255 },
  white: { r: 255, g: 255, b: 255, alpha: 255 },
};

const SEVERITY_COLORS: Record<FindingSeverity, RgbaColor> = {
  error: NAMED_COLORS.red,
  warning: NAMED_COLORS.yellow,
  info: NAMED_COLORS.cyan,
};

function clampByte(n: number): number {
  return Math.max(0, Math.min(255, Math.round(n)));
}

export function parseMarkerColor(input: ShowFindingsRequest['color']): RgbaColor | undefined {
  if (!input) return undefined;
  if (typeof input === 'string') {
    const key = input.trim().toLowerCase();
    if (NAMED_COLORS[key]) return NAMED_COLORS[key];
    const hex = /^#?([0-9a-f]{6})$/i.exec(key);
    if (hex) {
      const v = parseInt(hex[1], 16);
      return { r: (v >> 16) & 255, g: (v >> 8) & 255, b: v & 255, alpha: 255 };
    }
    throw new Error(`Unsupported marker color "${input}". Use a named color (${Object.keys(NAMED_COLORS).join(', ')}), #RRGGBB, or { r, g, b, alpha? }.`);
  }
  if (typeof input === 'object') {
    const r = Number(input.r);
    const g = Number(input.g);
    const b = Number(input.b);
    const a = input.alpha === undefined ? 255 : Number(input.alpha);
    if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b) || !Number.isFinite(a)) {
      throw new Error('Marker color object must have finite numeric r, g, b (and optional alpha).');
    }
    const alpha = a > 0 && a <= 1 ? Math.round(a * 255) : clampByte(a);
    return { r: clampByte(r), g: clampByte(g), b: clampByte(b), alpha };
  }
  return undefined;
}

function extractPoint(item: ShowFindingInput): { x: number; y: number } {
  const x = typeof item.x === 'number' ? item.x : item.at?.x;
  const y = typeof item.y === 'number' ? item.y : item.at?.y;
  if (typeof x !== 'number' || !Number.isFinite(x) || typeof y !== 'number' || !Number.isFinite(y)) {
    throw new Error('Each finding marker must provide finite mm coordinates as { x, y } or { at: { x, y } }.');
  }
  return { x, y };
}

/** Draws temporary indicator markers for human review. Does not modify the PCB document. */
export async function showFindingMarkers(req: ShowFindingsRequest): Promise<ShowFindingsReplyData> {
  const pcb = await requireFocusedPcb();
  if (!req || !Array.isArray(req.findings)) {
    throw new Error('Request must include a "findings" array.');
  }
  if (req.findings.length > 2000) {
    throw new Error('At most 2000 findings can be highlighted in a single showFindings call.');
  }

  const explicitColor = parseMarkerColor(req.color);
  const lineWidth =
    typeof req.lineWidth === 'number' && Number.isFinite(req.lineWidth) && req.lineWidth > 0
      ? Math.min(20, req.lineWidth)
      : DEFAULT_LINE_WIDTH;
  const zoom = Boolean(req.zoom);
  const clearExisting = req.clearExisting !== false;

  if (clearExisting) {
    await eda.dmt_EditorControl.removeIndicatorMarkers(pcb.tabId);
  }

  if (req.findings.length === 0) {
    return { shown: 0, unit: 'mm' };
  }

  const origin = await readCanvasOrigin();
  const toCanvasMil = (xMm: number, yMm: number) => ({
    x: xMm / MIL + origin.x,
    y: yMm / MIL + origin.y,
  });

  // Group shapes by color so we minimize API calls while supporting severity coloring.
  const groups = new Map<string, { color: RgbaColor; shapes: IDMT_IndicatorMarkerShape[]; count: number }>();

  for (const item of req.findings) {
    const pt = extractPoint(item);
    const center = toCanvasMil(pt.x, pt.y);
    const color = explicitColor ?? (item.severity ? SEVERITY_COLORS[item.severity] : NAMED_COLORS.red);
    const colorKey = `${color.r},${color.g},${color.b},${color.alpha}`;
    let grp = groups.get(colorKey);
    if (!grp) {
      grp = { color, shapes: [], count: 0 };
      groups.set(colorKey, grp);
    }

    const w = typeof item.w === 'number' && Number.isFinite(item.w) && item.w > 0 ? item.w : undefined;
    const h = typeof item.h === 'number' && Number.isFinite(item.h) && item.h > 0 ? item.h : undefined;
    if (w !== undefined || h !== undefined) {
      const halfW = ((w ?? h ?? 1.6) / 2) / MIL;
      const halfH = ((h ?? w ?? 1.6) / 2) / MIL;
      grp.shapes.push({
        type: 'rectangle' as EDMT_IndicatorMarkerType,
        left: center.x - halfW,
        right: center.x + halfW,
        top: center.y + halfH,
        bottom: center.y - halfH,
      });
    } else {
      const rMm =
        typeof item.r === 'number' && Number.isFinite(item.r) && item.r > 0 ? item.r : DEFAULT_CIRCLE_RADIUS_MM;
      const rMil = rMm / MIL;
      grp.shapes.push({
        type: 'circle' as EDMT_IndicatorMarkerType,
        x: center.x,
        y: center.y,
        r: rMil,
      });
    }
    grp.count += 1;
  }

  let shown = 0;
  let zoomedOnce = false;
  for (const grp of groups.values()) {
    let ok = true;
    for (let i = 0; i < grp.shapes.length; i += MAX_SHAPES_PER_CALL) {
      const chunk = grp.shapes.slice(i, i + MAX_SHAPES_PER_CALL);
      const drew = await eda.dmt_EditorControl.generateIndicatorMarkers(
        chunk,
        grp.color,
        lineWidth,
        zoom && !zoomedOnce,
        pcb.tabId,
      );
      zoomedOnce = true;
      if (!drew) ok = false;
    }
    if (ok) shown += grp.count;
  }

  return { shown, unit: 'mm' };
}

/** Removes all temporary indicator markers from the focused PCB. Idempotent. */
export async function clearFindingMarkers(): Promise<ClearMarkersReplyData> {
  const pcb = await requireFocusedPcb();
  const cleared = await eda.dmt_EditorControl.removeIndicatorMarkers(pcb.tabId);
  return { cleared: Boolean(cleared), unit: 'mm' };
}
