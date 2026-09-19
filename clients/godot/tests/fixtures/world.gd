extends "res://addons/bungohan/replica/schema.gd"

const ArraySchema = preload("res://addons/bungohan/replica/array_schema.gd")
const MapSchema = preload("res://addons/bungohan/replica/map_schema.gd")

signal tick_changed(value: float, previous: float)

const SCHEMA_NAME := "World"
const FIELDS := [
	["tick", "float64", "tick"],
	["units", "schemaMap<uint32,Unit>", "units"],
	["order", "schemaArray<Unit>", "order"],
	["scores", "map<string,fixed:1>", "scores"],
]

var tick: float = 0.0
var units = MapSchema.new("schemaMap<uint32,Unit>")
var order = ArraySchema.new("schemaArray<Unit>")
var scores = MapSchema.new("map<string,fixed:1>")
