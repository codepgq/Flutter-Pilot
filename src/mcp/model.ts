export type McpAgentId = 'claude' | 'codex-cli' | 'codex-app' | 'cursor';
export type McpScope = 'project' | 'global';

export interface McpAgentState {
  agent: McpAgentId;
  scope: McpScope;
  status: string;
  configPath: string;
  configured?: boolean;
  clientDetected?: boolean;
  shared?: boolean | string;
  message?: string;
  connected?: boolean;
  lastSeen?: number;
  shadowed?: boolean;
  effectivePath?: string;
  effectiveMessage?: string;
  difference?: { commandMatches: boolean; argumentsMatch: boolean };
}

export interface McpWorkbenchState {
  enabled: boolean;
  running: boolean;
  nodePath?: string;
  scope: McpScope;
  agents: McpAgentState[];
  ui: { supported: boolean; reason?: string };
  clients: { name: string; version?: string; lastSeen: number; scope?: McpScope }[];
  error?: string;
  notice?: string;
}
