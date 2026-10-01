extends Node
## AgentBridge — autoload that lets a cloud agent observe and drive a running game.
##
## Transports (chosen automatically):
##   * Web build:   postMessage <-> the browser shell, which relays over WebSocket to the bridge server.
##   * Native/headless: direct WebSocket to the bridge server when AGENT_BRIDGE_URL is set
##     (or --agent-bridge-url=... is passed after `--`).
## CLI modes (headless, used by the server):
##   godot --headless --path <proj> -- --agent-validate --agent-out=<file.json>
##   godot --headless --path <proj> -- --agent-run-tests [--agent-filter=<substr>] --agent-out=<file.json>
##
## Games can optionally expose a hook on their current scene (or any autoload):
##   func get_agent_state() -> Dictionary   # returned by the "state" command

const PROTOCOL_VERSION := 1
const LOG_CAPACITY := 500

var _logger: Logger
var _log_mutex := Mutex.new()
var _log_buffer: Array = []
var _log_seq := 0
var _pending_out: Array = []  # log events queued from other threads, flushed on main thread

var _js_callback: JavaScriptObject
var _ws: WebSocketPeer
var _ws_url := ""
var _ws_state := -1
var _ws_retry_at := 0.0
var _user_args := {}


class _BridgeLogger extends Logger:
	var bridge: WeakRef

	func _log_message(message: String, error: bool) -> void:
		var b = bridge.get_ref()
		if b:
			b._push_log("error" if error else "info", message.strip_edges(false, true), {})

	func _log_error(function: String, file: String, line: int, code: String, rationale: String,
			_editor_notify: bool, error_type: int, script_backtraces: Array) -> void:
		var b = bridge.get_ref()
		if not b:
			return
		var kinds := ["error", "warning", "script_error", "shader_error"]
		var bt := []
		for sb in script_backtraces:
			if sb is ScriptBacktrace:
				for i in sb.get_frame_count():
					bt.append("%s:%d in %s()" % [sb.get_frame_file(i), sb.get_frame_line(i), sb.get_frame_function(i)])
		var text := rationale if rationale != "" else code
		b._push_log("warning" if error_type == 1 else "error", text, {
			"kind": kinds[clampi(error_type, 0, 3)], "file": file, "line": line,
			"function": function, "code": code, "backtrace": bt,
		})


func _init() -> void:
	_logger = _BridgeLogger.new()
	_logger.bridge = weakref(self)
	OS.add_logger(_logger)


func _ready() -> void:
	process_mode = Node.PROCESS_MODE_ALWAYS
	_user_args = _parse_user_args()
	if _user_args.has("agent-validate"):
		_run_cli.call_deferred("validate")
		return
	if _user_args.has("agent-run-tests"):
		_run_cli.call_deferred("tests")
		return
	if OS.has_feature("web"):
		_setup_web()
	else:
		_ws_url = str(_user_args.get("agent-bridge-url", OS.get_environment("AGENT_BRIDGE_URL")))
	_send_event("ready", _info())


func _exit_tree() -> void:
	if _logger:
		OS.remove_logger(_logger)


# ---------------------------------------------------------------- transports

func _setup_web() -> void:
	_js_callback = JavaScriptBridge.create_callback(_on_js_message)
	var win = JavaScriptBridge.get_interface("window")
	if win and win.__agentBridgeRegister:
		win.__agentBridgeRegister(_js_callback)


func _on_js_message(args: Array) -> void:
	if args.is_empty():
		return
	_handle_raw(str(args[0]))


func _process(_delta: float) -> void:
	_flush_logs()
	if _ws_url == "":
		return
	var now := Time.get_ticks_msec() / 1000.0
	if _ws == null:
		if now < _ws_retry_at:
			return
		_ws = WebSocketPeer.new()
		_ws.inbound_buffer_size = 16 << 20
		_ws.outbound_buffer_size = 16 << 20
		if _ws.connect_to_url(_ws_url) != OK:
			_ws = null
			_ws_retry_at = now + 3.0
			return
	_ws.poll()
	var state := _ws.get_ready_state()
	if state == WebSocketPeer.STATE_OPEN and _ws_state != state:
		_send_event("ready", _info())
	_ws_state = state
	if state == WebSocketPeer.STATE_OPEN:
		while _ws.get_available_packet_count() > 0:
			_handle_raw(_ws.get_packet().get_string_from_utf8())
	elif state == WebSocketPeer.STATE_CLOSED:
		_ws = null
		_ws_state = -1
		_ws_retry_at = now + 3.0


func _send(msg: Dictionary) -> void:
	var text := JSON.stringify(msg)
	if OS.has_feature("web"):
		var win = JavaScriptBridge.get_interface("window")
		if win and win.__agentBridgeSend:
			win.__agentBridgeSend(text)
	elif _ws and _ws.get_ready_state() == WebSocketPeer.STATE_OPEN:
		_ws.send_text(text)


