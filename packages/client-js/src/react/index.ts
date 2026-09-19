/**
 * React bindings for client-js (spec §7.4), at `@bungohan/client-js/react`.
 * A JS-only convenience layer, not part of the protocol. `react` is a peer
 * dependency, and the main entry never imports this module.
 */
import type { Schema } from "@bungohan/state"
import type { Contract, EmptyContract, Infer, SendMap } from "@bungohan/types"
import {
  createContext,
  createElement,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react"
import type { IBungohanClient } from "../client"
import type { ClientError } from "../errors"
import type { IRoom, JoinOptions } from "../room"

const BungohanContext = createContext<IBungohanClient | undefined>(undefined)

export interface BungohanProviderProps {
  client: IBungohanClient
  children?: ReactNode
}

/** Provides a client to every descendant's {@link useBungohan}. */
export function BungohanProvider(props: BungohanProviderProps): ReactNode {
  return createElement(
    BungohanContext.Provider,
    { value: props.client },
    props.children,
  )
}

/**
 * The provided client. Throws outside a `<BungohanProvider>`: that is a
 * setup error in the component tree, like any missing React context.
 */
export function useBungohan(): IBungohanClient {
  const client = useContext(BungohanContext)
  if (client === undefined) {
    throw new Error("useBungohan() must be used inside <BungohanProvider>")
  }
  return client
}

export type RoomJoinMode = "join" | "create" | "joinOrCreate"

export interface UseRoomResult<S extends Schema, C extends Contract> {
  /** Set once the join completed; undefined again after the room is left. */
  room: IRoom<S, C> | undefined
  /**
   * `connecting` until the join completes, then `connected`. `error` if
   * the join failed (see `error`). `left` once the room was left from the
   * server's side (kicked, disposed, connection lost for good).
   */
  status: "connecting" | "connected" | "error" | "left"
  error?: ClientError
  /** The `LeaveCode` when `status` is `left`. */
  leaveCode?: number
}

/**
 * Joins a room for the component's lifetime: joins on mount, leaves on
 * unmount (and when `roomType` or `mode` change, then joins again).
 * `options` and `join` are read when the join starts; changing them later
 * doesn't rejoin. Pass `join` (`{ state, contract }`) to type the room and
 * get a replica.
 */
export function useRoom<
  S extends Schema = Schema,
  C extends Contract = EmptyContract,
>(
  roomType: string,
  options?: unknown,
  mode: RoomJoinMode = "joinOrCreate",
  join?: JoinOptions<S, C>,
): UseRoomResult<S, C> {
  const client = useBungohan()
  const [result, setResult] = useState<UseRoomResult<S, C>>({
    room: undefined,
    status: "connecting",
  })
  const latest = useRef({ options, join })
  latest.current = { options, join }

  useEffect(() => {
    let active = true
    let room: IRoom<S, C> | undefined
    let offLeave: (() => void) | undefined
    setResult({ room: undefined, status: "connecting" })
    const { options: joinOptions, join: joinWith } = latest.current
    const joining =
      mode === "join"
        ? client.join(roomType, joinOptions, joinWith)
        : mode === "create"
          ? client.create(roomType, joinOptions, joinWith)
          : client.joinOrCreate(roomType, joinOptions, joinWith)
    void joining.then((joined) => {
      if (joined.isErr()) {
        if (active) {
          setResult({ room: undefined, status: "error", error: joined.error })
        }
        return
      }
      room = joined.value
      // Unmounted (or re-keyed) while joining: give the seat back.
      if (!active) {
        void room.leave()
        return
      }
      offLeave = room.onLeave((code) => {
        room = undefined
        if (active)
          setResult({ room: undefined, status: "left", leaveCode: code })
      })
      setResult({ room, status: "connected" })
    })
    return () => {
      active = false
      offLeave?.()
      if (room !== undefined && room.status !== "left") void room.leave()
    }
  }, [client, roomType, mode])

  return result
}

/**
 * Shallow equality: `Object.is`, or same-prototype arrays / objects whose
 * elements / own keys are `Object.is`-equal.
 */
export function shallowEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (
    typeof a !== "object" ||
    typeof b !== "object" ||
    a === null ||
    b === null ||
    Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)
  ) {
    return false
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => Object.is(v, b[i]))
  }
  const keysA = Object.keys(a)
  const keysB = Object.keys(b)
  if (keysA.length !== keysB.length) return false
  const recordA = a as Record<string, unknown>
  const recordB = b as Record<string, unknown>
  return keysA.every(
    (key) => Object.hasOwn(b, key) && Object.is(recordA[key], recordB[key]),
  )
}

const unsubscribed = () => {}

/**
 * The room's state, re-rendering on change.
 *
 * - Without a selector: returns `room.state` and re-renders after every
 *   applied state frame (the replica is mutated in place, so its identity
 *   alone wouldn't signal a change).
 * - With a selector: returns `selector(room.state)` and re-renders only
 *   when that value changes, compared shallowly ({@link shallowEqual}). So
 *   select plain values (`s => s.score.get()`,
 *   `s => [...s.players.keys()]`), not live wrappers, whose identity never
 *   changes.
 *
 * Undefined while `room` is.
 */
export function useRoomState<S extends Schema>(
  room: IRoom<S, Contract> | undefined,
): Readonly<S> | undefined
export function useRoomState<S extends Schema, R>(
  room: IRoom<S, Contract> | undefined,
  selector: (state: Readonly<S>) => R,
): R | undefined
export function useRoomState<S extends Schema, R>(
  room: IRoom<S, Contract> | undefined,
  selector?: (state: Readonly<S>) => R,
): Readonly<S> | R | undefined {
  const selectorRef = useRef(selector)
  selectorRef.current = selector
  const version = useRef(0)
  const cache = useRef<{ room: unknown; value: R } | undefined>(undefined)

  const subscribe = useCallback(
    (notify: () => void) => {
      if (room === undefined) return unsubscribed
      return room.onStateChange(() => {
        version.current++
        notify()
      })
    },
    [room],
  )

  const getSnapshot = (): number | R | undefined => {
    if (room === undefined) return undefined
    const select = selectorRef.current
    if (select === undefined) return version.current
    const next = select(room.state)
    const cached = cache.current
    if (
      cached !== undefined &&
      cached.room === room &&
      shallowEqual(cached.value, next)
    ) {
      return cached.value
    }
    cache.current = { room, value: next }
    return next
  }

  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  if (room === undefined) return undefined
  return selector === undefined ? room.state : (snapshot as R)
}

/**
 * Subscribes to one contract message for the component's lifetime. The
 * latest `cb` is always the one called, so it needn't be memoized.
 */
export function useRoomMessage<
  S extends Schema,
  C extends Contract,
  K extends keyof SendMap<C> & string,
>(
  room: IRoom<S, C> | undefined,
  type: K,
  cb: (message: Infer<SendMap<C>[K]>) => void,
): void {
  const cbRef = useRef(cb)
  cbRef.current = cb
  useEffect(() => {
    if (room === undefined) return undefined
    return room.onMessage(type, (message) => cbRef.current(message))
  }, [room, type])
}
