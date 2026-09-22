import {
  type Client,
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
  f,
  Room,
  Schema,
} from "@bungohan/core"

// #region primitives
export class Stats extends Schema {
  public static override readonly schemaName = "Stats"

  public speed = createNumber(1.5) // float64: exact, 9 bytes on the wire
  public accuracy = createFloat32(0.5) // float32: ~7 significant digits
  public x = createFixedPoint(2) // 0.01 steps, 1–5 bytes
  public health = createInt(f.uint8, 100) // an integer 0…255, 1 byte
  public level = createInt(f.int32)
  public name = createString("")
  public team = createString<"red" | "blue">("red") // a string union
  public alive = createBoolean(true)
}
// #endregion primitives

// #region collections
export class Item extends Schema {
  public static override readonly schemaName = "Item"
  public label = createString("")
}

export class Inventory extends Schema {
  public static override readonly schemaName = "Inventory"

  // Primitive elements are declared with the `f` builders…
  public prices = createMap(f.string, f.fixed(2)) // MapState<string, number>
  public unlocked = createSet(f.uint16) // SetState<number>
  public log = createArray(f.string) // ArrayState<string>

  // …Schema elements with their class.
  public items = createSchemaMap(f.uint32, Item) // SchemaMapState<number, Item>
  public equipped = createSchemaSet(Item)
  public hotbar = createSchemaArray(Item)
}
// #endregion collections

// #region collections-use
export function stock(inventory: Inventory): void {
  inventory.prices.set("sword", 12.5)
  inventory.unlocked.add(3)
  inventory.log.push("opened the shop")

  const sword = new Item()
  sword.label.set("Sword")
  inventory.items.set(1, sword)
  inventory.hotbar.push(sword) // collections may share an instance
}
// #endregion collections-use

// #region nested
export class Hero extends Schema {
  public static override readonly schemaName = "Hero"

  public stats = new Stats() // a nested Schema field
  public inventory = new Inventory()

  // Plain fields are never synchronized: server-only data lives here.
  public velocityX = 0
  public lastAttackAt = 0
}
// #endregion nested

// #region ownership
/** Moves an item from the inventory into the hero's hands, correctly. */
export function equip(hero: Holder, id: number): boolean {
  const item = hero.bag.get(id)
  if (item === undefined) return false
  // A nested field owns its instance exclusively: release it from every
  // collection first, then assign it. (Same tick is fine.)
  hero.bag.delete(id)
  hero.hand = item
  return true
}

export class Holder extends Schema {
  public static override readonly schemaName = "Holder"
  public bag = createSchemaMap(f.uint32, Item)
  public hand = new Item()
}
// #endregion ownership

// #region filtered
export class Card extends Schema {
  public static override readonly schemaName = "Card"

  public owner = createString("") // a sessionId
  public face = createString("") // visible to everyone
  // Only the owner's client receives this; others see "".
  public secret = createFiltered(
    createString(""),
    function (this: Card, client) {
      return this.owner.get() === client.id
    },
  )
}
// #endregion filtered

export class TableState extends Schema {
  public static override readonly schemaName = "TableState"
  public cards = createSchemaMap(f.string, Card)
}

/** Deals each joiner a card with a secret only they can see. */
export class TableRoom extends Room<TableState> {
  protected override state = new TableState()

  protected override async onJoin(client: Client): Promise<void> {
    const card = new Card()
    card.owner.set(client.sessionId)
    card.face.set("face down")
    card.secret.set(`secret of ${client.sessionId}`)
    this.state.cards.set(client.sessionId, card)
  }
}
