extends "res://addons/bungohan/replica/schema.gd"
## Hand-written in the shape the generator emits (replica tests).

signal x_changed(value: float, previous: float)
signal y_changed(value: float, previous: float)

const SCHEMA_NAME := "Vec"
const FIELDS := [["x", "fixed:2", "x"], ["y", "fixed:2", "y"]]

var x: float = 7.0  # a local default the replica must reset to 0
var y: float = 0.0
