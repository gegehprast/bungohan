extends "collection.gd"
## A replicated array<P> or schemaArray<N>.

## An element was inserted.
signal added(value: Variant, index: int)
## An element was removed.
signal removed(value: Variant, index: int)
## An element was replaced.
signal replaced(value: Variant, previous: Variant, index: int)

var _items := []


func size() -> int:
	return _items.size()


func at(index: int) -> Variant:
	return _items[index]


## A copy of the contents.
func to_array() -> Array:
	return _items.duplicate()


func _reset() -> void:
	_items.clear()


func _schemas() -> Array:
	return _items.duplicate() if type.holds_schemas() else []


func _r_insert(index: int, value: Variant, queue: Variant) -> bool:
	if index < 0 or index > _items.size():
		return false
	_items.insert(index, value)
	_emit(queue, added.emit.bind(value, index))
	return true


## [ok, removed].
func _r_remove(index: int, queue: Variant) -> Array:
	if index < 0 or index >= _items.size():
		return [false, null]
	var old: Variant = _items[index]
	_items.remove_at(index)
	_emit(queue, removed.emit.bind(old, index))
	return [true, old]


## [ok, previous].
func _r_replace(index: int, value: Variant, queue: Variant) -> Array:
	if index < 0 or index >= _items.size():
		return [false, null]
	var old: Variant = _items[index]
	_items[index] = value
	_emit(queue, replaced.emit.bind(value, old, index))
	return [true, old]


func _r_clear(queue: Variant) -> Array:
	var items := _items.duplicate()
	_items.clear()
	for i in items.size():
		_emit(queue, removed.emit.bind(items[i], i))
	return items