func _send_event(event: String, data: Dictionary) -> void:
	var msg := {"type": "event", "event": event}
	msg.merge(data)
	_send(msg)


# ---------------------------------------------------------------- logging

func _push_log(level: String, text: String, extra: Dictionary) -> void:
	_log_mutex.lock()
	_log_seq += 1
	var entry := {"seq": _log_seq, "t": Time.get_ticks_msec(), "level": level, "text": text}
	entry.merge(extra)
	_log_buffer.append(entry)
	if _log_buffer.size() > LOG_CAPACITY:
		_log_buffer.pop_front()
	# On web the shell already captures stdout via onPrint; only forward structured errors there.
	if not OS.has_feature("web") or extra.has("kind"):
		_pending_out.append(entry)
	_log_mutex.unlock()


func _flush_logs() -> void:
	if _pending_out.is_empty():
		return
	_log_mutex.lock()
	var batch := _pending_out
	_pending_out = []
	_log_mutex.unlock()
	for e in batch:
		var ev := {"entry": e}
		_send_event("log", ev)


func get_logs(since := 0) -> Array:
	_log_mutex.lock()
	var out := _log_buffer.filter(func(e): return e.seq > since)
	_log_mutex.unlock()
	return out


# ---------------------------------------------------------------- commands

func _handle_raw(text: String) -> void:
	var msg = JSON.parse_string(text)
	if typeof(msg) != TYPE_DICTIONARY or not msg.has("cmd"):
		return
	_dispatch(msg)


func _dispatch(msg: Dictionary) -> void:
	var id = msg.get("id")
	var args: Dictionary = msg.get("args", {}) if typeof(msg.get("args")) == TYPE_DICTIONARY else {}
	var res: Dictionary
	var method := "_cmd_" + str(msg.cmd)
	if not has_method(method):
		res = {"ok": false, "error": "unknown command: %s" % msg.cmd}
	else:
		var r = await call(method, args)
		# Helpers return a tagged envelope ({"_envelope": true, ok, result|error}); anything else is a plain result.
		if typeof(r) == TYPE_DICTIONARY and r.get("_envelope", false):
			res = r.duplicate()
			res.erase("_envelope")
		else:
			res = {"ok": true, "result": r}
	res["type"] = "response"
	res["id"] = id
	if res.has("result"):
		res.result = to_json(res.result)
	_send(res)


func _err(text: String) -> Dictionary:
	return {"_envelope": true, "ok": false, "error": text}


func _cmd_ping(_a: Dictionary) -> Variant:
	return {"pong": true, "protocol": PROTOCOL_VERSION}


func _cmd_info(_a: Dictionary) -> Variant:
	return _info()


func _info() -> Dictionary:
	var scene := get_tree().current_scene
	return {
		"protocol": PROTOCOL_VERSION,
		"engine": Engine.get_version_info().string,
		"project": ProjectSettings.get_setting("application/config/name", ""),
		"scene": scene.scene_file_path if scene else "",
		"platform": OS.get_name(),
		"web": OS.has_feature("web"),
		"headless": DisplayServer.get_name() == "headless",
		"fps": Engine.get_frames_per_second(),
		"frame": Engine.get_process_frames(),
		"paused": get_tree().paused,
		"viewport": get_viewport().get_visible_rect().size,
	}


func _cmd_screenshot(a: Dictionary) -> Variant:
	if DisplayServer.get_name() == "headless":
		return _err("no renderer in headless mode; take screenshots from the browser session")
	await RenderingServer.frame_post_draw
	var img := get_viewport().get_texture().get_image()
	var max_w := int(a.get("max_width", 0))
	if max_w > 0 and img.get_width() > max_w:
		img.resize(max_w, int(img.get_height() * float(max_w) / img.get_width()), Image.INTERPOLATE_BILINEAR)
	var buf := img.save_png_to_buffer() if a.get("format", "png") == "png" else img.save_jpg_to_buffer(0.85)
	return {"width": img.get_width(), "height": img.get_height(), "format": a.get("format", "png"),
		"data": Marshalls.raw_to_base64(buf)}


func _cmd_tree(a: Dictionary) -> Variant:
	var root := _resolve(a.get("path", ""))
	if root == null:
		return _err("node not found: %s" % a.get("path", ""))
	return _describe(root, int(a.get("depth", 4)), bool(a.get("props", false)))


