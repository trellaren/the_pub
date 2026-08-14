import type { z } from 'zod'

/** A request/response pair for an `ipcRenderer.invoke` channel. */
export interface ChannelDef<Req extends z.ZodType = z.ZodType, Res extends z.ZodType = z.ZodType> {
  req: Req
  res: Res
}

export interface ContractShape {
  /** Renderer → main, returns a value. */
  invoke: Record<string, ChannelDef>
  /** Main → renderer, fire-and-forget push. */
  events: Record<string, z.ZodType>
}

/**
 * Identity function that pins the contract's literal types. Both the main-process
 * handler registry and the preload bridge derive their types from the result, so
 * adding a channel here is the only edit needed to make it type-safe on both sides.
 */
export function defineContract<const T extends ContractShape>(contract: T): T {
  return contract
}

export type InvokeChannel<C extends ContractShape> = keyof C['invoke'] & string
export type EventChannel<C extends ContractShape> = keyof C['events'] & string

export type InvokeReq<C extends ContractShape, K extends InvokeChannel<C>> = z.infer<
  C['invoke'][K]['req']
>
export type InvokeRes<C extends ContractShape, K extends InvokeChannel<C>> = z.infer<
  C['invoke'][K]['res']
>
export type EventPayload<C extends ContractShape, K extends EventChannel<C>> = z.infer<
  C['events'][K]
>
