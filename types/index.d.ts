export type RemindedSession = string
export type OpenLaunches = string[]

declare module 'claude-code' {
  interface PluginState {
    'dispatch-guard': { remindedSession: RemindedSession; openLaunches: OpenLaunches }
  }
}
