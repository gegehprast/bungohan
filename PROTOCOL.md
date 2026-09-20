# Bungohan Wire Protocol — `bungohan.v1`

This document specifies everything a client needs to talk to a Bungohan
server: how to connect, every byte of every frame, the join handshake, state
synchronization, and both state codecs. It is written for someone implementing
a client in another language (C# for Unity, GDScript or C# for Godot, Rust, …)
and does not assume any knowledge of the server's source code.

The conformance vectors in `conformance/v1/` are the executable form of this
document. A client that decodes (and, where it sends, encodes) every vector
byte for byte implements this document. §14 describes the vector format.

Contents:

1. Conventions
2. Connection and version negotiation
3. Frames
4. Control bodies (MessagePack)
5. Frame reference
6. Joining
7. Leaving, reconnection, reservations, ping
8. Errors and close codes
9. Forward compatibility
10. Contract messages
11. State synchronization
12. Numeric rules
13. State codecs: `schema` and `messagepack`
14. Conformance vectors
15. Notes for implementers

---

## 1. Conventions

**MUST / SHOULD / MAY** have their RFC 2119 meanings.

**Bytes** are written in hexadecimal: `03 01 00 3a` is four bytes.

**Byte order** is little-endian wherever a multi-byte fixed-width number
appears (only IEEE 754 floats do). Variable-length integers use the varint
format below. MessagePack (§4) uses its own big-endian formats, as the
MessagePack specification defines them.

### 1.1 Varint

An unsigned integer `0 … 4294967295` (`2^32 − 1`) written as unsigned LEB128:
seven bits per byte, least significant group first. The high bit (`0x80`) of
each byte is set when another byte follows.

```
value         bytes
0             00
1             01
127           7f
128           80 01
300           ac 02
16383         ff 7f
16384         80 80 01
4294967295    ff ff ff ff 0f
```

- Encoders MUST write the shortest form.
- A varint is at most **5 bytes**. Decoders MUST reject one that is truncated,
  whose fifth byte has its high bit set (longer than 5 bytes), or whose value
  exceeds `4294967295` (fifth byte greater than `0x0f`).
- Decoders accept a non-shortest form of 5 bytes or fewer (`80 00` reads
  as 0). No encoder produces one.

The same varint is used everywhere: frame headers, counts, lengths, refIds,
class ids, field indices, and the integer payloads below.

### 1.2 Zigzag

Signed 32-bit integers are mapped to unsigned before being written as a
varint, so small negative numbers stay short:

```
encode: u = (n << 1) XOR (n >> 31)     n as int32, ">>" is arithmetic, u as uint32
decode: n = (u >>> 1) XOR −(u AND 1)   ">>>" is logical

 0 → 0     −1 → 1     1 → 2     −2 → 3     2 → 4
 2147483647 → 4294967294     −2147483648 → 4294967295
```

A zigzag varint therefore takes 1 byte for `−64 … 63`, 2 bytes for
`−8192 … 8191`, 3 bytes for `−1048576 … 1048575`, and at most 5.

### 1.3 Strings

A string is its **UTF-8** byte length as a varint, then those bytes. No
terminator. The empty string is the single byte `00`.

- Decoders MUST reject invalid UTF-8 (overlong forms, encoded surrogates,
  truncated sequences, code points above U+10FFFF), exactly like a strict
  ("fatal") decoder.
- A string is a sequence of Unicode scalar values. An encoder whose native
  strings can contain a lone UTF-16 surrogate writes it as U+FFFD
  (`ef bf bd`).
- Encoders write **U+0000** as U+FFFD (`ef bf bd`) too. Some engines'
  strings can't hold it (a Godot `String`), so a NUL on the wire would
  decode differently from one client to the next. Decoders still accept
  `00` inside a string (it is valid UTF-8); no encoder produces it.
- Both rules apply wherever a string is encoded: `schema` codec strings,
  MessagePack strings and map keys (§4), in every frame body.
- A length larger than the number of bytes remaining in the body is
  malformed.

### 1.4 Floats

`float64` is 8 bytes and `float32` is 4 bytes, IEEE 754 binary64/binary32,
little-endian.

- **NaN** is written as the canonical quiet NaN: `00 00 00 00 00 00 f8 7f`
  (float64) and `00 00 c0 7f` (float32). Decoders accept any NaN bit pattern
  and treat it as NaN.
- **−0** keeps its sign bit (`00 00 00 00 00 00 00 80`). ±Infinity are
  allowed.
- Writing a number as `float32` rounds it to the nearest binary32 value (ties
  to even), as a C `(float)` cast or C# `(float)` conversion does.

### 1.5 Malformed input

"Malformed" means the receiver rejects the whole frame. What happens next
depends on the direction and is specified per frame (§8): the server treats a
malformed client frame as a protocol violation; a client treats a malformed
state frame as a desync (§11.10).

---

## 2. Connection and version negotiation

The transport is **WebSocket** (RFC 6455). Every frame of this protocol is one
**binary** WebSocket message; a message is never split into several frames,
and a frame never spans several messages.

### 2.1 Opening a connection

The client opens a WebSocket to the server's URL and offers the protocol
version as a **subprotocol**:

```
GET /?token=abc HTTP/1.1
Sec-WebSocket-Protocol: bungohan.v1
```

- The version string is **`bungohan.v1`**. A client supporting several
  versions offers them all, most preferred first.
- An authentication token MAY be passed as the `token` query parameter or as
  `Authorization: Bearer <token>`. The server hands it to the room's
  authentication hook; the protocol itself doesn't interpret it. Browsers
  can't set headers on a WebSocket, so the query parameter is the portable
  choice.

### 2.2 Negotiation

The server picks the first version on its own list that the client offered
and answers with it in `Sec-WebSocket-Protocol`.

If the client offered no version the server accepts, the server **completes
the upgrade anyway, echoing the client's first offer, and immediately closes**
the connection with close code **`1002`** and a readable reason, one of:

```
unsupported protocol bungohan.v0; expected bungohan.v1
no protocol version offered; expected bungohan.v1
```

(clipped to WebSocket's 123-byte limit on close reasons). It does not refuse
the HTTP upgrade, because browsers report a refused upgrade with no status and
no body. A client that receives close code 1002 MUST NOT retry automatically:
it is too old or too new for this server.

No frame is parsed on a connection before the version is agreed. That keeps
negotiation working even if a later version changes the frame format itself.

### 2.3 Text messages

The protocol never sends text WebSocket messages. A text message received by
either side is treated as a binary frame of its UTF-8 bytes, which almost
always fails to parse.

---

## 3. Frames

Every WebSocket message is exactly one frame:

```
frame = type:u8  header:varint × N(type)  body:bytes
```

- `type` is one byte.
- It is followed by exactly `N(type)` varints (§1.1). `N` is fixed per frame
  type and direction (tables below).
- The **body** is every remaining byte of the message. It has no length
  prefix. It is one of:
  - **empty**: zero bytes. A receiver ignores any bytes present in a body
    specified as empty.
  - **mp**: one MessagePack value (§4).
  - **codec**: bytes defined by the room's state codec (§13), carried as-is.

Client → server frames:

| type | Frame | Header (`N`) | Body |
|---|---|---|---|
| `00` | `ROOM_MESSAGE` | `roomRef`, `messageId` (2) | codec: the contract message (§10) |
| `01` | `ROOM_MESSAGE_RAW` | `roomRef` (1) | mp: `[type: string, payload: any]` |
| `02` | `JOIN` | `requestId` (1) | mp: `[mode, target, options, contractHash]` (§6.2) |
| `03` | `LEAVE` | `roomRef` (1) | empty |
| `04` | `PING` | `nonce`, `rtt` (2) | empty |

Server → client frames:

| type | Frame | Header (`N`) | Body |
|---|---|---|---|
| `00` | `ROOM_MESSAGE` | `roomRef`, `messageId` (2) | codec: the contract message (§10) |
| `01` | `ROOM_MESSAGE_RAW` | `roomRef` (1) | mp: `[type: string, payload: any]` |
| `02` | `STATE_SNAPSHOT` | `roomRef` (1) | codec: the full state (§11) |
| `03` | `STATE_PATCH` | `roomRef` (1) | codec: one sync tick's changes (§11) |
| `04` | `JOIN_SUCCESS` | `requestId`, `roomRef` (2) | mp: the handshake (§6.4) |
| `05` | `JOIN_ERROR` | `requestId` (1) | mp: `[code: string, message: string]` |
| `06` | `CLIENT_JOINED` | `roomRef` (1) | mp: `sessionId: string` |
| `07` | `CLIENT_LEFT` | `roomRef` (1) | mp: `sessionId: string` |
| `08` | `LEAVE` | `roomRef`, `code` (2) | empty, or mp: `reason: string` |
| `09` | `ERROR` | `roomRef` (1) | mp: `[code: string, message: string]` |
| `0a` | `PONG` | `nonce` (1) | empty |

Example: `STATE_PATCH` for roomRef 1 whose body is the five codec bytes
`00 3a ac e3 01`:

```
03 01 00 3a ac e3 01
```

A frame whose header can't be read (truncated or invalid varint) is
malformed. What a receiver does with a frame type it doesn't know is a
compatibility rule (§9.2), not a parse error.

### 3.1 `roomRef`

`roomRef` is a small per-connection handle for one seat in one room. The
server assigns it in `JOIN_SUCCESS`, counting up from `1` on each connection,
and **never reuses a value on that connection**, even after the client left
the room. A new connection (including a reconnect) starts again at `1`. One
connection may hold seats in several rooms at once; every room frame carries
its `roomRef`. `roomRef` `0` is never a room: in `ERROR` it means "the whole
connection".

---

## 4. Control bodies (MessagePack)

Bodies marked **mp** are one value encoded with [MessagePack](https://github.com/msgpack/msgpack/blob/master/spec.md).
The same rules apply to the `messagepack` state codec (§13.2).

**Decoders** accept any valid MessagePack encoding of a value (for example an
integer in a wider format than needed, or a `float32`). A body with bytes left
over after the value, or a truncated value, is malformed, and so is a string
(or map key) that isn't valid UTF-8 (§1.3). Map keys MUST be strings, and the
key `__proto__` is malformed.

**Encoders** write each value in exactly one way, so output is byte-exact:

| Value | Encoding |
|---|---|
| null / absent | `c0` |
| false / true | `c2` / `c3` |
| integer `0 … 127` | positive fixint: `00 … 7f` |
| integer `−32 … −1` | negative fixint: `e0 … ff` |
| integer `128 … 2^53−1` | the first of `cc` uint8, `cd` uint16, `ce` uint32, `cf` uint64 that fits |
| integer `−(2^53−1) … −33` | the first of `d0` int8, `d1` int16, `d2` int32, `d3` int64 that fits |
| any other number | `cb` float64 (NaN as `cb 7f f8 00 00 00 00 00 00`) |
| string of `n` UTF-8 bytes | `a0\|n` fixstr (`n ≤ 31`), else `d9` str8, `da` str16, `db` str32 |
| array of `n` elements | `90\|n` fixarray (`n ≤ 15`), else `dc` array16, `dd` array32 |
| map of `n` entries | `80\|n` fixmap (`n ≤ 15`), else `de` map16, `df` map32; entries in insertion order |

"Integer" means a number with no fractional part whose magnitude is at most
`2^53 − 1`. So `2.0` is written as `02`, **`−0` is written as `00`** (the
MessagePack codec does not preserve the sign of zero), and `2^53` is written
as a float64. Integers are never written as `float32`/`float64`, and
non-integers are never written as `float32`. A map entry whose value is absent
is left out.

Examples: `"é"` → `a2 c3 a9`; `[1, "a", null]` → `93 01 a1 61 c0`;
`255` → `cc ff`; `-33` → `d0 df`; `1.5` → `cb 3f f8 00 00 00 00 00 00`.

---

## 5. Frame reference

### 5.1 Client → server

- **`ROOM_MESSAGE` (00)** `roomRef, messageId` + codec. A contract message
  (§10) for the room at `roomRef`. `messageId` indexes the room's
  `clientMessages` table (§6.4). The body is encoded with the room's codec.
- **`ROOM_MESSAGE_RAW` (01)** `roomRef` + mp `[type, payload]`. An untyped
  message: `type` is its name and `payload` is any MessagePack value. Raw
  messages are never in the message tables.
- **`JOIN` (02)** `requestId` + mp. See §6.2.
- **`LEAVE` (03)** `roomRef`. Leave the room (§7.1).
- **`PING` (04)** `nonce, rtt`. The server answers at once with
  `PONG(nonce)`. `nonce` is any value the client chooses. `rtt` is the
  client's last measured round-trip time in whole milliseconds (a round trip
  under 1 ms is reported as `1`), or `0` if it has none yet. The server uses
  `rtt` for metrics only.

Example, `PING(nonce 7, rtt 42)`: `04 07 2a`.

### 5.2 Server → client

- **`ROOM_MESSAGE` (00)** `roomRef, messageId` + codec. `messageId` indexes
  `serverMessages` (§6.4). The client and server tables are separate id
  spaces.
- **`ROOM_MESSAGE_RAW` (01)** `roomRef` + mp `[type, payload]`.
- **`STATE_SNAPSHOT` (02)** `roomRef` + codec. The room's full state; starts
  a new state stream (§11.9). The body may be empty (a room with no state).
- **`STATE_PATCH` (03)** `roomRef` + codec. Everything that changed in one
  sync tick. Never empty: an idle tick sends no frame at all.
- **`JOIN_SUCCESS` (04)** `requestId, roomRef` + mp handshake (§6.4).
- **`JOIN_ERROR` (05)** `requestId` + mp `[code, message]` (§8.1).
- **`CLIENT_JOINED` (06)** `roomRef` + mp `sessionId`. Another client took a
  seat in the room. Not sent to the joiner itself, and not re-sent when a
  seat is resumed after a reconnect.
- **`CLIENT_LEFT` (07)** `roomRef` + mp `sessionId`. Another client's seat
  was released.
- **`LEAVE` (08)** `roomRef, code` + empty or mp `reason`. This client is no
  longer in the room (§7). No frame for this `roomRef` follows it.
- **`ERROR` (09)** `roomRef` + mp `[code, message]`. `roomRef` `0` is about
  the connection (the server sends `INVALID_MESSAGE` before closing for a
  protocol violation, §8.2).
- **`PONG` (0a)** `nonce`, echoing a `PING`.

Example, `LEAVE(roomRef 1, code 4000, reason "afk")`:
`08 01 a0 1f a3 61 66 6b`.

---

## 6. Joining

### 6.1 Sequence

```
client                                        server
  │ ── connect, subprotocol bungohan.v1 ────▶ │ version check (§2.2)
  │ ── JOIN(requestId, [mode, target, …]) ──▶ │ 1. parse the body
  │                                            │ 2. contract hash check (before anything else)
  │                                            │ 3. find or create the room, take a seat
  │                                            │ 4. authentication, the room's join hook
  │ ◀── JOIN_SUCCESS(requestId, roomRef, hs) ─ │
  │ ◀── ROOM_MESSAGE …   (allowed from here) ─ │    CLIENT_JOINED → the other members
  │ ◀── STATE_SNAPSHOT(roomRef, …) ────────── │ at the room's next sync tick
  │ ◀── STATE_PATCH(roomRef, …) … ─────────── │ every later sync tick that changed something
  │ ── ROOM_MESSAGE / PING … ───────────────▶ │
  │ ── LEAVE(roomRef) ──────────────────────▶ │
  │ ◀── LEAVE(roomRef, 1000) ──────────────── │ CLIENT_LEFT → the others
```

- A join has succeeded when `JOIN_SUCCESS` arrives, but the client has no
  state until the first `STATE_SNAPSHOT`, which the server sends at the
  room's next sync tick (at most one sync interval later, 50 ms at the
  default 20 Hz). A client SHOULD consider the join complete when that
  snapshot has been applied.
- `ROOM_MESSAGE`, `ROOM_MESSAGE_RAW`, `CLIENT_JOINED` and `CLIENT_LEFT` frames
  for the room MAY arrive between `JOIN_SUCCESS` and the snapshot (messages
  the room sent while the client was joining). A client that hands the room
  to application code only after the snapshot SHOULD hold these frames, in
  order, and deliver them afterwards.
- No `STATE_PATCH` for a `roomRef` arrives before its first
  `STATE_SNAPSHOT`.
- `requestId` is echoed in `JOIN_SUCCESS`/`JOIN_ERROR`, so several joins can
  be in flight on one connection. It MUST be unique among the connection's
  in-flight joins.

### 6.2 `JOIN` body

```
[mode: uint, target: string, options: any, contractHash: string | null]
```

| mode | Name | `target` | Meaning |
|---|---|---|---|
| 0 | `JOIN_OR_CREATE` | room type | join the first available public room of the type, else create one |
| 1 | `CREATE` | room type | always create a new room |
| 2 | `JOIN` | room type | join an available public room; `ROOM_NOT_FOUND` if none |
| 3 | `JOIN_BY_ID` | room id | join that room (private rooms included) |
| 4 | `RECONNECT` | reconnection token | resume a held seat (§7.3); `options` is ignored |
| 5 | `CONSUME_RESERVATION` | reservation id | take a reserved seat (§7.4); `options` is ignored |

"Available" means public, unlocked, not full and not being disposed.

- `options` is passed to the room's hooks as-is. `null` is treated as an empty
  map.
- `contractHash` is the client's contract hash (§6.5), or `null` to skip the
  check.
- Only `mode` and `target` are required: a body of 2 or 3 elements is valid,
  with `options` defaulting to an empty map and `contractHash` to `null`.
  Elements after the fourth are ignored (§9.1).
- A body that isn't a MessagePack array is a protocol violation (§8.2). An
  array whose `mode` isn't an integer `0 … 5`, whose `target` isn't a string,
  or whose `contractHash` is neither a string nor null fails with
  `JOIN_ERROR INVALID_OPTIONS`.

Example, `JOIN(requestId 1, [0, "shooter", {"name": "ann"}, "1a2b3c4d"])`:

```
02 01 94 00 a7 73 68 6f 6f 74 65 72 81 a4 6e 61 6d 65 a3 61 6e 6e
a8 31 61 32 62 33 63 34 64
```

### 6.3 Contract hash

A room type may declare a **contract**: its typed messages (§10). The server
computes a hash of the contract: a string of 8 lowercase hexadecimal digits,
such as `"1a2b3c4d"`. Any change to any message of the contract changes it.

A client does not compute this hash. Code generation bakes the hash of the
contract a client was built against into the client, and the client sends it
as a string. When the string differs from the room type's hash, the join fails
with `CONTRACT_MISMATCH` before any room is created or any hook runs. `null`
skips the check (tools, raw-only clients). The handshake returns the room
type's hash in any case, so a client that sent `null` can still compare.

### 6.4 `JOIN_SUCCESS` handshake

Header: `requestId, roomRef`. Body:

```
[roomId: string, roomType: string, sessionId: string,
 reconnectionToken: string | null, contractHash: string,
 stateCodec: string, clientMessages: string[], serverMessages: string[]]
```

- **`roomId`**: the room's id (for `JOIN_BY_ID`, and for display).
- **`sessionId`**: this seat's id. It is what other clients see in
  `CLIENT_JOINED`/`CLIENT_LEFT`, and it stays the same across a reconnect.
- **`reconnectionToken`**: an opaque secret for resuming the seat (§7.3), or
  `null` when the room doesn't allow reconnection. The server **replaces it on
  every successful join or resume**, and the previous token stops working, so
  a client MUST store the newest one.
- **`contractHash`**: the room type's contract hash (§6.3).
- **`stateCodec`**: the name of the room's codec: **`"schema"`** (the default,
  §13.1) or `"messagepack"` (§13.2). The codec encodes the room's state frames
  *and* its contract messages in both directions: a room has exactly one
  codec. A client that has no implementation of the named codec MUST send
  `LEAVE(roomRef)` and fail the join locally (a "codec mismatch"). The server
  never falls back to another codec.
