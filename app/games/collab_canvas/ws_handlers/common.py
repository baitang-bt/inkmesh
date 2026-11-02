"""合作画板 WS 消息子模块共用依赖。"""
from __future__ import annotations

import json
import logging
import time
import uuid
from typing import Dict, Optional, Tuple

from fastapi import WebSocket

from app.games.collab_canvas import room_store as store
from app.games.collab_canvas.protocol import (
    BOARD_CREATE_COOLDOWN_SEC,
    DEFAULT_BOARD_ID,
    DEFAULT_LAYER_ID,
    MAX_BOARDS_PER_ROOM,
    MAX_LAYERS_PER_BOARD,
    MAX_PLAYERS_PER_ROOM,
)
from app.games.common.drawing_board import (
    append_stroke_segment,
    append_stroke_segments,
    clear_layer_strokes,
    create_board_layer,
    duplicate_board_layer,
    ensure_drawable_paint_layer,
    get_layer,
    is_group_layer,
    is_layer_locked,
    is_paint_layer,
    layer_has_strokes,
    layer_parent_id,
    migrate_board_layers,
    normalize_segment,
    redo_player_stroke,
    reparent_group_children,
    serialize_canvas,
    serialize_layers,
    serialize_strokes,
    top_paint_layer_id,
    undo_player_stroke,
)
from app.games.common.lobby import MAX_ROOM_ID_LENGTH
from app.games.common.room_registry import evict_from_other_games

logger = logging.getLogger(__name__)

rooms = store.rooms
player_rooms = store.player_rooms
timed_out_rooms = store.timed_out_rooms
RESERVED_SEGMENTS = store.RESERVED_SEGMENTS
GAME_ID = store.GAME_ID
create_room = store.create_room
create_board = store.create_board
get_board = store.get_board
send_json = store.send_json
send_error = store.send_error
broadcast = store.broadcast
broadcast_to_board = store.broadcast_to_board
broadcast_room_state = store.broadcast_room_state
broadcast_room_state_light = store.broadcast_room_state_light
build_room_state = store.build_room_state
build_drawing_sync = store.build_drawing_sync
ensure_board = store.ensure_board
resolve_layer_id = store.resolve_layer_id
resolve_draw_layer_id = store.resolve_draw_layer_id
is_room_host = store.is_room_host
player_can_draw = store.player_can_draw
player_can_save = store.player_can_save
parse_display_name = store.parse_display_name
parse_label_color = store.parse_label_color
is_valid_room_path_id = store.is_valid_room_path_id
remove_player_from_room = store.remove_player_from_room
handle_player_disconnect = store.handle_player_disconnect
import_pbcc_document = store.import_pbcc_document
room_has_user_strokes = store.room_has_user_strokes
board_has_drawn_strokes = store.board_has_drawn_strokes
top_layer_id = store.top_layer_id
serialize_boards_meta = store.serialize_boards_meta
serialize_players = store.serialize_players
