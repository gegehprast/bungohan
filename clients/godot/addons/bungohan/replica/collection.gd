extends RefCounted
## Base of the replicated collections. A collection is created with its
## field's type string, e.g. MapSchema.new("schemaMap<uint32,Enemy>").
## Signals are emitted after the whole frame is applied (§11.10).

const StateType = preload("../protocol/state_type.gd")

## The parsed field type.
var type
# The instance holding this collection, set when the stream binds it. A
# WeakRef: the instance holds the collection, and a strong reference back
# would be a cycle that RefCounted never frees.
var _owner_ref: WeakRef = null


func _init(type_text: String) -> void:
	type = StateType.parse(type_text)
	assert(type != null and type.is_collection(), "bad collection type " + type_text)


func _owner() -> Object:
	return null if _owner_ref == null else _owner_ref.get_ref()


static func _emit(queue: Variant, signal_callable: Callable) -> void:
	if queue != null:
		queue.append(signal_callable)