func _describe(n: Node, depth: int, props: bool) -> Dictionary:
	var d := {"name": n.name, "class": n.get_class(), "path": str(n.get_path())}
	var s = n.get_script()
	if s:
		d["script"] = s.resource_path
	if n.scene_file_path != "":
		d["scene"] = n.scene_file_path
	if n is Node2D:
		d["position"] = n.position
		d["visible"] = n.visible
	elif n is Node3D:
		d["position"] = n.position
		d["visible"] = n.visible
	elif n is Control:
		d["position"] = n.position
		d["size"] = n.size
		d["visible"] = n.visible
		if "text" in n:
			d["text"] = n.text
	if props and s:
		var p := {}
		for prop in s.get_script_property_list():
			if prop.usage & PROPERTY_USAGE_SCRIPT_VARIABLE:
				p[prop.name] = n.get(prop.name)
		d["props"] = p
	if depth > 0 and n.get_child_count() > 0:
		d["children"] = n.get_children().map(func(c): return _describe(c, depth - 1, props))
	elif n.get_child_count() > 0:
		d["child_count"] = n.get_child_count()
	return d


func _resolve(path: String) -> Node:
	if path == "" or path == ".":
		return get_tree().current_scene if get_tree().current_scene else get_tree().root
	if path.begins_with("/"):
		return get_tree().root.get_node_or_null(path)
	var scene := get_tree().current_scene
	return scene.get_node_or_null(path) if scene else null


func _cmd_get(a: Dictionary) -> Variant:
	var n := _resolve(a.get("path", ""))
	if n == null:
		return _err("node not found")
	return n.get_indexed(NodePath(a.get("property", "")))


func _cmd_set(a: Dictionary) -> Variant:
	var n := _resolve(a.get("path", ""))
	if n == null:
		return _err("node not found")
	var v = a.get("value")
	if a.has("expr"):
		var ev := _eval(str(a.expr), n)
		if not ev.ok:
			return ev
		ev.erase("_envelope")
		v = ev.result
	n.set_indexed(NodePath(a.get("property", "")), v)
	return n.get_indexed(NodePath(a.get("property", "")))


func _cmd_call(a: Dictionary) -> Variant:
	var n := _resolve(a.get("path", ""))
	if n == null:
		return _err("node not found")
	var m := str(a.get("method", ""))
	if not n.has_method(m):
		return _err("no method %s on %s" % [m, n.get_path()])
	return await n.callv(m, a.get("args", []))


func _cmd_eval(a: Dictionary) -> Variant:
	var n := _resolve(a.get("path", ""))
	var r := _eval(str(a.get("expr", "")), n if n else self)
	return r


func _eval(expr: String, base: Object) -> Dictionary:
	var e := Expression.new()
	var names := PackedStringArray(["tree", "root", "scene", "bridge"])
	var values := [get_tree(), get_tree().root, get_tree().current_scene, self]
	if e.parse(expr, names) != OK:
		return _err("parse error: " + e.get_error_text())
	var v = e.execute(values, base, false)
	if e.has_execute_failed():
		return _err("execute error: " + e.get_error_text())
	return {"_envelope": true, "ok": true, "result": v}


func _cmd_state(_a: Dictionary) -> Variant:
	var out := {"info": _info()}
	var scene := get_tree().current_scene
	if scene and scene.has_method("get_agent_state"):
		out["scene"] = await scene.get_agent_state()
	for child in get_tree().root.get_children():
		if child != scene and child != self and child.has_method("get_agent_state"):
			out[str(child.name)] = await child.get_agent_state()
	return out


func _cmd_logs(a: Dictionary) -> Variant:
	return get_logs(int(a.get("since", 0)))


## Input: {action, pressed?, strength?} | {key:"Space", pressed?} | {mouse:[x,y], button?, pressed?}
## Add "frames": N to press, hold N frames, and release automatically.
func _cmd_input(a: Dictionary) -> Variant:
	var hold := int(a.get("frames", 0))
	var make := func(pressed: bool) -> InputEvent:
		if a.has("action"):
			var ev := InputEventAction.new()
			ev.action = StringName(a.action)
			ev.pressed = pressed
			ev.strength = float(a.get("strength", 1.0)) if pressed else 0.0
			return ev
		if a.has("key"):
			var kev := InputEventKey.new()
			kev.keycode = OS.find_keycode_from_string(str(a.key))
			kev.physical_keycode = kev.keycode
			kev.pressed = pressed
			return kev
		if a.has("mouse"):
			var mev := InputEventMouseButton.new()
			mev.position = Vector2(a.mouse[0], a.mouse[1])
			mev.global_position = mev.position
			mev.button_index = int(a.get("button", MOUSE_BUTTON_LEFT))
			mev.pressed = pressed
			return mev
		return null
	var first = make.call(bool(a.get("pressed", true)))
	if first == null:
		return _err("input needs action, key or mouse")
	if a.has("action") and not InputMap.has_action(StringName(a.action)):
		return _err("unknown action: %s (known: %s)" % [a.action, ", ".join(InputMap.get_actions().filter(func(x): return not str(x).begins_with("ui_")))])
	Input.parse_input_event(first)
	if hold > 0:
		for i in hold:
			await get_tree().process_frame
		Input.parse_input_event(make.call(false))
	return {"sent": true, "held_frames": hold}


