extends "res://addons/bungohan/replica/schema.gd"

const SetSchema = preload("res://addons/bungohan/replica/set_schema.gd")
const Vec = preload("vec.gd")

signal name_changed(value: String, previous: String)
signal hp_changed(value: int, previous: int)

const SCHEMA_NAME := "Unit"
const FIELDS := [
	["name", "string", "name"],
	["pos", "schema<Vec>", "pos"],
	["hp", "uint8", "hp"],
	["tags", "set<string>", "tags"],
]

var name: String = ""
var pos = Vec.new()
var hp: int = 0
var tags = SetSchema.new("set<string>")
