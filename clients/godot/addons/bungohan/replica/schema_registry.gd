extends RefCounted
## The classes a receiver can instantiate, by the server's class name. An
## instance of a class that isn't registered is ignored with everything
## under it (PROTOCOL.md §11.7).
##
##     var registry := SchemaRegistry.new()
##     registry.register(preload("player.gd"))

const StateType = preload("../protocol/state_type.gd")


## A registered class: its name, script and fields.
class SchemaClass:
	extends RefCounted
	var name: String
	var schema_script: Script
	## [{name, type, parsed, member, signal (or "")}, …] in local order.
	var fields: Array = []
	var _by_name := {}

	## The local index of a field, or -1.
	func index_of(field_name: String) -> int:
		return _by_name.get(field_name, -1)


var _by_name := {}
var _by_script := {}


## Registers a generated schema script (its SCHEMA_NAME and FIELDS).
func register(script: Script) -> Variant:
	if _by_script.has(script):
		return _by_script[script]
	var constants := script.get_script_constant_map()
	var cls := SchemaClass.new()
	cls.name = constants["SCHEMA_NAME"]
	cls.schema_script = script
	for entry in constants["FIELDS"]:
		var parsed = StateType.parse(entry[1])
		assert(parsed != null, "%s.%s: bad state type %s" % [cls.name, entry[0], entry[1]])
		var signal_name: String = entry[2] + "_changed"
		cls._by_name[entry[0]] = cls.fields.size()
		cls.fields.append({
			"name": entry[0],
			"type": entry[1],
			"parsed": parsed,
			"member": entry[2],
			"signal": signal_name if script.has_script_signal(signal_name) else "",
		})
	_by_name[cls.name] = cls
	_by_script[script] = cls
	return cls


## The class registered under a server class name, or null.
func by_name(name: String) -> Variant:
	return _by_name.get(name)


## The class of an instance, or null.
func class_of(instance: Object) -> Variant:
	return _by_script.get(instance.get_script())
