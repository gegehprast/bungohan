/**
 * Seeded randomized round-trip: random mutations across many ticks, with a
 * fresh late joiner now and then. After every sync, every replica must equal
 * the server, and the server's live refIds must be unique (reuse never hands
 * out a block that is still in use). Each seed must actually reuse refIds.
 * Deterministic (fixed seeds), so failures reproduce.
 */
import { describe, expect, test } from "bun:test"
import { CollectionState } from "./collections"
import { applyDelta } from "./decoder"
import { clearChangeTrees, encodeSnapshot, generateDeltas } from "./encoder"
import { fieldValue, Schema } from "./schema"
import {
  GameRoom,
  type Item,
  item,
  type Player,
  plain,
  player,
} from "./test-fixtures"

/** mulberry32 */
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Every refId held by a known instance or collection reachable from `root`,
 * as refId → holder. Fails on any duplicate.
 */
function liveRefs(root: Schema): Map<number, object> {
  const refs = new Map<number, object>()
  const claim = (ref: number, holder: object): void => {
    const other = refs.get(ref)
    if (other !== undefined && other !== holder) {
      throw new Error(`refId ${ref} is held by two live objects`)
    }
    refs.set(ref, holder)
  }
  const walk = (instance: Schema): void => {
    if (instance._wireRef === -1) throw new Error("unsent instance in tree")
    claim(instance._wireRef, instance)
    for (const field of instance._ensureInit().fields) {
      const value = fieldValue(instance, field.name)
      if (value instanceof Schema) walk(value)
      else if (value instanceof CollectionState) {
        claim(value._wireRef, value)
        for (const element of value._elements()) {
          if (element instanceof Schema) walk(element)
        }
      }
    }
  }
  walk(root)
  return refs
}

/** Returns how many times a refId passed to a different object. */
function run(seed: number, ticks: number): number {
  const random = rng(seed)
  const int = (n: number): number => Math.floor(random() * n)
  const pick = <T>(xs: readonly T[]): T | undefined => xs[int(xs.length)]

  const server = new GameRoom()
  const replicas: GameRoom[] = []
  /** Detached instances kept around to be re-attached later. */
  const limbo: Player[] = []
  const looseItems: Item[] = []

  const join = (): void => {
    const client = new GameRoom()
    const applied = applyDelta(client, encodeSnapshot(server).unwrap())
    if (applied.isErr()) throw applied.error
    replicas.push(client)
  }
  join()

  const players = (): Player[] => [...server.players.values()]
  /** Last holder seen for each refId, to detect reuse. */
  const lastHolder = new Map<number, object>()
  let reuses = 0

  const mutations: Array<() => void> = [
    () => server.tick.set(int(1000)),
    () => server.title.set(pick(["", "a", "b", "lobby"]) ?? ""),
    () => server.speed.set(random() * 10),
    () =>
      server.players.set(`p${int(8)}`, player(`n${int(99)}`, int(500) / 100)),
    () => {
      const key = pick([...server.players.keys()])
      if (key === undefined) return
      const removed = server.players.get(key)
      server.players.delete(key)
      if (removed !== undefined && random() < 0.5) limbo.push(removed)
    },
    () => {
      const back = limbo.pop()
      if (back !== undefined && back._parent === undefined) {
        server.players.set(`r${int(8)}`, back)
      }
    },
    () => {
      if (random() < 0.1) server.players.clear()
    },
    () => {
      const p = pick(players())
      p?.x.set(int(100000) / 100 - 500)
    },
    () => pick(players())?.hp.set(int(3) === 0 ? 0 : int(200)),
    () => pick(players())?.alive.set(random() < 0.5),
    () => pick(players())?.pos.x.set(int(50)),
    () => pick(players())?.name.set(`n${int(99)}`),
    () => pick(players())?.items.push(item(`i${int(9)}`, int(5))),
    () => pick(players())?.items.shift(),
    () => pick(players())?.items.pop(),
    () => {
      const p = pick(players())
      if (p === undefined || p.items.length === 0) return
      p.items.splice(int(p.items.length), int(3), item(`s${int(9)}`))
    },
    () => pick(players())?.items.reverse(),
    () => pick(players())?.items.sort((a, b) => a.qty.get() - b.qty.get()),
    () => {
      const p = pick(players())
      if (p !== undefined && p.items.length > 0) {
        p.items.set(int(p.items.length), item(`r${int(9)}`))
      }
    },
    () => pick(players())?.items.at(0)?.qty.set(int(9)),
    () => {
      // move an item between two players
      const from = pick(players())
      const to = pick(players())
      if (from === undefined || to === undefined || from.items.length === 0)
        return
      const moved = from.items.shift()
      if (moved !== undefined) to.items.push(moved)
    },
    () => pick(players())?.tags.add(`t${int(5)}`),
    () => pick(players())?.tags.delete(`t${int(5)}`),
    () => pick(players())?.scores.set(`k${int(4)}`, int(10)),
    () => pick(players())?.scores.delete(`k${int(4)}`),
    () => server.log.push(`l${int(20)}`),
    () => server.log.splice(int(server.log.length + 1), int(2), `x${int(9)}`),
    () => server.log.sort(),
    () => {
      if (random() < 0.2) server.log.clear()
    },
    () => {
      const it = looseItems.pop() ?? item(`b${int(9)}`, int(3))
      server.bag.add(it)
    },
    () => {
      const it = pick([...server.bag])
      if (it === undefined) return
      server.bag.delete(it)
      if (random() < 0.5) looseItems.push(it)
    },
    () => pick([...server.bag])?.qty.set(int(20)),
  ]

  for (let t = 0; t < ticks; t++) {
    const count = int(6)
    for (let i = 0; i < count; i++) pick(mutations)?.()

    const ops = generateDeltas(server)
    for (const client of replicas) {
      const applied = applyDelta(client, ops)
      if (applied.isErr()) {
        throw new Error(
          `seed ${seed} tick ${t}: ${applied.error.message} ${JSON.stringify(applied.error.context)}`,
        )
      }
    }
    clearChangeTrees(server)

    const expected = plain(server)
    for (const client of replicas) {
      expect({ seed, tick: t, state: plain(client) }).toEqual({
        seed,
        tick: t,
        state: expected,
      })
    }
    for (const [ref, holder] of liveRefs(server)) {
      const previous = lastHolder.get(ref)
      if (previous !== undefined && previous !== holder) reuses++
      lastHolder.set(ref, holder)
    }

    if (t % 25 === 24) join()
  }
  return reuses
}

describe("randomized round-trip", () => {
  for (const seed of [1, 2, 3, 42, 1337, 9001]) {
    test(`seed ${seed}`, () => {
      expect(run(seed, 200)).toBeGreaterThan(0)
    })
  }
})
