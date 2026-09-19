/**
 * Codegen golden fixture: schema classes covering every field type, a
 * class name that isn't an identifier, and field names that collide with
 * members of the generated classes in each language.
 */
import {
  createArray,
  createBoolean,
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
  Schema,
} from "@bungohan/state"
import { f } from "@bungohan/types"

export class Vec extends Schema {
  public static override readonly schemaName = "G.Vec"
  public x = createFixedPoint(3)
  public y = createFixedPoint(3)
}

export class Item extends Schema {
  public static override readonly schemaName = "Item"
  public label = createString("")
  public count = createInt(f.uint16)
  public tags = createSet(f.string)
}

export class Everything extends Schema {
  public static override readonly schemaName = "Everything"
  public f64 = createNumber(0)
  public f32 = createFloat32(0)
  public fx = createFixedPoint(2)
  public str = createString("")
  public flag = createBoolean(false)
  public i8 = createInt(f.int8)
  public i16 = createInt(f.int16)
  public i32 = createInt(f.int32)
  public u8 = createInt(f.uint8)
  public u16 = createInt(f.uint16)
  public u32 = createInt(f.uint32)
  public pos = new Vec()
  public byName = createMap(f.string, f.fixed(1))
  public byId = createMap(f.uint32, f.bool)
  public byF64 = createMap(f.float64, f.string)
  public ids = createSet(f.int32)
  public ratios = createArray(f.float32)
  public items = createSchemaMap(f.string, Item)
  public itemSet = createSchemaSet(Item)
  public itemList = createSchemaArray(Item)
  // Names that collide with generated or inherited members.
  public get_ = createString("")
  public definition = createNumber(0)
  public class = createBoolean(false)
  public applyField = createInt(f.uint8)
  public countChanged = createNumber(0)
}