- **`clientMessages` / `serverMessages`**: the room's message tables. Each is
  a list of message names; a message's **id is its index** in its list.
  `clientMessages` holds the messages the client may send, `serverMessages`
  the ones the server sends. A client resolves ids **by name** when it
  receives the handshake, and never hard-codes them: the same message may get
  a different id on another server build.

Elements after the eighth are ignored (§9.1).

### 6.5 Message ids

To send a contract message, a client looks up its name in `clientMessages` and
uses the index as `messageId`. A message the client knows but the table lacks
can't be sent (a client-side error). A received `ROOM_MESSAGE` whose
`messageId` is outside `serverMessages`, or names a message the client has no
definition for, is dropped (and SHOULD be logged). The server treats a
`messageId` outside `clientMessages` as a protocol violation.

---

## 7. Leaving, reconnection, reservations, ping

### 7.1 Leaving

- **Consented leave.** The client sends `LEAVE(roomRef)`. The server releases
  the seat, answers `LEAVE(roomRef, 1000)`, and tells the other members with
  `CLIENT_LEFT`. The client may consider itself gone as soon as it has sent
  the frame; the acknowledgement is only a courtesy.
- **Server-initiated leave.** The server sends `LEAVE(roomRef, code)`,
  optionally with a reason string, and releases the seat. This removes the
  client from that room only; the connection stays open.

