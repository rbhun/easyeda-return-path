import type { BoardInfo, CheckView, Finding as CoreFinding, LayerInfo, LoadInfo, NetInfo } from '@returnpath/core';
import type { PublicDcResult, PublicHfResult, PublicRunExecutor } from '../bus.js';
import type { Role, RoleStyle } from '../style.js';

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

export interface RcpHfConfig {
  /** Default signal nets to analyse when startAnalysis({ kind: 'hf' }) omits net and nets. */
  nets: string[];
  /** Default frequency/bitrate override in Hz when not specified per-call or in boardInfo. */
  speedHz?: number;
  /** Default driver designators when not specified per-call or in boardInfo. */
  drivers?: string[];
  /** Whether to draw temporary Return Path overlay markers on the canvas (default true). */
  draw: boolean;
  /** Per-net analysis time budget in ms (default 60000). */
  timeoutMs: number;
}

export interface RcpDcConfig {
  rail?: string;
  railNets?: string[];
  ground?: string;
  source?: string;
  loads?: string[];
  /** Per-load currents in amps (e.g. { U2: 0.15 }). */
  currents?: Record<string, number>;
  focus?: string;
  /** Whether to draw temporary DC overlay markers on the canvas (default true). */
  draw: boolean;
  /** DC solve time budget in ms (default 120000). */
  timeoutMs: number;
}

export type LastRunSummary =
  | { kind: 'hf'; net: string; drivers?: string[]; hz?: number }
  | {
      kind: 'dc';
      input: {
        rail: string;
        railNets?: string[];
        ground: string;
        source: string;
        loads?: string[];
        currents?: Record<string, number>;
      };
    };

export interface ActiveJobSummary {
  jobId: string;
  requestId?: string;
  kind: 'hf' | 'dc';
  status: 'running';
  startedAt: string;
}

export interface RcpConfigData {
  unit: 'mm';
  project: { id: string; name: string };
  boardInfo: BoardInfo;
  rules: CheckRules;
  hf: RcpHfConfig;
  dc: RcpDcConfig;
  overlayStyle: Record<Role, RoleStyle>;
  lastRun: LastRunSummary | null;
  activeJob: ActiveJobSummary | null;
  truncated?: boolean;
}

export interface NetInfoInput extends Omit<Partial<NetInfo>, 'driver'> {
  net: string;
  /** Frequency string like "16 MHz" or "400k", or Hz number (shorthand for speedHz). */
  speed?: number | string;
  /** Component designator(s), "none", { parts, pin?, pinName? }, or null to clear. */
  driver?: NetInfo['driver'] | string | string[] | null;
}

export interface LoadInfoInput extends Omit<Partial<LoadInfo>, 'source' | 'load' | 'voltage'> {
  net: string;
  voltage?: number | string;
  source?: LoadInfo['source'] | string;
  load?: LoadInfo['load'] | string;
  typicalCurrent?: number | string;
  peakCurrent?: number | string;
}

export interface BoardInfoInput {
  nets?: NetInfoInput[];
  loads?: LoadInfoInput[];
  layers?: LayerInfo[];
}

export interface SetConfigRequest {
  /** "merge" (default) merges provided fields; "replace" replaces each provided section wholesale. */
  mode?: 'merge' | 'replace';
  /** If true, resets stored rules/hf/dc defaults before applying provided fields. */
  reset?: boolean;
  /** Update or replace project boardInfo (nets, loads, layers); pass null to clear. */
  boardInfo?: BoardInfoInput | null;
  /** Update default mcp.rcp.checkNet rules; pass null to reset to DEFAULT_CHECK_RULES. */
  rules?: PartialCheckRules | null;
  /** Update default HF analysis options; pass null to reset. */
  hf?: {
    nets?: string[] | null;
    speed?: number | string | null;
    speedHz?: number | null;
    drivers?: string | string[] | null;
    draw?: boolean;
    timeoutMs?: number;
  } | null;
  /** Update default DC analysis options; pass null to reset. */
  dc?: {
    rail?: string | null;
    railNets?: string[] | null;
    ground?: string | null;
    source?: string | null;
    loads?: string[] | null;
    currents?: Record<string, number | string> | string | null;
    focus?: string | null;
    draw?: boolean;
    timeoutMs?: number;
  } | null;
  /** Update overlay role colours/widths/visibility, or "reset" to restore defaults. */
  overlayStyle?: Partial<Record<Role, Partial<RoleStyle>>> | 'reset';
}

export interface SetConfigReplyData {
  unit: 'mm';
  updated: string[];
  config: RcpConfigData;
}

