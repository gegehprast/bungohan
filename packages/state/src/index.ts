export type { WireOp, WireValue } from "@bungohan/types"
export { ChangeTree } from "./change-tree"
export {
  type AddListener,
  ArrayBase,
  ArrayState,
  CollectionState,
  MapBase,
  type MapKey,
  MapState,
  type RemoveListener,
  type ReplaceListener,
  SchemaArrayState,
  SchemaMapState,
  SchemaSetState,
  SetBase,
  SetState,
} from "./collections"
export { type ApplyDeltaOptions, applyDelta } from "./decoder"
export type { KeyField, KeyOf, ValueField, ValueOf } from "./elements"
export {
  clearChangeTrees,
  encodeSnapshot,
  generateDeltas,
  getSchemaTable,
} from "./encoder"
export { StateError, type StateErrorCode } from "./errors"
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
} from "./factories"
export { fromPlain, toPlain } from "./plain"
export {
  BooleanState,
  type ChangeListener,
  FixedPointState,
  Float32State,
  IntState,
  NumberState,
  PrimitiveState,
  type PrimitiveWire,
  StringState,
} from "./primitives"
export { type ClassInfo, type FieldInfo, Schema } from "./schema"
export { type SchemaConstructor, SchemaRegistry } from "./schema-registry"
export { State } from "./state-base"
export { reachableSchemaClasses, validateSchemaClass } from "./validate"
