/**
 * The pieces built so far, wired the way core and client-js will wire them:
 * state → state codec → loopback transport → state codec → applyDelta, with
 * contract messages packed positionally in the other direction. Only bytes
 * cross the transport.
 */
import { expect, test } from "bun:test"
import {
  MessagePackSerializer,
  MessagePackStateCodec,
  packMessage,
  unpackMessage,
} from "@bungohan/serializer"
import {
  applyDelta,
  clearChangeTrees,
  createFixedPoint,
  createSchemaMap,
  createString,
  encodeSnapshot,
  generateDeltas,
  Schema,
  SchemaRegistry,
} from "@bungohan/state"
import { defineMessage, f } from "@bungohan/types"
import { ManualClock } from "./clock"
import { LoopbackTransport } from "./loopback"

class Ship extends Schema {
  public static override schemaName = "E2E.Ship"
  public name = createString()
  public x = createFixedPoint(2)
}

class Space extends Schema {
  public static override schemaName = "E2E.Space"
  public ships = createSchemaMap(f.string, Ship)
}

const Move = defineMessage("move", { dx: f.fixed(2) })

test("a client steers its ship over the loopback, synced at 20 Hz", async () => {
  SchemaRegistry.register(Ship) // the client only ever receives ships
  const clock = new ManualClock()
  const transport = new LoopbackTransport()
  const serializer = new MessagePackSerializer()
  const codec = new MessagePackStateCodec()
  await transport.listen(0)

  // --- "server" ---
  const state = new Space()
  const serverCodec = codec.createSession()
  const clients: string[] = []
  transport.onConnection((clientId) => {
    const ship = new Ship()
    ship.name.set(clientId)
    state.ships.set(clientId, ship)
    // Join at a sync boundary (spec §5.7.10): flush pending deltas first.
    sync()
    clients.push(clientId)
    const snapshot = encodeSnapshot(state).unwrap()
    transport.send(clientId, serverCodec.encodeOps(snapshot).unwrap())
  })
  transport.onMessage((clientId, data) => {
    const move = unpackMessage(Move, serializer.decode(data).unwrap()).unwrap()
    const ship = state.ships.get(clientId)
    ship?.x.set(ship.x.get() + move.dx)
  })
  function sync(): void {
    const ops = generateDeltas(state)
    if (ops.length > 0) {
      transport.broadcast(clients, serverCodec.encodeOps(ops).unwrap())
    }
    clearChangeTrees(state)
  }
  clock.setInterval(sync, 50)

  // --- "client" ---
  const socket = transport.connect().unwrap()
  const replica = new Space()
  const clientCodec = codec.createSession()
  socket.onMessage((data) => {
    const ops = clientCodec.decodeOps(data).unwrap()
    const applied = applyDelta(replica, ops)
    if (applied.isErr()) throw applied.error
  })
  const steer = (dx: number): void => {
    socket.send(serializer.encode(packMessage(Move, { dx }).unwrap()).unwrap())
  }

  await transport.flush()
  expect(replica.ships.get(socket.clientId)?.name.get()).toBe(socket.clientId)

  steer(1.25)
  steer(0.5)
  await transport.flush() // inputs reach the server
  transport.resetStats()
  await clock.advance(50) // one sync tick
  await transport.flush()
  expect(replica.ships.get(socket.clientId)?.x.get()).toBe(1.75)
  // [[0, ref, 1, 175]]: one fixed-point SET, 7 bytes on the wire.
  expect(transport.stats()).toEqual({
    bytesToClients: 7,
    framesToClients: 1,
    bytesFromClients: 0,
    framesFromClients: 0,
  })

  // An idle tick sends nothing at all.
  await clock.advance(50)
  expect(transport.pending()).toBe(0)
})
