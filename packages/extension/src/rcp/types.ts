export type FindingSeverity = 'error' | 'warning' | 'info';

export type FindingKind =
  | 'no_reference_plane'
  | 'plane_split_crossing'
  | 'plane_void'
  | 'near_plane_edge'
  | 'layer_change_no_return'
  | 'reference_net_change';

export interface PointMm {
  x: number;
  y: number;
}

export interface Finding {
  severity: FindingSeverity;
  kind: FindingKind;
  net: string;
  layerId: number;
  referenceLayerId?: number;
  at: PointMm;
  lengthMm?: number;
  detail: string;
  primitiveIds?: string[];
}

export interface CheckRules {
  /**
   * Reference-plane net names (case-insensitive).
   * When null or empty, all ground nets (GND, AGND, PGND, 48V_PGND, VSS, etc.) with pours/planes are used.
   */
  referenceNets: string[] | null;
  /** Maximum distance (mm) from a layer-changing signal via to a valid return/stitching via. */
  returnViaRadiusMm: number;
  /** Minimum clearance from a reference plane edge as a multiple of adjacent dielectric height h. */
  planeEdgeClearanceFactor: number;
  /** Minimum offending trace length (mm) to report for continuous plane/void/edge findings. */
  minSegmentLengthMm: number;
  /** Net names (case-insensitive) to skip when calling checkNet. */
  skipNets: string[];
}

export type PartialCheckRules = Partial<CheckRules>;

export const DEFAULT_CHECK_RULES: CheckRules = {
  referenceNets: null,
  returnViaRadiusMm: 2.5,
  planeEdgeClearanceFactor: 3,
  minSegmentLengthMm: 0.25,
  skipNets: [],
};

export interface StackupEntry {
  layerId: number;
  name: string;
  type: 'copper' | 'dielectric';
  thicknessMm: number | null;
  assumed?: boolean;
}

export interface InfoReplyData {
  service: string;
  version: string;
  pcbUuid: string;
  copperLayers: number;
  stackup: StackupEntry[];
  unit: 'mm';
  defaultRules: CheckRules;
  topics: string[];
}

export interface NetSummary {
  name: string;
  trackCount: number;
  viaCount: number;
  layers: number[];
  totalLengthMm: number;
  isPower: boolean;
  isGround: boolean;
  hasPour: boolean;
}

export interface ListNetsRequest {
  offset?: number;
  limit?: number;
  includePower?: boolean;
}

export interface ListNetsReplyData {
  unit: 'mm';
  total: number;
  totalAll: number;
  offset: number;
  limit: number;
  includePower: boolean;
  hasMore: boolean;
  nets: NetSummary[];
  truncated?: boolean;
}

export interface CheckNetRequest {
  net: string;
  rules?: PartialCheckRules;
  refresh?: boolean;
}

export interface CheckNetSummary {
  total: number;
  errors: number;
  warnings: number;
  info: number;
  byKind: Record<FindingKind, number>;
}

export interface CheckNetReplyData {
  net: string;
  unit: 'mm';
  skipped?: boolean;
  reason?: string;
  segmentsChecked: number;
  viasChecked: number;
  referenceNetsUsed: string[];
  rulesApplied: CheckRules;
  summary: CheckNetSummary;
  findings: Finding[];
  truncated?: boolean;
  warnings?: string[];
}

export interface ShowFindingInput {
  x?: number;
  y?: number;
  at?: PointMm;
  w?: number;
  h?: number;
  r?: number;
  severity?: FindingSeverity;
}

export interface ShowFindingsRequest {
  findings: ShowFindingInput[];
  color?: string | { r: number; g: number; b: number; alpha?: number };
  lineWidth?: number;
  zoom?: boolean;
  clearExisting?: boolean;
}

export interface ShowFindingsReplyData {
  shown: number;
  unit: 'mm';
}

export interface ClearMarkersReplyData {
  cleared: boolean;
  unit: 'mm';
}

export type ServiceEnvelope<T> = { ok: true; data: T } | { ok: false; error: string };
