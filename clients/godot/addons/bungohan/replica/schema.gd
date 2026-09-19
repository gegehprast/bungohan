extends RefCounted
## Base of a replicated schema instance. Generated classes extend it and
## declare, as constants:
##
##     const SCHEMA_NAME := "Player"              # the server's class name
##     const FIELDS := [["isDead", "bool", "is_dead"], …]   # [wire name, type, member]
##
## plus one member per field (a typed var for primitives, the nested
## instance or collection object otherwise) and a `<member>_changed(value,
## previous)` signal per primitive field.
##
## Only the replica writes to these objects. Every instance is reset to
## zero values when the stream creates it (PROTOCOL.md §11.5), whatever its
## initializers say.
