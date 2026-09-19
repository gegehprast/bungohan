extends "collection.gd"
## A replicated map<K,V> or schemaMap<K,N>. Integer keys are ints, float64
## keys floats, string keys Strings. Signals take the value first, then the
## key, as in every Bungohan client.

## A key was added.
signal added(value: Variant, key: Variant)
## A key was removed.
signal removed(value: Variant, key: Variant)
## An existing key got a new value.
signal replaced(value: Variant, previous: Variant, key: Variant)

var _items := {}


func size() -> int:
	return _items.size()


func has_key(key: Variant) -> bool:
	return _items.has(key)


func at(key: Variant, default: Variant = null) -> Variant:
	return _items.get(key, default)


func keys() -> Array:
	return _items.keys()


func values() -> Array:
	return _items.values()


## A copy of the contents.
func to_dictionary() -> Dictionary:
	return _items.duplicate()


func _reset() -> void:
	_items.clear()


func _schemas() -> Array:
	return _items.values() if type.holds_schemas() else []


## [had, previous].
func _r_upsert(key: Variant, value: Variant, queue: Variant) -> Array:
	var had := _items.has(key)
	var previous: Variant = _items.get(key)
	_items[key] = value
	if had:
		_emit(queue, replaced.emit.bind(value, previous, key))
	else:
		_emit(queue, added.emit.bind(value, key))
	return [had, previous]


## [had, removed].
func _r_delete(key: Variant, queue: Variant) -> Array:
	if not _items.has(key):
		return [false, null]
	var old: Variant = _items[key]
	_items.erase(key)
	_emit(queue, removed.emit.bind(old, key))
	return [true, old]


## The removed values.
func _r_clear(queue: Variant) -> Array:
	var entries := _items.duplicate()
	_items.clear()
	for key in entries:
		_emit(queue, removed.emit.bind(entries[key], key))
	return entries.values()
