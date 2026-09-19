/**
 * Seeded randomized round-trip: random mutations across many ticks, with a
 * fresh late joiner now and then. After every sync, every replica must equal
 * the server, share objects exactly where the server does, and the server's
 * live refIds must be unique and assigned (reuse never hands out a block
 * that is still in use, and nothing in the tree was forgotten). Each seed
 * must actually reuse refIds.
 *
 * The mutations include the object moves that nested fields make delicate
 * (spec §5.7.9): replacing nested fields, moving items between collections
 * and nested fields in one tick, sharing items between collections (also
 * with detached players that come back later), and attempts the rules must
 * refuse. Every console error must be such a refusal, and each seed must
 * hit some. Deterministic (fixed seeds), so failures reproduce.
 */
import { describe, expect, test } from "bun:test"
import { f } from "@bungohan/types"
import { ArrayBase, MapBase, SetBase } from "./collections"
import { applyDelta } from "./decoder"
import { clearChangeTrees, encodeSnapshot, generateDeltas } from "./encoder"
import { createSchemaMap } from "./factories"
import { fieldValue, Schema } from "./schema"
import { SchemaRegistry } from "./schema-registry"
import {
  GameRoom,
  Item,
  item,
  liveRefs,
  Player,
  plain,
  Vec,
} from "./test-fixtures"

/** Fuzz-only subclasses (elements may be subclasses): a nested Item each. */
class FuzzPlayer extends Player {
  public static override schemaName = "F.Player"
  public held = new Item()
}

class FuzzRoom extends GameRoom {
  public static override schemaName = "F.Room"
  public featured = new Item()
  public stash = createSchemaMap(f.string, Item)
}

SchemaRegistry.register(FuzzPlayer, FuzzRoom)

function fuzzPlayer(name: string, x = 0): FuzzPlayer {
  const p = new FuzzPlayer()
  p.name.set(name)
  p.x.set(x)
  return p
}

/**
 * Which objects are reachable along more than one path: each such object's
 * sorted paths, sorted. Peers must agree, or a client shares an object the
 * server doesn't (or the reverse), which values alone can hide. Set
 * elements are named by content, since set order isn't synchronized.
 */
function aliases(root: Schema): string[] {
  const paths = new Map<Schema, string[]>()
  const onPath = new Set<Schema>()
  const walk = (instance: Schema, path: string): void => {
    if (onPath.has(instance)) throw new Error(`cycle at ${path}`)
    const list = paths.get(instance) ?? []
    list.push(path)
    paths.set(instance, list)
    onPath.add(instance)
    for (const field of instance._ensureInit().fields) {
      const value = fieldValue(instance, field.name)
      const at = `${path}.${field.name}`
      if (value instanceof Schema) walk(value, at)
      else if (value instanceof MapBase) {
        for (const [key, element] of value) {
          if (element instanceof Schema) walk(element, `${at}[${key}]`)
        }
      } else if (value instanceof SetBase) {
        for (const element of value) {
          if (element instanceof Schema) {
            walk(element, `${at}{${JSON.stringify(plain(element))}}`)
          }
        }
      } else if (value instanceof ArrayBase) {
        value.forEach((element, index) => {
          if (element instanceof Schema) walk(element, `${at}[${index}]`)
        })
      }
    }
    onPath.delete(instance)
  }
  walk(root, "")
  return [...paths.values()]
    .filter((list) => list.length > 1)
    .map((list) => list.sort().join(" = "))
    .sort()
}

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

interface RunStats {
  /** Times a refId passed to a different object. */
  reuses: number
  /** Assignments/adds the rules refused. */
  refusals: number
}