Leave codes:

| code | Meaning |
|---|---|
| 1000 | consented (the client asked to leave) |
| 1001 | disconnected (used by clients locally when a seat can't be resumed) |
| 4000 | kicked |
| 4001 | server shutdown |
| 4002 | room disposed |

A `ROOM_MESSAGE` or `LEAVE` a client sends for a `roomRef` the server no
longer knows is dropped silently: it may simply have crossed a kick in flight.
Likewise a client drops frames for a `roomRef` it doesn't hold (typically the
`LEAVE(1000)` that acknowledges its own `LEAVE`).

### 7.2 Disconnects

When a connection drops without a consented leave, the server MAY **hold** the
client's seats for a grace period (the room's reconnection timeout, 30 s by
default). While held, the seat stays in the room and other clients see no
`CLIENT_LEFT`, but frames for it are dropped. If the seat isn't resumed in
time it is released, and the others get `CLIENT_LEFT`. A room that doesn't
allow reconnection releases seats at once (and gave the client a `null`
token).

### 7.3 Reconnection

To resume a held seat, open a new connection and send
`JOIN(requestId, [4, token])` (mode `RECONNECT`, the latest
`reconnectionToken` as `target`). On success the client gets a
`JOIN_SUCCESS` with the **same `sessionId`**, a **new `roomRef`** and a
**new token**, followed at the next sync tick by a full `STATE_SNAPSHOT`,
always. Nothing is replayed: messages sent while the client was away are
lost, and the snapshot restores the state. `CLIENT_JOINED` is not re-sent to
the others, since the seat never left. An unknown token, or a seat that is no
longer held (it expired, or was already resumed), fails with
`INVALID_TOKEN`.

A client SHOULD reconnect with exponential backoff (for example 1 s, 2 s,
4 s, … capped at 30 s) and give up after a bounded number of attempts.

### 7.4 Reservations

A server may reserve a seat for a client ahead of time (server-side
matchmaking) and hand the client a reservation id out of band. The client
consumes it with `JOIN(requestId, [5, reservationId])`. The seat carries the
options the reservation was made with. An expired reservation fails with
`RESERVATION_EXPIRED`, an unknown one with `RESERVATION_NOT_FOUND`.

### 7.5 Ping

`PING(nonce, rtt)` is answered with `PONG(nonce)` immediately. A client
measures the round trip from sending the `PING` to receiving the matching
`PONG`, and reports its last measurement in the next `PING`'s `rtt`. A client
SHOULD ping periodically (5 s is a reasonable default). A connection that is
silent for too long is closed by the server's idle timeout.

---

## 8. Errors and close codes

### 8.1 `JOIN_ERROR` codes

A `JOIN_ERROR` means the join failed and nothing about it remains on the
server.

| Code | When |
|---|---|
| `INVALID_OPTIONS` | the `JOIN` array has the wrong shape, or an unknown `mode` |
| `SERVER_SHUTTING_DOWN` | the server is shutting down |
| `ROOM_TYPE_NOT_DEFINED` | no room type of that name (modes 0–2) |
| `CONTRACT_MISMATCH` | `contractHash` differs from the room type's |
| `ROOM_NOT_FOUND` | mode 2: no available room; mode 3: no such room, or it is being disposed |
| `ROOM_LOCKED` | mode 3: the room is locked |
| `ROOM_FULL` | mode 3: the room is full |
| `ALREADY_JOINED` | this connection already holds a seat in that room |
| `AUTH_FAILED` | the room refused the client |
| `JOIN_FAILED` | the room's code failed while creating the room or admitting the client (no details are given) |
| `INVALID_TOKEN` | mode 4: unknown token, or the seat is no longer held |
| `RESERVATION_NOT_FOUND` | mode 5 |
| `RESERVATION_EXPIRED` | mode 5 |

