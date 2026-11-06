export type RemindedSession = string
export type OpenLaunches = string[]
export type OrchestratorLoaded = string
export type OrchestratorNagged = string

declare module 'claude-code' {
  interface PluginState {
    'dispatch-guard': { remindedSession: RemindedSession; openLaunches: OpenLaunches; orchestratorLoaded: OrchestratorLoaded; orchestratorNagged: OrchestratorNagged }
  }
}