function run(seed: number, ticks: number): RunStats {
  const random = rng(seed)
  const int = (n: number): number => Math.floor(random() * n)
  const pick = <T>(xs: readonly T[]): T | undefined => xs[int(xs.length)]

  const server = new FuzzRoom()
  const replicas: FuzzRoom[] = []
  /** Detached instances kept around to be re-attached later. */
  const limbo: FuzzPlayer[] = []
  const looseItems: Item[] = []

  const join = (): void => {
    const client = new FuzzRoom()
    const applied = applyDelta(client, encodeSnapshot(server).unwrap())
    if (applied.isErr()) throw applied.error
    replicas.push(client)
  }
  join()

  const players = (): FuzzPlayer[] =>
    [...server.players.values()].filter(
      (p): p is FuzzPlayer => p instanceof FuzzPlayer,
    )
  /** Every item in the tree, with duplicates for shared ones. */
  const items = (): Item[] => [
    server.featured,
    ...server.bag,
    ...server.stash.values(),
    ...players().flatMap((p) => [p.held, ...p.items]),
  ]
  /** Items held by some collection (never by a nested field). */
  const collected = (): Item[] => [
    ...server.bag,
    ...server.stash.values(),
    ...players().flatMap((p) => [...p.items]),
  ]
  /** A nested Item field to assign: a player's `held` or the room's. */
  const nestedTarget = (): ((value: Item) => void) => {
    const p = pick(players())
    return p === undefined || random() < 0.3
      ? (value) => {
          server.featured = value
        }
      : (value) => {
          p.held = value
        }
  }
  /** Adds `value` to a random Item collection (no duplicate in an array). */
  const addSomewhere = (value: Item): void => {
    const p = pick([...players(), ...limbo])
    if (random() < 0.25) server.stash.set(`k${int(6)}`, value)
    else if (p === undefined || random() < 0.4) server.bag.add(value)
    else if (!p.items.includes(value)) {
      if (random() < 0.5) p.items.push(value)
      else p.items.splice(int(p.items.length + 1), 0, value)
    }
  }
  /** Removes `value` from every collection in the tree (it may be shared). */
  const removeEverywhere = (value: Item): void => {
    server.bag.delete(value)
    for (const [key, held] of [...server.stash]) {
      if (held === value) server.stash.delete(key)
    }
    for (const p of players()) {
      const index = p.items.indexOf(value)
      if (index !== -1) p.items.splice(index, 1)
    }
  }
  let refusals = 0
  /** Last holder seen for each refId, to detect reuse. */
  const lastHolder = new Map<number, object>()
  let reuses = 0

  const mutations: Array<() => void> = [
    () => server.tick.set(int(1000)),
    () => server.title.set(pick(["", "a", "b", "lobby"]) ?? ""),
    () => server.speed.set(random() * 10),
    () =>
      server.players.set(
        `p${int(8)}`,
        fuzzPlayer(`n${int(99)}`, int(500) / 100),
      ),
    () => {
      const key = pick([...server.players.keys()])
      if (key === undefined) return
      const removed = server.players.get(key)
      server.players.delete(key)
      if (removed instanceof FuzzPlayer && random() < 0.5) limbo.push(removed)
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
      if (moved !== undefined && !to.items.includes(moved)) to.items.push(moved)
    },
    () => pick(players())?.tags.add(`t${int(5)}`),
    () => pick(players())?.tags.delete(`t${int(5)}`),
    // Fractional: fixed:1 quantization decides whether anything is sent.
    () => pick(players())?.scores.set(`k${int(4)}`, int(1000) / 37),
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
    // float32 elements, including rewrites below the wire resolution
    () => server.samples.push(random() * 10),
    () => {
      const i = int(server.samples.length)
      const v = server.samples.get(i)
      if (v !== undefined) server.samples.set(i, v + 1e-12)
    },
    () => {
      if (server.samples.length > 0)
        server.samples.set(int(server.samples.length), random())
    },
    () => server.samples.splice(int(server.samples.length + 1), int(2)),
    () => server.samples.sort((a, b) => a - b),
    // integer keys
    () => server.ranks.set(int(20), random() < 0.5),
    () => server.ranks.delete(int(20)),
    () => {
      if (random() < 0.1) server.ranks.clear()
    },
  ]

  /** Object moves around nested fields (spec §5.7.9), picked half the time. */
  const moves: Array<() => void> = [
    // replace a nested field with a fresh instance
    () => nestedTarget()(item(`h${int(9)}`, int(5))),
    () => {
      const p = pick(players())
      if (p === undefined) return
      const pos = new Vec()
      pos.x.set(int(9))
      p.pos = pos
    },
    () => pick(items())?.qty.set(int(30)),
    // move a collection item into a nested field: remove it first
    () => {
      const moved = pick(collected())
      if (moved === undefined) return
      removeEverywhere(moved)
      nestedTarget()(moved)
    },
    // ...or without removing it: must be refused unless it was detached
    () => {
      const moved = pick(collected())
      if (moved !== undefined) nestedTarget()(moved)
    },
    // move a nested item into a collection: clear the field first
    () => {
      const p = pick(players())
      const fromRoom = p === undefined || random() < 0.3
      const moved = fromRoom ? server.featured : p.held
      if (fromRoom) server.featured = item(`f${int(9)}`)
      else p.held = item(`g${int(9)}`)
      addSomewhere(moved)
    },
    // ...or without clearing it: must be refused
    () => {
      const p = pick(players())
      addSomewhere(p === undefined ? server.featured : p.held)
    },
    // one nested item assigned to another nested field: refused
    () => {
      const p = pick(players())
      if (p !== undefined) nestedTarget()(p.held)
    },
    // share an item between collections
    () => {
      const shared = pick(collected())
      if (shared !== undefined) addSomewhere(shared)
    },
    () => {
      const shared = pick(collected())
      if (shared !== undefined) removeEverywhere(shared)
    },
    // a new player holding already-attached items, linked on attach
    () => {
      const p = fuzzPlayer(`s${int(99)}`)
      for (const shared of [pick(collected()), pick(collected())]) {
        if (shared !== undefined && !p.items.includes(shared)) {
          p.items.push(shared)
        }
      }
      server.players.set(`q${int(8)}`, p)
    },
    // a detached item goes into a nested field
    () => {
      const loose = looseItems.pop()
      if (loose !== undefined) nestedTarget()(loose)
    },
    // a shared item leaves one holder only; a nested field must still
    // refuse it, since another collection holds it
    () => {
      const all = collected()
      const x = pick(all.filter((it, i) => all.indexOf(it) !== i))
      if (x === undefined) return
      const p = players().find((q) => q.items.includes(x))
      const key = [...server.stash].find(([, it]) => it === x)?.[0]
      if (server.bag.has(x) && random() < 0.5) server.bag.delete(x)
      else if (p !== undefined) p.items.splice(p.items.indexOf(x), 1)
      else if (key !== undefined) server.stash.delete(key)
      if (random() < 0.5) nestedTarget()(x)
    },
    // through a nested field and back to the same place, in one tick
    () => {
      const key = pick([...server.stash.keys()])
      const fromBag = random() < 0.5 ? pick([...server.bag]) : undefined
      const x =
        fromBag ?? (key === undefined ? undefined : server.stash.get(key))
      if (x === undefined) return
      removeEverywhere(x)
      const put = nestedTarget()
      put(x)
      put(item(`t${int(9)}`))
      if (fromBag !== undefined) server.bag.add(x)
      else if (key !== undefined) server.stash.set(key, x)
    },
    // an item map, which may also hold one item under two keys
    () => {
      const it = pick(collected()) ?? item(`m${int(9)}`, int(4))
      server.stash.set(`k${int(6)}`, it)
    },
    () => server.stash.delete(`k${int(6)}`),
    () => {
      if (random() < 0.1) server.stash.clear()
    },
  ]

  const original = console.error
  const tick = (t: number): void => {
    const logged: string[] = []
    console.error = (...args: unknown[]) => logged.push(String(args[0]))
    const count = int(6)
    for (let i = 0; i < count; i++) {
      const list = random() < 0.5 ? moves : mutations
      const mutation = pick(list)
      // FUZZ_TRACE=1 bun test fuzz.test.ts -t "seed 5$" lists each tick's
      // mutations; FUZZ_FROM=<tick> also prints the ops from that tick on.
      if (process.env.FUZZ_TRACE) {
        original(`t${t}`, String(mutation).replace(/\s+/g, " ").slice(0, 150))
      }
      mutation?.()
    }
    console.error = original
    for (const message of logged) {
      if (!message.includes("refusing")) {
        throw new Error(`seed ${seed} tick ${t}: unexpected error ${message}`)
      }
    }
    refusals += logged.length

    const ops = generateDeltas(server)
    if (process.env.FUZZ_TRACE && t >= Number(process.env.FUZZ_FROM ?? 1e9)) {
      original(JSON.stringify(ops))
    }
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
    const shared = aliases(server)
    for (const client of replicas) {
      expect({ seed, tick: t, state: plain(client) }).toEqual({
        seed,
        tick: t,
        state: expected,
      })
      expect({ seed, tick: t, shared: aliases(client) }).toEqual({
        seed,
        tick: t,
        shared,
      })
    }
    for (const [ref, holder] of liveRefs(server)) {
      const previous = lastHolder.get(ref)
      if (previous !== undefined && previous !== holder) reuses++
      lastHolder.set(ref, holder)
    }

    if (t % 25 === 24) join()
  }

  try {
    for (let t = 0; t < ticks; t++) tick(t)
  } finally {
    console.error = original
  }
  return { reuses, refusals }
}

describe("randomized round-trip", () => {
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8, 42, 1337, 9001, 31337]) {
    test(`seed ${seed}`, () => {
      const stats = run(seed, 500)
      expect(stats.reuses).toBeGreaterThan(0)
      expect(stats.refusals).toBeGreaterThan(0)
    })
  }
})
