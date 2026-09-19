extends RefCounted
## Helpers for generated message classes: converting map values between
## typed members and payload values.


## A copy of map with every value passed through convert.
static func map_values(map: Variant, convert: Callable) -> Dictionary:
	var out := {}
	if typeof(map) == TYPE_DICTIONARY:
		for key in map:
			out[key] = convert.call(map[key])
	return out


## A copy of list with every element passed through convert.
static func map_list(list: Variant, convert: Callable) -> Array:
	var out := []
	if typeof(list) == TYPE_ARRAY:
		for item in list:
			out.append(convert.call(item))
	return out