A client SHOULD map a code it doesn't know (from a newer server) to a generic
join failure and keep the original code for diagnostics.

### 8.2 Protocol violations

The server closes a connection that breaks the protocol. It sends
`ERROR(0, ["INVALID_MESSAGE", reason])`, then closes with **1008**. Violations
are:

- a frame that can't be parsed, or has an unknown client frame type;
- a body that isn't valid MessagePack where MessagePack is expected;
- a `JOIN` body that isn't an array;
- a `ROOM_MESSAGE` whose `messageId` is outside the room's `clientMessages`;
- a contract message body that doesn't decode exactly (§10).

A `ROOM_MESSAGE` with a valid id that the room has no handler for is not a
violation: it is dropped and logged on the server.

The `ERROR` frame is a courtesy, and **a client MUST NOT depend on
receiving it**: some WebSocket stacks discard whatever they have buffered
the moment the close frame arrives, so the frame the server sent just
before closing may never reach the application (§15). The close code
**1008** is the reliable signal that the connection was refused for a
protocol violation; the `ERROR` frame only says why.

### 8.3 Close codes

| code | Sent when |
|---|---|
| 1000 | normal close (the client or server closed on purpose) |
| 1001 | the server is shutting down (after every room sent `LEAVE(…, 4001)`) |
| 1002 | protocol version not supported (§2.2) |
| 1008 | protocol violation (§8.2) |
| 1009 | a message exceeded the server's size limit |

A client SHOULD treat 1001 and abnormal closes (1006, no close frame) as
unexpected and reconnect (§7.3). It SHOULD NOT reconnect after 1002 or 1008,
or after 1000 from the server.

---

## 9. Forward compatibility

These rules let a server and its clients evolve independently within
`bungohan.v1`.

### 9.1 Array bodies ignore trailing elements

Receivers of the `JOIN` body, the `JOIN_SUCCESS` handshake, `JOIN_ERROR`,
`ERROR` and raw messages (`[type, payload]`) read the elements they know by
position, require those, and **ignore any further elements**. A later version
may append elements, but never reorder or remove them. Fewer elements than
required is malformed (except `JOIN`, §6.2).

Contract message bodies are **excluded**: they are strict (§10). Version skew
there is caught at join by the contract hash, not tolerated field by field.

### 9.2 Unknown frame types

- A **client** that receives a frame type it doesn't know MUST drop that one
  frame (and SHOULD log it) and carry on. It can't know the type's header
  layout, but a frame is exactly one WebSocket message, so skipping it is
  always safe. A `ROOM_MESSAGE` whose `messageId` the client can't map is
  dropped the same way (§6.5).
- The **server** treats an unknown client frame type as a protocol violation
  (§8.2). The server is always at least as new as the protocol version it
  accepted, so an unknown type from a client means a broken client.

### 9.3 Versions

The protocol version is the WebSocket subprotocol (§2). It changes only for a
breaking change that §9.1 and §9.2 can't absorb, such as a new frame layout.
A state codec with a different byte layout gets a **new codec name** rather
than changing an existing one.

---

## 10. Contract messages

A contract message is declared once, as a name and an ordered list of typed
fields. Code generation turns declarations into client classes, so a client
knows every message's fields, in order, and their kinds:

| Kind | Value |
|---|---|
| `int8`, `int16`, `int32`, `uint8`, `uint16`, `uint32` | an integer of that range |
| `float32`, `float64` | a number |
| `fixed:n` (`n` = 0…9) | a number with `n` decimal places, sent as an integer (§12.1) |
| `string` | a string |
| `bool` | true / false |
| `enum[v0 \| v1 \| …]` | one of the listed values; sent as its **index** |
| `array<X>` | a list of X |
| `map<X>` | a map from **string** keys to X |
| `optional<X>` | X, or absent |
| `nested<M>` | a message M, inline |

Rules for both codecs:

- Field order is declaration order. Nothing on the wire names a field.
- A message body MUST decode exactly: every required field present, every
  value of its declared kind and range, and no bytes (or elements) left over.
  Anything else is malformed: the server treats it as a protocol violation
  (§8.2), and a client drops the frame.
- Sending converts numbers per §12: integers are truncated toward zero and
  saturated to their range; `fixed:n` is scaled, rounded and saturated;
  `float32` is rounded to binary32. So the receiver gets the converted
  value, not necessarily the one passed to `send`.
- `enum` values are sent as their index in the declared list. An index
  outside the list is malformed.
- `map` keys are strings; the key `__proto__` is malformed, and so is a key
  that appears twice. Entries are written in the sender's iteration order,
  which carries no meaning.
- An `optional` field that is absent is simply not present in the decoded
  message (it is not a null value).
- `optional<optional<X>>` does not exist. An `array` or `map` element can't be
  a message that encodes to zero bytes (a message all of whose fields are,
  recursively, nested messages with no fields); the server refuses such a
  contract when it is defined.

The byte layout is defined by the codec: §13.1.6 (`schema`) and §13.2.2
(`messagepack`).

---

## 11. State synchronization

A room's state is a tree of **schema instances**. Each instance belongs to a
**class** with an ordered list of typed fields. The server sends the tree as
a stream of **ops**: a `STATE_SNAPSHOT` carries the whole tree, then each
`STATE_PATCH` carries what changed during one sync tick. This section defines
the ops and what a receiver does with them. It is the same for both codecs;
§13 defines only how ops become bytes.

### 11.1 Ops

Ops are written here as tuples, in the order their elements are encoded:

| Op | Code | Tuple | Meaning |
|---|---|---|---|
| `SET` | 0 | `[0, target, index, value]` | instance: set field `index`; array: replace the element at `index` |
| `ADD` | 1 | `[1, target, key, value]` | map: insert or replace `key`; array: insert at index `key` |
| `ADD` | 1 | `[1, target, value]` | set: add `value` (no separate key) |
| `REMOVE` | 2 | `[2, target, key]` | map: remove `key`; array: remove index `key`; set: remove the element `key` (for a set of schema instances, `key` is the element's refId) |
| `CLEAR` | 3 | `[3, target]` | empty a collection |
| `DEFINE` | 4 | `[4, classId, name, fields, types]` | add a class to the class table (§11.2) |

`target` is a **refId** (§11.3): the instance or collection the op applies to.

A **value** is a number, a string, a boolean, or a **ref**
`[classId, refId]`: a schema instance. A ref whose `refId` the receiver
doesn't currently know **creates** the instance (§11.5).

Which ops are valid depends on the target's kind:

| Target | `SET` | `ADD` | `REMOVE` | `CLEAR` |
|---|---|---|---|---|
| schema instance | field index, field value | – | – | – |
| `array<P>`, `schemaArray<N>` | index, element | index, element | index | ✓ |
| `map<K,P>`, `schemaMap<K,N>` | – | key, element | key | ✓ |
| `set<K>` | – | element | element | ✓ |
| `schemaSet<N>` | – | ref | element refId | ✓ |

**Array** `ADD` and `REMOVE` shift the indices after them, so array ops
MUST be applied in stream order. A map or set op for a key appears at most
once per frame (only each key's final state is sent), except that a `CLEAR`
may be followed by `ADD`s that refill the collection.

### 11.2 Class table and `DEFINE`

The class table maps a `classId` to a class name, its field names and their
types. It is built **in-band** from `DEFINE` ops:

- Class ids are assigned `0, 1, 2, …` in order. A `DEFINE` for a new class
  MUST use the next id. A `DEFINE` for an id already in the table MUST
  restate it identically (every snapshot replays the whole table). A `DEFINE`
  that skips an id or contradicts an existing entry is malformed.
- A snapshot starts with `DEFINE`s for the entire table. A patch carries a
  `DEFINE` immediately before the first use of a class new to the room.
- `DEFINE`s are never filtered (§11.8): every client sees every class.
- `fields` and `types` have the same length; a field's **index** is its
  position. Field names are identifiers.

A field type is a string in this grammar:

```
field     = primitive | int | "schema<" Name ">"
          | "map<" key "," primitive ">" | "set<" key ">" | "array<" primitive ">"
          | "schemaMap<" key "," Name ">" | "schemaSet<" Name ">" | "schemaArray<" Name ">"
primitive = "float64" | "float32" | "fixed:" digit | "string" | "bool"
int       = "int8" | "int16" | "int32" | "uint8" | "uint16" | "uint32"
key       = "string" | "float64" | int
digit     = "0" | "1" | … | "9"
Name      = a class name: every character up to the final ">"
```

`schema<N>` is a directly nested instance. The other `<…>` forms are
**collections**. `int` kinds are field types only: collection elements are
`primitive`s, and keys are `key`s. A class name may contain any character
(including `<`, `>` and `,`): it always runs to the `>` that ends the type
string. A type that doesn't match the grammar makes the `DEFINE` malformed.

**Class matching.** A receiver matches server classes to its own classes **by
name**, and fields **by name**:

- A server field the receiver's class lacks is ignored (its `SET`s are
  skipped).
- A field present on both sides whose type strings differ is a hard error:
  **schema mismatch**. Types are compared as strings.
- A class the receiver has no class for is **unknown**. Its instances are
  ignored together with everything under them (§11.7).

### 11.3 refIds

Every schema instance and every collection has a **refId**, an unsigned
integer, unique among the room's live objects.

- **The root** (the room's state object) is refId `0`, and its class is
  **classId `0`**: the first `DEFINE` of every stream is the root's class.
- **Blocks.** An instance with refId `R` whose class has `k` collection fields
  owns the block `R … R+k`. Its collection fields have refIds `R+1 … R+k` in
  field order (only collection fields count; primitive and `schema<N>` fields
  take no refId). Collections are never announced on the wire: a receiver
  computes their refIds from the class table.
- The root's collections are therefore `1 … k₀`.

Example: with the classes `World { tick: float64, entities: schemaMap<uint32,Entity> }`
and `Entity { x: fixed:2, y: fixed:2, tags: set<string> }`, the root World is
`0`, its `entities` map is `1`, an Entity at `R` has its `tags` set at `R+1`.

### 11.4 refId reuse

When an instance leaves the tree (removed from a collection, or replaced in a
`schema<N>` field, §11.5), the server frees its block and later reuses
it for a new instance **of the same class**, so refIds stay bounded by the
number of live instances. A receiver needs no bookkeeping for this: a block is
freed only after the frame that removed the instance, and a receiver drops
removed instances at the end of that frame (§11.6). When the block is reused,
its refId is unknown to the receiver again, so the ref creates a fresh
instance, exactly like a never-used refId.

Because reuse stays within a class, a given refId always denotes an instance
of the same class, or the same collection field of the same class, for the
whole stream. The `schema` codec relies on this (§13.1.2).

### 11.5 New instances: full content and zero values

A ref to an unknown refId creates an instance of the ref's class. The op that
places it is followed, in the same frame, by its **full content**:

- a `SET` for every primitive field whose wire value is **not zero**;
- a `SET` with a ref for every `schema<N>` field;
- an `ADD` for every element of every collection field.

A primitive field whose wire value is zero (`0`, including `−0`; `""`;
`false`) is omitted. So **a receiver MUST reset every instance it creates to
zero values**: numbers `0`, strings `""`, booleans `false`, collections empty.
It must not keep whatever defaults its own class declares, because only the
server knows those. The root is reset the same way when the first snapshot
binds it.

A `schema<N>` field always holds an instance. Its `SET` tells the receiver the
refId of the nested instance, and the nested instance's own full content
follows. (A receiver whose classes create nested objects themselves binds its
existing nested object to that refId and resets it.)

**Replacing a nested instance.** The server may replace the instance a
`schema<N>` field holds. It then sends a `SET` of that field with a ref to the
new instance, followed by the new instance's full content. The new instance
is always **new** (a refId the receiver doesn't know), even if it was
attached elsewhere before: a receiver keeps its own nested object and can't
adopt another one. The replaced instance leaves the tree like a removed one
(§11.6): its block is freed after the frame and may be reused (§11.4). A
server therefore gives a nested field an instance that nothing else holds,
and never puts an instance a nested field holds into a collection.
Collections may share an instance (§11.6 counts its holders). These are
server-side rules, with nothing for receivers to check.

A receiver that rebinds its existing nested object to the new refId MUST
first **forget the old binding**. The old refId and its collections' refIds
become unknown, and every element of the object's collections loses the
holder they had there (§11.6), so it is dropped at the end of the frame
unless the frame places it again. The object's own holder count is
unchanged: the field still holds it. Its nested fields are rebound by the
`SET`s of the full content that follows. Without this, a later reuse of the
old refIds would resolve to the nested object or its former elements
instead of creating new instances.

An instance that the receiver already knows is referenced by its ref only,
and its later changes arrive as ops that target its refId.

### 11.6 Removal, moves and holder counts

A receiver keeps a **holder count** per instance: how many places (schema
fields, collection slots) currently hold it. An op that removes or replaces an
element decrements the old element's count; placing an element increments
it. At the **end of each frame**, every instance whose count is zero is
**dropped**: its refId, and the refIds of its collections, become unknown, and
everything it held is released in turn (and dropped if that leaves them with
no holder).

Dropping at the end of the frame is what makes a **move** work: an instance
removed from one place and added to another within one frame, in either order,
keeps its identity (the same client object, with its listeners).

An instance removed in one frame and attached again in a later one is sent in
full again under a new block (possibly a reused one), as a new instance.

### 11.7 Unknown classes

An instance of an unknown class (§11.2) is **ignored**: the receiver records
its refId and its block's collection refIds as ignored, and silently skips
every op that targets an ignored refId, including refs to new instances placed
inside it, which become ignored as well. A later ref that creates an instance
of a known class at a previously ignored refId clears the mark (blocks are
reused, §11.4).

One exception: an unknown-class element of an **array** can't be skipped,
because every later index would shift. That is an **unknown class** error.

Receivers SHOULD report each unknown class name once per stream, since it
usually means the client is missing a class registration or is older than the
server.

### 11.8 Filtering

The server may show a field to some clients and not others. From a client's
point of view, filtering only means that its stream differs from other
clients' streams:

- A field it can't see is never sent. Inside a hidden collection, nothing is
  sent for the instances it contains either.
- When a field becomes **visible**, the client receives its current value, or
  (for a collection) its full content as `ADD`s.
- When a field becomes **hidden**, the client receives its zero value (`SET`)
  or a `CLEAR` (collection).

`DEFINE`s are never filtered.

### 11.9 Streams and snapshots

Every `STATE_SNAPSHOT` **starts a new stream**. The receiver discards its
previous replica and all codec state (class table, refIds), and applies the
snapshot to a fresh root. The snapshot restates the whole class table. Most
snapshots follow a `JOIN_SUCCESS`, but a server may also send one at any time
(for example when the room replaces its whole state), so a client MUST accept
a snapshot at any point.

A `STATE_PATCH` before the first `STATE_SNAPSHOT` of a room is a desync.

### 11.10 Applying a frame

For each frame, a receiver:

1. Decodes the body with the room's codec into ops (§13). A body that doesn't
   decode is a desync.
2. Applies the ops in order. `DEFINE` updates the class table; when the
   root's class is first defined, the receiver binds its root object to
   refId `0` and resets it.
3. Drops every instance left with no holder (§11.6).
4. Fires change notifications (below).

Errors, which stop the frame at the failing op (earlier ops stay applied):

| Error | When |
|---|---|
| malformed op | wrong target kind for the op, field index out of range, value of the wrong type for the field or element, index out of range, key not valid for the key type |
| unknown ref | the target refId is neither known nor ignored |
| unknown class | a ref names a classId not in the table; an unknown-class array element |
| schema mismatch | a shared field's type differs (§11.2) |

Any error is a **desync**: the replica can no longer be trusted. Protocol v1
has no "resend the snapshot" frame, so a client re-synchronizes by
**reconnecting**: it closes the connection and resumes each seat with its
token (§7.3), which always brings a fresh snapshot. A seat without a token is
left.

**Change notifications.** A receiver that exposes change listeners
(field changed, element added/removed/replaced) fires them **after the whole
frame has been applied**, in op order, so a listener always sees a
consistent tree. An instance **created in this frame fires none of its own
listeners**; the collection it was added to reports it (fully populated) as
added. The root's listeners always fire, including during the snapshot that
binds it.

---

## 12. Numeric rules

These rules decide the exact integer a number becomes on the wire. They apply
to state fields and collection elements (computed by the server) and to
contract message fields (computed by whoever sends the message), and every
implementation MUST reproduce them bit for bit.

### 12.1 Fixed-point (`fixed:n`)

`n` is `0 … 9` decimal places. The wire value is a **signed 32-bit integer**.

```
encode(x, n):
  if x is NaN: return 0
  s = x × 10^n                      binary64 multiply; 10^n is the exact double (1, 10, 100, …, 1e9)
  r = round half away from zero(s)  2.5 → 3, −2.5 → −3, 0.4999… → 0
  if r ≤ −2147483648: return −2147483648
  if r ≥  2147483647: return  2147483647
  if r is −0: return 0
  return r

decode(i, n) = i ÷ 10^n             binary64 divide, never i × 0.1^n
```

- ±Infinity saturates. The result is never −0.
- Round half away from zero is C#'s `Math.Round(s, MidpointRounding.AwayFromZero)`
  and GDScript's `round()`. It is **not** "round half up" (`floor(s + 0.5)`
  rounds −2.5 to −2) and not banker's rounding.
- Because `s` is a binary64 product, a decimal that isn't exactly
  representable may round the "wrong" way: `1.005 × 100 = 100.49999999999999`,
  which encodes as `100`. Implementations must compute `s` in binary64 exactly
  like this, not with decimal arithmetic.
- Decoding divides: `14551 ÷ 100 = 145.51`, whereas `14551 × 0.01 =
  145.51000000000002`.

| x | n | wire |
|---|---|---|
| 145.5 | 2 | 14550 |
| −3.25 | 2 | −325 |
| 0.125 | 2 | 13 |
| −0.125 | 2 | −13 |
| 2.5 | 0 | 3 |
| −2.5 | 0 | −3 |
| 1.005 | 2 | 100 |
| −0 | 3 | 0 |
| NaN | 2 | 0 |
| 1e12 | 2 | 2147483647 |
| −Infinity | 2 | −2147483648 |

### 12.2 Integers

For `int8 … uint32` (state fields, message fields, and map/set keys):

```
encode(x, kind):
  if x is NaN: return 0
  if x ≤ min(kind): return min(kind)
  if x ≥ max(kind): return max(kind)
  t = truncate toward zero(x)      2.9 → 2, −2.9 → −2
  if t is −0: return 0
  return t
```

| kind | min | max |
|---|---|---|
| int8 | −128 | 127 |
| int16 | −32768 | 32767 |
| int32 | −2147483648 | 2147483647 |
| uint8 | 0 | 255 |
| uint16 | 0 | 65535 |
| uint32 | 0 | 4294967295 |

A receiver MUST reject (as malformed) a wire integer outside its kind's range.

**Keys are exact.** Map keys and set elements of an integer kind are sent
as-is: the server never truncates them, and a receiver rejects a key that
isn't an integer of the kind.

### 12.3 `float32`

The value is rounded to binary32 (round to nearest, ties to even). Receivers
hold the rounded value. NaN and ±Infinity pass through; −0 keeps its sign
(but see §4 for the MessagePack codec).

### 12.4 `float64`

Sent exactly. NaN, ±Infinity and −0 are valid values (−0 survives the
`schema` codec but becomes 0 in the `messagepack` codec, §4).

### 12.5 Where the rules run

- **State**: the server converts field and element values with these rules
  when it generates ops, so ops always carry wire values (the integer for
  `fixed:n`, the rounded number for `float32`). The server keeps full
  precision itself and marks a field changed only when its **wire** value
  changes, so a value that moves by less than one unit of precision sends
  nothing. Receivers decode `fixed:n` (divide) and hold the result.
- **Messages**: the sender converts when it encodes; the receiver decodes.

---

## 13. State codecs

The handshake's `stateCodec` names one of these. Both encode the same ops
(§11.1), and both encode the room's contract messages (§10).

### 13.1 `schema`

A tag-free binary encoding. No value carries a type marker: the class table
(from the stream's `DEFINE`s) and the message declarations say what every
byte means.

#### 13.1.1 Session

A client keeps one **decoding session** per room stream. It is created for
every `STATE_SNAPSHOT` (§11.9) and holds:

- the **class table**, from `DEFINE`s;
- the **target table**: refId → what that refId denotes, either "instance of
  class C" or "collection of type T";
- nothing else. Everything below is resolved from these two tables.

The server keeps one encoding session per room, shared by every client of the
room. Because refIds are room-wide and never change meaning (§11.4), every
client session agrees with it on every refId the client has seen.

#### 13.1.2 The target table

An op's target refId is looked up in the target table to decide how to read
the rest of the op. Entries are added, and never removed, as the stream is
read:

- **Root.** When the `DEFINE` for classId `0` is first applied, refId `0` is
  bound to class 0.
- **Refs.** Whenever a ref `[classId, refId]` is read (or written) as a value,
  `refId` is bound to class `classId` (the class MUST already be in the
  table).

Binding refId `R` to class C sets `R` → "instance of C", and, for the `j`-th
collection field of C (counting only collection fields, in field order, from
`j = 1`), `R + j` → "collection of that field's type". Binding overwrites any
existing entries for those refIds.

A session does not track whether an instance is currently live. It only needs
to know what a refId *would* be, which never changes during a stream (§11.4).
Liveness is the receiver's business (§11.10).

#### 13.1.3 Op encoding

A state body is a sequence of ops, back to back, running to the end of the
body. There is no count and no terminator. An empty body is zero ops.

Each op starts with a **header byte**:

```
bit   7 6 5   4   3 2 1 0
      code    S   F
```

- **`code`** (bits 7–5): `0` SET, `1` ADD, `2` REMOVE, `3` CLEAR,
  `4` DEFINE. Codes 5–7 are malformed.
- **`S`** (bit 4, "same target"): `1` means the op's target is `last` (below)
  and no target follows. `0` means the target follows as a varint.
- **`F`** (bits 3–0): for a `SET` on a schema instance, the field index if it
  is `0 … 14`; `15` means the index is `15 + ` a varint that follows the
  target. For every other op, `F` MUST be `0`.

**`last`** is reset to `0` at the start of every body. After each op other
than `DEFINE`, `last` becomes the refId of the **ref the op carries as its
value**, if it carries one (a `SET` or `ADD` whose value is a ref), and
otherwise the op's **target**. `DEFINE` leaves it unchanged. `REMOVE`'s key is
not a value, even for a schema set.

Encoders MUST set `S` exactly when the target equals `last`, and MUST use
`F = 15` exactly when the field index is 15 or more, so there is one encoding
of every op.

The op's remaining bytes depend on the target's entry in the target table:

| Op | Target | Bytes after header [and target] [and field extension] |
|---|---|---|
| `SET` | instance of class C | the value of field `index`, as the field's type (§13.1.4) |
| `SET` | `array<P>` | index: varint; the element as `P` |
| `SET` | `schemaArray<N>` | index: varint; the element as a ref |
| `ADD` | `map<K,P>` | key as `K`; the element as `P` |
| `ADD` | `schemaMap<K,N>` | key as `K`; the element as a ref |
| `ADD` | `array<P>` | index: varint; the element as `P` |
| `ADD` | `schemaArray<N>` | index: varint; the element as a ref |
| `ADD` | `set<K>` | the element as `K` |
| `ADD` | `schemaSet<N>` | the element as a ref |
| `REMOVE` | `map<K,P>`, `schemaMap<K,N>` | key as `K` |
| `REMOVE` | `array<P>`, `schemaArray<N>` | index: varint |
| `REMOVE` | `set<K>` | the element as `K` |
| `REMOVE` | `schemaSet<N>` | the element's refId: varint |
| `CLEAR` | any collection | nothing |
| `DEFINE` | (no target) | see below |

Any other combination (a `SET` on a map or set, an `ADD`/`REMOVE`/`CLEAR` on
an instance, a field index past the class's last field) is malformed, and so
is a target not in the target table.

**`DEFINE`** has `S = 0` and `F = 0`, and no target:

```
80  classId:varint  name:string  count:varint  (fieldName:string  type:string) × count
```

The rules of §11.2 apply (next id or identical restatement; type strings must
parse). A `DEFINE` that restates a known class changes nothing.

#### 13.1.4 Values

| Type | Bytes |
|---|---|
| `float64` | 8 bytes, IEEE 754, little-endian (§1.4) |
| `float32` | 4 bytes, IEEE 754, little-endian |
| `fixed:n` | the wire integer (§12.1) as a zigzag varint |
| `string` | varint length, UTF-8 bytes (§1.3) |
| `bool` | one byte: `00` false, `01` true; any other byte is malformed |
| `int8` | one byte, two's complement |
| `uint8` | one byte |
| `int16`, `int32` | zigzag varint; outside the kind's range is malformed |
| `uint16`, `uint32` | varint; outside the kind's range is malformed |
| `schema<N>` / ref | `classId:varint  refId:varint` |

Keys (`K`) use the same encodings: `string`, `float64`, or an integer kind.

A `fixed:n` value is an int32: a zigzag varint above `4294967295` can't occur
(§1.1), and every value `0 … 4294967295` decodes to an int32, so nothing more
is checked.

#### 13.1.5 Example

The classes `World { tick: float64, entities: schemaMap<uint32,Entity> }`
and `Entity { x: fixed:2, y: fixed:2 }`. A snapshot with one entity at key 5,
`x = 1.5`, `y = 0`:

```
80 00 05 57 6f 72 6c 64 02                  DEFINE 0 "World", 2 fields
   04 74 69 63 6b 07 66 6c 6f 61 74 36 34        "tick" "float64"
   08 65 6e 74 69 74 69 65 73                    "entities"
   18 73 63 68 65 6d 61 4d 61 70 3c 75 69 6e 74 33 32 2c 45 6e 74 69 74 79 3e
                                                  "schemaMap<uint32,Entity>"
80 01 06 45 6e 74 69 74 79 02               DEFINE 1 "Entity", 2 fields
   01 78 07 66 69 78 65 64 3a 32                  "x" "fixed:2"
   01 79 07 66 69 78 65 64 3a 32                  "y" "fixed:2"
20 01 05 01 02                              ADD, target 1, key 5, ref [1, 2]    last = 2
10 ac 02                                    SET, S, field 0, zigzag(150)       target 2
```

After the first `DEFINE`, refId 0 is the World and refId 1 its `entities`
map. The `ADD` binds refId 2 to Entity and makes it `last`, so the `SET` on
it needs no target. `y` is zero and is omitted. `tick` is zero, so the root
has no `SET` either.

A later tick that moves the entity's `y` (field **1**) to `−3.25`: the
header is `SET` with `F = 1`, `S = 0` (`last` is reset to 0 at the start of
the body), then the target `02`, then zigzag(−325) = 649 = `89 05`:

```
01 02 89 05
```

and on the wire, as `STATE_PATCH` for roomRef 1: `03 01 01 02 89 05`
(6 bytes).

#### 13.1.6 Contract messages

A message `M` is encoded as its **flags**, then its **values**:

**Flags.** Walk M's fields in declaration order and allocate bits:

- a `bool` field: 1 bit, its value;
- an `optional<X>` field (X not `bool`): 1 bit, set if present;
- an `optional<bool>` field: 2 bits, "present" then the value (0 when
  absent).

Bit `i` is bit `i mod 8` (bit 0 = least significant) of flag byte
`⌊i / 8⌋`. The flags take `⌈bits / 8⌉` bytes, **zero bytes if M has no bool
or optional fields**. Unused high bits of the last byte MUST be 0, and so
MUST the value bit of an absent `optional<bool>`; a receiver rejects either
bit when it is set.

**Values.** Then, in declaration order, the value of every field that is
**not** a `bool`, **not** an `optional<bool>`, and **not** an absent
`optional<X>`. A present `optional<X>` field writes X.

Value encodings (also used for array elements and map values):

| Kind | Bytes |
|---|---|
| `int8` / `uint8` | one byte (two's complement / unsigned) |
| `int16`, `int32` | zigzag varint of the converted integer (§12.2) |
| `uint16`, `uint32` | varint of the converted integer |
| `float32` / `float64` | 4 / 8 bytes, little-endian (§1.4) |
| `fixed:n` | zigzag varint of the wire integer (§12.1) |
| `string` | varint length, UTF-8 |
| `bool` | one byte `00` / `01` (only as an array element or map value) |
| `enum` | varint index |
| `array<X>` | count: varint, then each element |
| `map<X>` | count: varint, then each entry as key (string), value |
| `optional<X>` | as an array element or map value only: `00` absent, or `01` then X |
| `nested<M2>` | M2's own encoding: its flags, then its values |

A count larger than the number of bytes left in the body is malformed. So is
trailing data after the message, a truncated value, a range violation, a bool
byte other than `00`/`01`, or a presence byte other than `00`/`01`.

Example: `input { up: bool, down: bool, left: bool, right: bool,
rotation: fixed:2, shooting: bool }` with `left = true`, `shooting = true`,
`rotation = 3.14`, the others false. Flags: bits 0–4 are up, down, left,
right, shooting, so `left` is bit 2 and `shooting` bit 4: `0b00010100` =
`14` (hex). Values: zigzag(314) = 628 = `f4 04`.

```
14 f4 04
```

As a `ROOM_MESSAGE` for roomRef 1, message id 0: `00 01 00 14 f4 04`
(6 bytes).

### 13.2 `messagepack`

Self-describing: every value carries a MessagePack type byte, so a body can be
inspected without the class table. It is kept for debugging.

#### 13.2.1 State ops

A state body is one MessagePack **array of ops**, each op the tuple of §11.1
as a MessagePack array, encoded per §4:

- refIds, class ids, indices and op codes: integers;
- `fixed:n`, integer kinds: the wire integer;
- `float32`: the rounded value, as a float64 (or an integer if it is
  integral, per §4);
- a ref: a 2-element array `[classId, refId]`;
- a `DEFINE`: `[4, classId, name, [fieldName…], [type…]]`.

An empty snapshot is the empty array `90`. The one-entity snapshot of
§13.1.5 is:

```
94                                                     array of 4 ops
   95 04 00 a5 "World" 92 a4 "tick" a8 "entities" 92 a7 "float64" b8 "schemaMap<uint32,Entity>"
   95 04 01 a6 "Entity" 92 a1 "x" a1 "y" 92 a7 "fixed:2" a7 "fixed:2"
   94 01 01 05 92 01 02
   94 00 02 00 cc 96
```

(strings shown in quotes stand for their UTF-8 bytes).

A receiver checks every op's shape: its code, its arity (4 elements for
`SET` and a map/array `ADD`, 3 for a set `ADD` and `REMOVE`, 2 for `CLEAR`,
5 for `DEFINE`), and that values are numbers, strings, booleans or 2-integer
arrays.

#### 13.2.2 Contract messages

A message is a MessagePack **array of its fields' values** in declaration
order (positional; no field names):

| Kind | MessagePack value |
|---|---|
| integer kinds, `fixed:n` | the converted integer |
| `float32` | the rounded value (a number) |
| `float64`, `string`, `bool` | the value |
| `enum` | the index |
| `array<X>` | an array |
| `map<X>` | a map with string keys |
| `optional<X>` | the value, or `nil` when absent |
| `nested<M>` | M's own positional array |

At message level, **trailing absent optionals are left out** of the array:
`{ a: optional, b: int8 }` with only `b` is `92 c0 01`, and with only `a = 3`
is `91 03`. A receiver treats a missing trailing element as absent (only
optionals may be missing), and rejects more elements than the message has.

The `input` example of §13.1.6 is `96 c2 c2 c3 c2 cd 01 3a c3` (9 bytes).

---

## 14. Conformance vectors

`conformance/v1/*.json` are test cases in a language-neutral JSON format.
Every client implementation should run them all. Each file is one JSON object:

```json
{
  "description": "what the file covers",
  "generated": false,
  "cases": [ … ]
}
```

`generated: false` files were written by hand from this document; `true` files
were produced by the reference server implementation and extend coverage.
Both are normative.

**Numbers.** JSON has no NaN, Infinity or −0. Wherever a number is expected,
a vector may instead hold `{"f64": "<16 hex digits>"}`: the binary64 value with
those bits, most significant byte first (`{"f64": "7ff8000000000000"}` is NaN,
`{"f64": "8000000000000000"}` is −0).

**Hex.** Byte strings are lowercase hex. Spaces are allowed anywhere and
ignored (hand-written vectors group bytes by field).

**Absent values.** In a message payload, an absent `optional` is left out of
the object at message level, and written as `null` inside an array or map.
A map entry whose value is absent keeps its key: `{"x": null}` is a map with
one entry, not the empty map.

**Parsing the JSON.** Numbers must be read as the exactly nearest binary64
(round half to even), as JavaScript and most standard JSON libraries do.
Some engine parsers don't: Godot's `JSON` and `String.to_float()` put
`3.4028234663852886e38` one ulp off and read `2.2250738585072014e-308` as 0,
and would fail valid vectors. Compare numbers like JavaScript's `Object.is`
(NaN equals NaN, −0 differs from 0), whatever integer or float type your
parser gives them.

**Escaped strings.** A vector string may hold `\u0000` or an escaped lone
surrogate (`\ud800`), which are valid JSON. Some parsers refuse the second
(.NET's `System.Text.Json`), and an engine string may hold neither (Godot):
unescape such a string yourself, into U+FFFD where your strings can't hold
the character (which is what an encoder sends for it, §1.3).

Case kinds (`"kind"`):

- **`varint`** and **`zigzag`**: `{ value, hex }`: encode `value` to exactly
  `hex`, and decode `hex` back to `value`. `"encode": false` marks a
  non-shortest form that is only decoded. A case with `"error": true` has
  only `hex`, which must fail to decode.
- **`fixed`**: `{ value, decimals, wire }` (§12.1). **`int`**:
  `{ value, type, wire }` (§12.2). **`float32`**: `{ value, wire }`, `wire`
  being the rounded number (§12.3).
- **`frame`**: `{ direction: "client" | "server", type, header, bodyHex, hex }`:
  building the frame gives `hex`, parsing `hex` gives the rest. An optional
  `body` holds the MessagePack value that `bodyHex` encodes. With
  `"error": true`, only `direction` and `hex` are given, and parsing fails.
- **`messagepack`**: `{ value, hex, decoded? }` (§4): encoding `value` gives
  `hex`, and decoding `hex` gives `decoded` (default: `value`).
- **`message`**: `{ message, payload, hex: { <codec>: hex, … }, decoded? }`.
  `message` is a declaration (below). Encoding `payload` with each codec named
  in `hex` gives that codec's hex, and decoding the hex gives `decoded`
  (default: `payload`). With `"error": true`, there is no `payload`, and
  decoding each hex must fail.
- **`state`**: `{ codec, clients?, frames: [ { to?, ops, hex, decoded?, encode? } … ] }`.
  One stream. A single encoding session encodes each frame's `ops`, in order,
  to its `hex`. Each client in `clients` (default `["a"]`) has its own
  decoding session and decodes, in order, the frames whose `to` names it
  (default: every client), giving `decoded` (default: `ops`).
  `"encode": false` marks a frame that is only decoded (a non-canonical
  form). A frame with `"error": true` has `hex` that must fail to decode,
  `ops` that must fail to encode, or both. An error ends the case.
  Ops hold **wire values** (§12.5), not decoded ones: a `fixed:2` field
  set to −3.25 appears as `-325`, and a `float32` one as the rounded
  number. `message` cases are the opposite: `payload` and `decoded` are
  what the application sends and receives (`-3.25`).
- **`replica`**: `{ classes, root, frames: [ { ops, expect? } … ] }`: what a
  receiver's replica (§11) holds after each frame. `classes` declares the
  receiver's local classes, `[{ "name": …, "fields": [[name, type], …] }, …]`
  with §11.2 type strings, and `root` names the root's class. One stream
  applies each frame's `ops` (tuples as in §11.1, with wire values), which
  must all apply, then compares the tree from the root with `expect`. An
  instance is an object holding every field of its local class; a
  primitive field holds its decoded value (a `fixed:2` field `-3.25`), an
  array is an array, a map an array of `[key, value]` pairs in any order,
  and a set an array of its elements in any order. An instance may also
  hold `"$"`, a **label**: within a case, one label always names the same
  object and one object always carries the same label, in every frame. So
  a label seen again checks that an object kept its identity, and a new
  label checks that an object is a new one. An instance without a label is
  not checked for identity (whether a receiver keeps its nested object
  when a `schema<N>` field is replaced is its own choice, §11.5).
- **`behavior`**: `{ side: "client" | "server", frames: [hex, …], expect }`:
  what a receiver must do with each frame (§9, §8.2): `"accept"` (processed,
  or legitimately ignored, and the connection stays open), `"drop"` (a client
  skips the frame and carries on), or `"violation"` (the server sends
  `ERROR(0, INVALID_MESSAGE)` and closes with 1008). A `"violation"` case is
  checked by the **close code**; a runner whose transport also delivers the
  `ERROR` frame checks that it is `INVALID_MESSAGE`, and one whose transport
  drops it on close (§8.2, §15) cannot. Client-side cases start
  from a connection holding one joined room at roomRef `1`, with no contract.
  Server-side cases start from a connection that has joined a room at
  roomRef `1` whose room type is `compat` and has no contract.

A message declaration is `{ "name": string, "fields": [[name, type], …] }`,
where a type is a string (`"int8"`, `"fixed:2"`, `"string"`, …) or an object:
`{"enum": [values]}`, `{"array": type}`, `{"map": type}`,
`{"optional": type}` or `{"nested": declaration}`.

---

## 15. Notes for implementers

Pitfalls met while writing the C# (`clients/csharp`) and GDScript
(`clients/godot`) clients, which pass every vector. None changes a byte;
each is an easy way to get one wrong.

**Rounding (§12).** C#'s `Math.Round(x)` rounds half to even: use
`Math.Round(x, MidpointRounding.AwayFromZero)`. GDScript's `roundf()`
rounds half away from zero. A `(float)` cast (C#) or
`PackedByteArray.encode_float` (Godot) rounds to binary32 correctly, ties to
even, overflowing to ±Infinity.

**Integers.** Varints and refIds need 32 unsigned bits: use `uint`/`long` in
C#, and in a language with only 64-bit signed integers (GDScript) mask and
range-check explicitly. Zigzag is simplest as arithmetic (`n ≥ 0 ? 2n :
−2n − 1`, and back); Godot 4 refuses to shift a negative constant.
Saturate a float to the integer range *before* truncating it (§12.1–12.2):
converting an out-of-range float to an integer is undefined or wraps in many
languages.

**Floats.** Write floats little-endian whatever the platform, and write NaN
as the canonical pattern of §1.4 (a NaN's payload is not portable). Read a
MessagePack float big-endian (§4); Godot's `PackedByteArray.decode_*` are
little-endian, so MessagePack floats are assembled from their bits.

**Closing (§8.2).** Godot's `WebSocketPeer` discards the inbound packets it
has buffered when the peer reaches `STATE_CLOSED`, so the `ERROR` a server
sends immediately before closing on a protocol violation never reaches the
application: only close code 1008 does. Read every buffered packet on each
poll whatever the ready state (a peer that is `STATE_CLOSING` still has
frames worth reading), and treat the close code, not the `ERROR`, as the
signal. .NET's `ClientWebSocket` does deliver the frame, because its
receive loop reads messages until it reaches the close message.

**Strings (§1.3).** Engine UTF-8 decoders are often lenient. Godot's
`get_string_from_utf8()` replaces invalid bytes with U+FFFD, stops at a NUL
and drops a leading byte order mark; validate the bytes yourself first and
decode those cases by hand. .NET's `UTF8Encoding` with default settings also
substitutes silently. A Godot `String` cannot hold U+0000 at all, which is
why encoders write it as U+FFFD (§1.3): every client then sees the same
string. A GDScript client that still receives a NUL (from a non-conforming
encoder) reads it as U+FFFD. `@msgpack/msgpack` (JavaScript) writes a lone
surrogate in a short string as invalid UTF-8 and keeps U+0000: normalize
strings before encoding.

**MessagePack (§4).** Decoders keep map entries in wire order (encoders
must write them in insertion order to be byte-exact), reject a repeated or
non-string key, and bound every count by the bytes left. Decode integers
into a 64-bit type and floats into binary64; an integer-valued number is
written as an integer whatever its type in your language.

**Dynamic languages.** In GDScript, `==` between a String and an int is a
runtime error, not `false`: compare types first wherever a value may be of
either (enum values, decoded keys).

**Replica (§11).** Keep change notifications in a queue and fire them after
the frame (§11.10), including for the root on its first snapshot; an
instance created by the frame fires none of its own. Reset every created
instance to zero values (§11.5): a generated class's field initializers are
not the server's. Count holders and drop at the end of the frame (§11.6), or
moves break. When a `schema<N>` field's `SET` names a new refId, forget the
nested object's old block and release its collections' elements (§11.5).
A collection that points back at the instance owning it should do so
weakly where memory is reference counted (GDScript `RefCounted`), or the
pair is never freed.

**Generated bindings.** `@bungohan/codegen` emits message and schema classes
for C# and GDScript, and a neutral JSON descriptor (the §14 declaration
format) for other languages. It bakes in the contract hash but never a
message id or class id: ids come from the handshake (§6.4) and `DEFINE`s
(§11.2), and are resolved by name.
