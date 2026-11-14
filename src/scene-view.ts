import type { SceneDocument } from './scene-model';

/** Keep configured secret defaults inside the execution snapshot. */
export function sceneWorkbenchSnapshot(document: SceneDocument): SceneDocument {
  const snapshot = structuredClone(document);
  for (const scene of snapshot.scenes)
    for (const action of scene.actions ?? [])
      for (const spec of Object.values(action.inputs ?? {}))
        if (spec.secret && spec.default !== undefined) spec.default = '[REDACTED]';
  return snapshot;
}
