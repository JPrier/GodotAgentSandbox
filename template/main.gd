extends Node2D
## Starter game: move the square (arrows/WASD) and collect coins.

const SPEED := 320.0
const PICKUP_RADIUS := 28.0

var score := 0

@onready var player: Node2D = $Player
@onready var coin: Node2D = $Coin
@onready var score_label: Label = $UI/Score


func _ready() -> void:
	randomize()
	_place_coin()
	_update_label()


func _physics_process(delta: float) -> void:
	var dir := Input.get_vector("move_left", "move_right", "move_up", "move_down")
	var bounds := get_viewport_rect().size
	player.position = (player.position + dir * SPEED * delta).clamp(Vector2(16, 16), bounds - Vector2(16, 16))
	if player.position.distance_to(coin.position) < PICKUP_RADIUS:
		score += 1
		_update_label()
		_place_coin()


func _place_coin() -> void:
	var bounds := get_viewport_rect().size
	coin.position = Vector2(randf_range(40, bounds.x - 40), randf_range(80, bounds.y - 40))


func _update_label() -> void:
	score_label.text = "Score: %d" % score


## Picked up by AgentBridge's "state" command — expose whatever an agent should see.
func get_agent_state() -> Dictionary:
	return {"score": score, "player": player.position, "coin": coin.position}
