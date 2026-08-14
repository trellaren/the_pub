/**
 * Channel allow-list for the preload bridge.
 *
 * Kept separate from `contract.ts` so the preload bundle carries only these
 * strings instead of the whole zod schema graph. `contract.ts` asserts at compile
 * time that these lists exactly match the contract, so they cannot drift.
 */
export const INVOKE_CHANNELS = [
  'app:getState',
  'app:setTheme',
  'project:openDialog',
  'project:open',
  'project:close',
  'project:updateManifest',
  'vfs:list',
  'vfs:stat',
  'vfs:mkdir',
  'vfs:rename',
  'vfs:delete',
  'vfs:revealInOs',
  'doc:read',
  'doc:resolve',
  'doc:create',
  'doc:write',
  'doc:writeAsset',
  'search:query',
  'search:reindex',
  'search:status',
  'layout:load',
  'layout:saveLast',
  'layout:savePreset',
  'layout:deletePreset',
  'snapshot:list',
  'snapshot:read',
  'window:newProject',
  'window:closeConfirmed'
] as const

export const EVENT_CHANNELS = [
  'vfs:changed',
  'search:indexProgress',
  'app:stateChanged',
  'command:invoke',
  'window:requestClose'
] as const

export type InvokeChannelName = (typeof INVOKE_CHANNELS)[number]
export type EventChannelName = (typeof EVENT_CHANNELS)[number]
