/** HTTP/WS scene wiring for isolated Flutter smoke fixtures. */
export async function createSceneNetwork(
  vm,
  directory,
  { SceneStore, SceneController, McpNetworkController },
) {
  const store = new SceneStore(directory);
  const scenes = new SceneController(store, {
    snapshot: () => ({
      key: `${vm.state.status}:${vm.state.isolates}`,
      mode: 'vm',
      connected: vm.state.status === 'connected',
      httpApplied: vm.state.mockEnabled && vm.state.instances > 0,
      wsApplied:
        vm.websocket.state.mockEnabled &&
        vm.websocket.state.connections.some(
          (connection) => connection.status === 'open' && connection.capture === 'attached',
        ),
    }),
    disable: (domain) => (domain === 'http' ? vm.setMockEnabled(false) : vm.websocket.setMockEnabled(false)),
    project: async (http, ws) => {
      await vm.updateRules(http);
      await vm.websocket.updateRules(ws);
    },
    enable: async (domain) => {
      if (domain === 'http') {
        await vm.setCaptureEnabled(true);
        await vm.setMockEnabled(true);
      } else {
        await vm.websocket.setCaptureEnabled(true);
        await vm.websocket.setMockEnabled(true);
      }
    },
    capture: (domain, enabled) =>
      domain === 'http' ? vm.setCaptureEnabled(enabled) : vm.websocket.setCaptureEnabled(enabled),
    changed: () => {},
  });
  await scenes.initialize();
  const network = new McpNetworkController({
    scenesPath: store.file,
    listScenes: () => scenes.summary(),
    activateScene: (id) => scenes.activate(id),
    reloadScenes: () => scenes.reload(),
    status: () => ({
      vmConnected: vm.state.status === 'connected',
      scene: { activeSceneId: scenes.document.activeSceneId, runtime: scenes.runtime },
      http: {
        captureEnabled: vm.state.captureEnabled,
        mockEnabled: vm.state.mockEnabled,
        runtimeApplied: scenes.runtime.http.status === 'applied',
        instances: vm.state.instances,
      },
    }),
    listHttp: (query) => vm.store.list(query),
    getHttp: (id) => vm.store.get(id),
    connections: () => vm.websocket.store.connections(),
    messages: (query) => vm.websocket.store.list(query),
    injectWs: (id, text, signal) => vm.websocket.push(id, text, signal),
    sendWs: (id, text, signal) => vm.websocket.send(id, text, signal),
    setCapture: (domain, enabled) => scenes.setCapture(domain, enabled),
  });
  return {
    store,
    scenes,
    network,
    writeHttpRules: async ({ rules }) => {
      const before = await store.read();
      const doc = structuredClone(before);
      doc.scenes[0].httpRules = rules;
      return store.save(doc, before);
    },
  };
}
