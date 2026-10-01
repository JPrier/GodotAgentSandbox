extends GameTest


func test_main_scene_loads():
	var main = await load_scene("res://main.tscn")
	assert_has_node(main, "Player")
	assert_eq(main.score, 0, "starting score")


func test_player_moves_right():
	var main = await load_scene("res://main.tscn")
	main.coin.position = Vector2(-1000, -1000)  # keep the coin out of the way
	var start: float = main.player.position.x
	await hold_action("move_right", 20)
	assert_gt(main.player.position.x, start + 50.0, "player x after holding right")


func test_collecting_coin_scores():
	var main = await load_scene("res://main.tscn")
	main.coin.position = main.player.position + Vector2(10, 0)
	await wait_physics_frames(2)
	assert_eq(main.score, 1, "score after touching coin")
