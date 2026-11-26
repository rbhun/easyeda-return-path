// Colour and line width of each overlay role, adjustable in the Return Path panel and stored with
// the extension's settings.
import { readStored, writeStored } from './runner';

export type Rgba = { r: number; g: number; b: number; alpha: number };

// EasyEDA Pro 3.2 reads marker colours on a 0–1 scale and clips above 1 (both { r: 255 } and { r: 1 }
// draw red), so any mixed 0–255 colour comes out white. Channels of only 0 and 255 read the same on
// either scale, which leaves these seven.
export const PALETTE = {
	red: { r: 255, g: 0, b: 0, alpha: 1 },
	yellow: { r: 255, g: 255, b: 0, alpha: 1 },
	green: { r: 0, g: 255, b: 0, alpha: 1 },
	cyan: { r: 0, g: 255, b: 255, alpha: 1 },
	blue: { r: 0, g: 0, b: 255, alpha: 1 },
	magenta: { r: 255, g: 0, b: 255, alpha: 1 },
	white: { r: 255, g: 255, b: 255, alpha: 1 },
} satisfies Record<string, Rgba>;
export type ColourName = keyof typeof PALETTE;

export const ROLES = ['supply', 'returnTop', 'returnOther', 'returnInner', 'hop', 'gap', 'band'] as const;
export type Role = typeof ROLES[number];

export interface RoleStyle { colour: ColourName; width: number }

export const DEFAULT_STYLE: Record<Role, RoleStyle> = {
	supply: { colour: 'yellow', width: 2 },
	returnTop: { colour: 'magenta', width: 5 },
	returnOther: { colour: 'cyan', width: 5 },
	returnInner: { colour: 'green', width: 5 },
	hop: { colour: 'yellow', width: 2 },
	gap: { colour: 'red', width: 3 },
	band: { colour: 'white', width: 1 },
};

/** Inner layers take these in turn while returnInner keeps its default colour. */
export const INNER_CYCLE: ColourName[] = ['green', 'blue'];

export const ROLE_LABELS: Record<Role, string> = {
	supply: 'DC supply',
	returnTop: 'Return, top layer',
	returnOther: 'Return, other layers (bottom)',
	returnInner: 'Return, inner layers',
	hop: 'Hops (via, decap, cap, pin)',
	gap: 'Gaps and bottleneck',
	band: '±3h band edges',
};

const KEY = 'overlayStyle';
export const MAX_WIDTH = 10;

function valid(s: unknown): s is Partial<RoleStyle> {
	return !!s && typeof s === 'object';
}

/** Defaults with the stored changes applied; unknown colours and widths outside 1–10 are ignored. */
export function currentStyle(): Record<Role, RoleStyle> {
	let stored: unknown = readStored(KEY);
	if (typeof stored === 'string') {
		try {
			stored = JSON.parse(stored);
		}
		catch {
			stored = undefined;
		}
	}
	const out = structuredCloneStyle(DEFAULT_STYLE);
	if (!stored || typeof stored !== 'object')
		return out;
	for (const role of ROLES) {
		const s = (stored as Record<string, unknown>)[role];
		if (!valid(s))
			continue;
		if (typeof s.colour === 'string' && s.colour in PALETTE)
			out[role].colour = s.colour as ColourName;
		if (typeof s.width === 'number' && s.width >= 1 && s.width <= MAX_WIDTH)
			out[role].width = Math.round(s.width);
	}
	return out;
}

export async function saveStyle(style: Partial<Record<Role, Partial<RoleStyle>>> | 'reset'): Promise<Record<Role, RoleStyle>> {
	const next = style === 'reset' ? structuredCloneStyle(DEFAULT_STYLE) : currentStyle();
	if (style !== 'reset') {
		for (const role of ROLES) {
			const s = style[role];
			if (s?.colour && s.colour in PALETTE)
				next[role].colour = s.colour;
			if (typeof s?.width === 'number' && s.width >= 1 && s.width <= MAX_WIDTH)
				next[role].width = Math.round(s.width);
		}
	}
	await writeStored(KEY, JSON.stringify(next));
	return next;
}

function structuredCloneStyle(s: Record<Role, RoleStyle>): Record<Role, RoleStyle> {
	return Object.fromEntries(ROLES.map(r => [r, { ...s[r] }])) as Record<Role, RoleStyle>;
}

/** Colour of a role; inner layers cycle through INNER_CYCLE (by inner index) unless the user picked one. */
export function roleColour(role: Role, innerIndex = 0): { colour: Rgba; name: ColourName; width: number } {
	const s = currentStyle()[role];
	const name = role === 'returnInner' && s.colour === DEFAULT_STYLE.returnInner.colour ? INNER_CYCLE[innerIndex % INNER_CYCLE.length] : s.colour;
	return { colour: PALETTE[name], name, width: s.width };
}
