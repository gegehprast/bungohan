/**
 * Type-only: names something from every published entry point, so all of
 * their declarations end up in the program.
 */

import type { IBackplane } from "@bungohan/backplane"
import type { IBungohanClient } from "@bungohan/client-js"
import type { useRoom } from "@bungohan/client-js/react"
import type { Room } from "@bungohan/core"
import type { Result } from "@bungohan/result"
import type { Schema } from "@bungohan/schema"
import type { ISerializer } from "@bungohan/serializer"
import type { SchemaRegistry } from "@bungohan/state"
import type { IStore } from "@bungohan/store"
import type { TestHarness } from "@bungohan/testing"
import type { ITransport } from "@bungohan/transport"
import type { WireOp } from "@bungohan/types"

export type Surface = [
  IBackplane,
  IBungohanClient,
  typeof useRoom,
  Room,
  Result<number, Error>,
  Schema,
  ISerializer,
  typeof SchemaRegistry,
  IStore,
  TestHarness,
  ITransport,
  WireOp,
]