export type AnalysisJobStatus = 'running' | 'completed' | 'failed' | 'cancelled';

export interface StartAnalysisRequest {
  kind: 'hf' | 'dc';
  /** Optional idempotency key: retrying with the same requestId returns the existing job instead of starting another. */
  requestId?: string;
  /** Max time (ms, 0..55000, default 5000) to wait for completion before returning a pollable running handle. */
  waitMs?: number;
  /** Include human-readable report lines in the reply (default true). */
  includeLines?: boolean;
  /** Single HF net (for kind="hf"). */
  net?: string;
  /** Small batch of HF nets (max 10, for kind="hf"). If both net and nets are omitted, uses config.hf.nets. */
  nets?: string[];
  speed?: number | string;
  speedHz?: number;
  drivers?: string | string[];
  source?: string;
  /** DC rail net (for kind="dc"; falls back to config.dc.rail). */
  rail?: string;
  railNets?: string[];
  ground?: string;
  loads?: string[];
  currents?: Record<string, number | string> | string;
  focus?: string;
  /** Whether to draw temporary overlay markers on the PCB (falls back to config.hf.draw / config.dc.draw, default true). */
  draw?: boolean;
  /** Analysis execution timeout in ms (1000..300000). */
  timeoutMs?: number;
}

export interface HfBatchNetItem {
  net: string;
  ok: boolean;
  durationMs: number;
  summary?: string;
  score?: number;
  status?: 'Good' | 'Fair' | 'Needs work';
  findingsCount?: number;
  findings?: CoreFinding[];
  hf?: PublicHfResult;
  lines?: string[];
  logPath?: string;
  resultsPath?: string;
  error?: string;
}

export interface HfSingleAnalysisResult {
  batch: false;
  summary: string;
  lines?: string[];
  findings: CoreFinding[];
  hf: PublicHfResult;
  boardScore?: CheckView;
  logPath?: string;
  resultsPath?: string;
}

export interface HfBatchAnalysisResult {
  batch: true;
  total: number;
  completed: number;
  failed: number;
  summary: string;
  boardScore?: CheckView;
  nets: HfBatchNetItem[];
}

export interface DcAnalysisResult {
  summary: string;
  lines?: string[];
  dc: PublicDcResult;
  logPath?: string;
  resultsPath?: string;
}

export type AnalysisJobResult = HfSingleAnalysisResult | HfBatchAnalysisResult | DcAnalysisResult;

export interface AnalysisJobProgress {
  completed: number;
  total: number;
  currentNet?: string;
}

export interface AnalysisJobReplyData {
  jobId: string;
  requestId?: string;
  kind: 'hf' | 'dc';
  status: AnalysisJobStatus;
  unit: 'mm';
  startedAt: string;
  finishedAt?: string;
  durationMs: number;
  progress: AnalysisJobProgress;
  pollTopic?: 'mcp.rcp.getAnalysis';
  result?: AnalysisJobResult;
  error?: string;
  truncated?: boolean;
}

export interface GetAnalysisRequest {
  jobId?: string;
  requestId?: string;
  /** Optional long-poll duration in ms (0..55000, default 0). */
  waitMs?: number;
  /** Include human-readable report lines in the reply (default true). */
  includeLines?: boolean;
  /** When true, return compact summaries of recent jobs instead of one full job. */
  list?: boolean;
}

export interface AnalysisJobListItem {
  jobId: string;
  requestId?: string;
  kind: 'hf' | 'dc';
  status: AnalysisJobStatus;
  startedAt: string;
  finishedAt?: string;
  durationMs: number;
  progress: AnalysisJobProgress;
  error?: string;
}

export interface ListAnalysisJobsReplyData {
  unit: 'mm';
  activeJobId: string | null;
  jobs: AnalysisJobListItem[];
}

export interface CancelAnalysisRequest {
  jobId?: string;
  requestId?: string;
}

export interface CancelAnalysisReplyData {
  unit: 'mm';
  cancelled: boolean;
  jobId: string | null;
  status: AnalysisJobStatus | 'cancelling' | 'idle' | 'not_found';
}

export interface RcpHost {
  executor: PublicRunExecutor;
  getLastRun?: () => LastRunSummary | undefined;
  onNetPropsChanged?: (changes: { net: string; edge?: 'fast' | 'normal' | 'slow'; drive?: 'push-pull' | 'open-drain' }[]) => Promise<void>;
  getBoardScore?: () => CheckView | undefined;
}

export type ServiceEnvelope<T> = { ok: true; data: T } | { ok: false; error: string };
