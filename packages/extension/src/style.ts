// Colour and line width of each overlay role, adjustable in the Return Path panel and stored with
// the extension's settings.
import { readStored, writeStored } from './runner';

export type Rgba = { r: number; g: number; b: number; alpha: number };

// EasyEDA Pro 3.2 reads marker colours on a 0–1 scale and clips above 1 (both { r: 255 } and { r: 1 }
// draw red), so any mixed 0–255 colour comes out white. Channels of only 0 and 255 read the same on
// either scale, which leaves these seven. Alpha is 255 for the same reason: fully opaque whether it is
// read on a 0–1 scale (clipped) or a 0–255 one, where 1 would be nearly transparent.
export const PALETTE = {
	red: { r: 255, g: 0, b: 0, alpha: 255 },
	yellow: { r: 255, g: 255, b: 0, alpha: 255 },
	green: { r: 0, g: 255, b: 0, alpha: 255 },
	cyan: { r: 0, g: 255, b: 255, alpha: 255 },
	blue: { r: 0, g: 0, b: 255, alpha: 255 },
	magenta: { r: 255, g: 0, b: 255, alpha: 255 },
	white: { r: 255, g: 255, b: 255, alpha: 255 },
} satisfies Record<string, Rgba>;
export type ColourName = keyof typeof PALETTE;

export const ROLES = ['supply', 'signal', 'returnTop', 'returnOther', 'returnInner', 'hop', 'gap', 'band'] as const;
export type Role = typeof ROLES[number];

export interface RoleStyle { colour: ColourName; width: number; visible: boolean }

export const DEFAULT_STYLE: Record<Role, RoleStyle> = {
	supply: { colour: 'yellow', width: 2, visible: true },
	signal: { colour: 'white', width: 2, visible: true },
	returnTop: { colour: 'magenta', width: 5, visible: true },
	returnOther: { colour: 'cyan', width: 5, visible: true },
	returnInner: { colour: 'green', width: 5, visible: true },
	hop: { colour: 'yellow', width: 2, visible: true },
	gap: { colour: 'red', width: 3, visible: true },
	band: { colour: 'white', width: 1, visible: false },
};

/** Inner layers take these in turn while returnInner keeps its default colour. */
export const INNER_CYCLE: ColourName[] = ['green', 'blue'];

/** The analyses that draw each role; the panel lists only the roles of the last run's kind. */
export const ROLE_USE: Record<Role, ('hf' | 'dc')[]> = {
	supply: ['dc'],
	signal: ['hf'],
	returnTop: ['hf', 'dc'],
	returnOther: ['hf', 'dc'],
	returnInner: ['hf'],
	hop: ['hf'],
	gap: ['hf', 'dc'],
	band: ['hf'],
};

export const ROLE_LABELS: Record<Role, string> = {
	supply: 'DC supply',
	signal: 'Signal trace and its vias',
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

/** The style another instance of the extension saved; its stored copy may not have reached this one. */
let sharedStyle: Record<Role, RoleStyle> | undefined;

export function setSharedStyle(style: Record<Role, RoleStyle> | undefined): void {
	sharedStyle = style;
}

/** Defaults with the stored changes applied; unknown colours and widths outside 1–10 are ignored. */
export function currentStyle(): Record<Role, RoleStyle> {
	let stored: unknown = sharedStyle ?? readStored(KEY);
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
		if (typeof s.visible === 'boolean')
			out[role].visible = s.visible;
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
			if (typeof s?.visible === 'boolean')
				next[role].visible = s.visible;
		}
	}
	sharedStyle = next;
	await writeStored(KEY, JSON.stringify(next));
	return next;
}

function structuredCloneStyle(s: Record<Role, RoleStyle>): Record<Role, RoleStyle> {
	return Object.fromEntries(ROLES.map(r => [r, { ...s[r] }])) as Record<Role, RoleStyle>;
}

/** Colour of a role; inner layers cycle through INNER_CYCLE (by inner index) unless the user picked one. */
export function roleColour(role: Role, innerIndex = 0): { colour: Rgba; name: ColourName; width: number; visible: boolean } {
	const s = currentStyle()[role];
	const name = role === 'returnInner' && s.colour === DEFAULT_STYLE.returnInner.colour ? INNER_CYCLE[innerIndex % INNER_CYCLE.length] : s.colour;
	return { colour: PALETTE[name], name, width: s.width, visible: s.visible };
}
