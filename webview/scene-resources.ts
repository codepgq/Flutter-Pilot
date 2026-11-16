import type { WorkbenchState, Rule } from '../src/model';
import type { Scene } from '../src/scene-model';
import type { WsRule } from '../src/ws/model';
import type { SceneDetail, ScenePage, Resource } from '../src/scene-storage-model';
import type { SceneAction } from '../src/workflows/model';

type Send = (action: string, payload?: any) => void;
let sequence = 0;
let currentScene = '';
let sceneRequest = 0;
let pageRequest: { id: number; search: string; offset: number; limit: number } | undefined;
const requests = new Map<string, number>();
const tokens = new Map<string, string>();
const resourceKey = (scene: string, kind: string, id: string) => JSON.stringify([scene, kind, id]);
export function selectScene(send: Send, id: string) {
  currentScene = id;
  sceneRequest = ++sequence;
  requests.clear();
  send('scenes.select', { id, requestId: sceneRequest });
}
export function closeScene() {
  currentScene = '';
  requests.clear();
}
export function queryScenes(send: Send, query: { search: string; offset: number; limit?: number }) {
  pageRequest = { id: ++sequence, search: query.search, offset: query.offset, limit: query.limit ?? 50 };
  send('scenes.query', { ...query, requestId: pageRequest.id });
}
export function acceptPage(message: { page: ScenePage; requestId?: number }, state: WorkbenchState) {
  if (message.page.revision < (state.scenePage?.revision ?? 0)) return false;
  if (!pageRequest) return true;
  if (message.requestId !== undefined && message.requestId !== pageRequest.id) return false;
  // Query identity also protects hosts that send unsolicited page refreshes without a request ID.
  return (
    message.page.search === pageRequest.search &&
    message.page.offset === pageRequest.offset &&
    message.page.limit === pageRequest.limit
  );
}
export function cancelResource(kind: string, requestId?: number) {
  if (requestId === undefined || requests.get(kind) === requestId) requests.delete(kind);
}
export function requestResource(send: Send, sceneId: string, kind: string, id: string) {
  const requestId = ++sequence;
  requests.set(kind, requestId);
  send('scenes.resource', { sceneId, kind, id, requestId });
  return requestId;
}
export function acceptDetail(
  message: { detail?: SceneDetail; requestId: number; version: number },
  state: WorkbenchState,
) {
  const accepted =
    message.version >= Math.max(state.scenePage?.revision ?? 0, state.sceneDetail?.version ?? 0) &&
    (message.requestId === sceneRequest || !sceneRequest);
  if (accepted) currentScene = message.detail?.id ?? '';
  return accepted;
}
export function acceptResource(
  message: { resource: Resource<unknown>; requestId: number },
  state: WorkbenchState,
) {
  const { resource } = message;
  if (
    resource.address.sceneId !== currentScene ||
    requests.get(resource.address.kind) !== message.requestId ||
    resource.version < Math.max(state.scenePage?.revision ?? 0, state.sceneDetail?.version ?? 0)
  )
    return false;
  tokens.set(
    resourceKey(resource.address.sceneId, resource.address.kind, resource.address.id!),
    resource.hash,
  );
  return true;
}
export const resourceHash = (sceneId: string | undefined, kind: string, id: string) =>
  sceneId ? tokens.get(resourceKey(sceneId, kind, id)) : undefined;
export function pageScenes(page: ScenePage): Scene[] {
  return page.scenes.map((scene) => ({ id: scene.id, name: scene.name, httpRules: [], wsRules: [] }));
}
export function detailScene(detail: SceneDetail, action?: SceneAction): Scene {
  return {
    id: detail.id,
    name: detail.name,
    targets: detail.targets,
    httpRules: detail.http.map(
      (r) =>
        (r.overview as Rule) ?? {
          id: r.id,
          name: r.name,
          enabled: r.enabled,
          priority: r.priority,
          match: {},
          mock: { status: 200, headers: {}, body: '' },
        },
    ),
    wsRules: detail.ws.map(
      (r) =>
        (r.overview as WsRule) ?? {
          id: r.id,
          name: r.name,
          enabled: r.enabled,
          priority: r.priority,
          match: { url: '*' },
          action: { type: 'drop' },
        },
    ),
    actions: detail.actions.map((summary) =>
      action?.id === summary.id
        ? action
        : {
            id: summary.id,
            name: summary.name,
            description: summary.description,
            inputs: summary.inputs,
            steps: [],
          },
    ),
  };
}
