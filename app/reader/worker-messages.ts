// The message vocabulary between Reader (reader.js) and its worker threads.
// Types only: nothing here exists at runtime. Reader is still JavaScript and
// posts these shapes by hand, so this file is also the written contract for it.
//
// 'fatal', 'gone' and 'diagnostic' are shared by every worker; Reader handles
// them before the per-channel handler sees anything (see Reader._spawn).
import type { MelodySlotView } from './melodies';
import type { RunSummary } from './runs';
import type { SandmanOffer, SandmanStatus } from './sandman';
import type { PlacedTile } from './tiles';

/** Parent -> worker, every worker. WorkerControl consumes it; Reader never sends it to tiles. */
export interface StopMessage { type: 'stop' }

/** Worker -> parent, every worker. */
export type WorkerStatusMessage =
  | { type: 'fatal'; message: string }
  | { type: 'gone'; message: string }
  | { type: 'diagnostic'; message: string };

/** A resolved value address the worker polls itself. */
export interface ValueBinding { addr: number; variant: string | null; is_float: boolean }

// ------------------------------------------------------------------- runs --

export type RunsWorkerInbound =
  | { type: 'values'; bindings: Record<string, ValueBinding> }
  | { type: 'melodies'; melodies: MelodySlotView[] | null; mapId: number | null; reset?: boolean }
  | StopMessage;

export type RunsWorkerOutbound = WorkerStatusMessage | { type: 'run'; summary: RunSummary };

// ---------------------------------------------------------------- sandman --

export type SandmanWorkerInbound =
  | { type: 'gate'; addr: number | null; variant: string | null; is_float: boolean }
  | { type: 'clear' }
  | StopMessage;

export type SandmanWorkerOutbound = WorkerStatusMessage
  | { type: 'sandman'; offers: readonly SandmanOffer[] | null; status: SandmanStatus };

// ------------------------------------------------------------------ tiles --

export type TilesWorkerInbound =
  | { type: 'map'; mapId: number | null; reset?: boolean }
  | { type: 'clear' }
  | StopMessage;

export type TilesWorkerOutbound = WorkerStatusMessage
  | { type: 'tiles'; tiles: readonly PlacedTile[] | null };
