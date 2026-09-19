extends "collection.gd"
## A replicated set<K> or schemaSet<N>. Schema elements are compared by
## identity.

## An element was added.
signal added(value: Variant)
## An element was removed.
signal removed(value: Variant)

var _items := {}


func size() -> int:
	return _items.size()


func has(value: Variant) -> bool:
	return _items.has(value)


func values() -> Array:
	return _items.keys()


func _reset() -> void:
	_items.clear()


func _schemas() -> Array:
	return _items.keys() if type.holds_schemas() else []


func _r_add(value: Variant, queue: Variant) -> bool:
	if _items.has(value):
		return false
	_items[value] = true
	_emit(queue, added.emit.bind(value))
	return true


func _r_delete(value: Variant, queue: Variant) -> bool:
	if not _items.has(value):
		return false
	_items.erase(value)
	_emit(queue, removed.emit.bind(value))
	return true


func _r_clear(queue: Variant) -> Array:
	var values := _items.keys()
	_items.clear()
	for value in values:
		_emit(queue, removed.emit.bind(value))
	return values
