/**
 * Type-only: pulls in every published entry point so `node16` resolution
 * has to walk all of their declarations.
 */
import type { IBungohanClient } from "@bungohan/client-js"
import type { useRoom } from "@bungohan/client-js/react"
import type { Room } from "@bungohan/core"
import type { Schema } from "@bungohan/schema"
import type { TestHarness } from "@bungohan/testing"

export type Surface = [
  IBungohanClient,
  typeof useRoom,
  Room,
  Schema,
  TestHarness,
]
