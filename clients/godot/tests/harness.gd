extends SceneTree
## Base of the headless test runners. It has no dependencies of its own:
## it installs a Logger that counts engine and script errors, then load()s
## the suites, so even a parse error in the code under test fails the run.
##
## That matters because GDScript has no exceptions: a function cut short by
## a script error just returns its type's default ("" for -> String), which
## would otherwise read as a passing check. Any error logged during a run
## fails it.


## Counts errors (not warnings) reported through the engine's logger.
class ErrorCounter:
	extends Logger
	var count := 0

	func _log_error(_function: String, _file: String, _line: int, _code: String, _rationale: String,
			_editor_notify: bool, error_type: int, _script_backtraces: Array[ScriptBacktrace]) -> void:
		if error_type != ERROR_TYPE_WARNING:
			count += 1

	func _log_message(_message: String, _error: bool) -> void:
		pass


var _errors := ErrorCounter.new()
var _frame := 0


func _init() -> void:
	OS.add_logger(_errors)


## Paths of the suite scripts to run; each has `static func run()` returning
## a checks.gd tally.
func _suites() -> Array:
	return []


func _process(_delta: float) -> bool:
	_frame += 1
	if _frame == 1:
		quit(_run_suites())
		return true
	# Only reached if the first frame was cut short by a script error.
	printerr("aborted by a script error")
	quit(1)
	return true


func _run_suites() -> int:
	var code := 0
	for path in _suites():
		var suite: Script = load(path)
		if suite == null:
			printerr("could not load " + path)
			code = 1
			continue
		if suite.run().report() != 0:
			code = 1
	if _errors.count > 0:
		printerr("%d engine/script error(s) were logged during the run (see above): failing." % _errors.count)
		code = 1
	return code
