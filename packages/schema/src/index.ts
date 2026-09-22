/**
 * The definitions a game shares between its server and its browser client:
 * state schemas and the message contract. A module holding them (typically
 * a `shared` package) imports only this, so neither side depends on the
 * other's package, and the browser never pulls in server code.
 *
 * `@bungohan/core` and `@bungohan/client-js` both re-export everything
 * here, so a server or client file can keep importing from its own package.
 * Keep this list to definitions: runtime pieces (clocks, registries, leave
 * codes) belong to core and client-js.
 */
export {
  createArray,
  createBoolean,
  createFiltered,
  createFixedPoint,
  createFloat32,
  createInt,
  createMap,
  createNumber,
  createSchemaArray,
  createSchemaMap,
  createSchemaSet,
  createSet,
  createString,
  type FilterClient,
  Schema,
  type SchemaConstructor,
} from "@bungohan/state"
export {
  type Contract,
  type CreateArg,
  defineContract,
  defineMessage,
  type EmptyContract,
  f,
  type Infer,
  type InferCreateOptions,
  type InferJoinOptions,
  type MessageDef,
} from "@bungohan/types"
