extends RefCounted
## Driving a client the way a game loop would. Every signal and every
## awaited join of BungohanClient resumes inside poll(), so a test has to
## keep polling; these are that loop.

const Checks = preload("checks.gd")


## Polls until `predicate` holds. "" on success, else why it gave up.
static func until(client, predicate: Callable, what: String, timeout_ms := 10000) -> String:
	var deadline := Time.get_ticks_msec() + timeout_ms
	while true:
		client.poll()
		if predicate.call():
			return ""
		if Time.get_ticks_msec() > deadline:
			return "timed out waiting for " + what
		OS.delay_msec(1)
	return ""


## Polls for a while, so anything in flight can arrive.
static func run_for(client, milliseconds: int) -> void:
	var deadline := Time.get_ticks_msec() + milliseconds
	while Time.get_ticks_msec() < deadline:
		client.poll()
		OS.delay_msec(1)
	client.poll()


## A box a coroutine started with `call()` writes its outcome into.
class Box:
	extends RefCounted
	var done := false
	var value = null

	func finish(result) -> void:
		value = result
		done = true


## The interop server's URL, or "" when this run has none.
static func interop_url() -> String:
	return OS.get_environment("BUNGOHAN_INTEROP_URL")
