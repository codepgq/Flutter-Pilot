import type { HistoryEntry, HistoryQuery, HistoryResult } from '../model';
import type { RuntimeTargetRef } from './targets';

export interface RuntimeHttpStatus {
  readonly target: RuntimeTargetRef;
  readonly connected: boolean;
  readonly captureEnabled: boolean;
  readonly mockEnabled: boolean;
  /** Desired configuration and runtime application are deliberately separate facts. */
  readonly applied: boolean;
  readonly error?: string;
}

/** Backend-neutral HTTP boundary used by workbench and MCP routing. */
export interface RuntimeHttpAdapter {
  readonly target: RuntimeTargetRef;
  status(): RuntimeHttpStatus;
  listHttp(query: HistoryQuery): Promise<HistoryResult>;
  getHttp(id: string): Promise<HistoryEntry>;
  setCapture(enabled: boolean): Promise<void>;
}

/** Scene activation belongs to a fixed runtime and does not execute UI actions. */
export interface RuntimeSceneAdapter {
  readonly target: RuntimeTargetRef;
  activateScene(sceneId: string | null): Promise<void>;
  reloadScenes(): Promise<void>;
}