func _cmd_wait(a: Dictionary) -> Variant:
	if a.has("seconds"):
		await get_tree().create_timer(float(a.seconds), true, false, true).timeout
	for i in int(a.get("frames", 0)):
		await get_tree().process_frame
	return {"frame": Engine.get_process_frames()}


func _cmd_change_scene(a: Dictionary) -> Variant:
	var err := get_tree().change_scene_to_file(str(a.get("path", "")))
	if err != OK:
		return _err("change_scene failed: %s" % error_string(err))
	await get_tree().scene_changed
	return _info()


func _cmd_reload_scene(_a: Dictionary) -> Variant:
	get_tree().reload_current_scene()
	await get_tree().scene_changed
	return _info()


func _cmd_pause(a: Dictionary) -> Variant:
	get_tree().paused = bool(a.get("paused", true))
	return {"paused": get_tree().paused}


func _cmd_time_scale(a: Dictionary) -> Variant:
	Engine.time_scale = float(a.get("scale", 1.0))
	return {"time_scale": Engine.time_scale}


func _cmd_run_tests(a: Dictionary) -> Variant:
	var runner := preload("res://addons/agent_bridge/test_runner.gd").new()
	add_child(runner)
	var report: Dictionary = await runner.run(str(a.get("filter", "")))
	runner.queue_free()
	return report


# ---------------------------------------------------------------- headless CLI modes

func _run_cli(mode: String) -> void:
	# Free the main scene so it doesn't interfere with validation or tests.
	if get_tree().current_scene:
		get_tree().current_scene.queue_free()
	await get_tree().process_frame
	var report: Dictionary
	if mode == "validate":
		report = preload("res://addons/agent_bridge/validator.gd").new().validate(self)
	else:
		var runner := preload("res://addons/agent_bridge/test_runner.gd").new()
		add_child(runner)
		report = await runner.run(str(_user_args.get("agent-filter", "")))
	var out_path := str(_user_args.get("agent-out", ""))
	var text := JSON.stringify(to_json(report), "  ")
	if out_path != "":
		var f := FileAccess.open(out_path, FileAccess.WRITE)
		f.store_string(text)
		f.close()
	else:
		print(text)
	get_tree().quit(0 if report.get("ok", false) else 1)


func _parse_user_args() -> Dictionary:
	var out := {}
	for arg in OS.get_cmdline_user_args():
		if arg.begins_with("--"):
			var kv := arg.substr(2).split("=", true, 1)
			out[kv[0]] = kv[1] if kv.size() > 1 else true
	return out


# ---------------------------------------------------------------- JSON conversion

static func to_json(v: Variant) -> Variant:
	match typeof(v):
		TYPE_NIL, TYPE_BOOL, TYPE_INT, TYPE_STRING:
			return v
		TYPE_FLOAT:
			return v if is_finite(v) else str(v)
		TYPE_STRING_NAME, TYPE_NODE_PATH:
			return str(v)
		TYPE_VECTOR2, TYPE_VECTOR2I:
			return {"x": v.x, "y": v.y}
		TYPE_VECTOR3, TYPE_VECTOR3I:
			return {"x": v.x, "y": v.y, "z": v.z}
		TYPE_COLOR:
			return "#" + v.to_html()
		TYPE_RECT2, TYPE_RECT2I:
			return {"x": v.position.x, "y": v.position.y, "w": v.size.x, "h": v.size.y}
		TYPE_DICTIONARY:
			var d := {}
			for k in v:
				d[str(k)] = to_json(v[k])
			return d
		TYPE_ARRAY, TYPE_PACKED_STRING_ARRAY, TYPE_PACKED_INT32_ARRAY, TYPE_PACKED_INT64_ARRAY, \
		TYPE_PACKED_FLOAT32_ARRAY, TYPE_PACKED_FLOAT64_ARRAY, TYPE_PACKED_VECTOR2_ARRAY, TYPE_PACKED_VECTOR3_ARRAY:
			var arr := []
			for x in v:
				arr.append(to_json(x))
			return arr
		TYPE_OBJECT:
			if v == null or not is_instance_valid(v):
				return null
			if v is Node:
				return {"node": str(v.get_path()), "class": v.get_class()}
			if v is Resource:
				return {"resource": v.resource_path, "class": v.get_class()}
			return {"object": v.get_class()}
	return var_to_str(v)
