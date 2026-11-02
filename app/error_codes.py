"""本地/游戏包共用的错误追踪码生成。"""

import uuid


def create_error_code(prefix: str) -> str:
    """生成带前缀的短追踪码，便于在日志中关联用户报错。"""
    safe_prefix = str(prefix or "ERR")[:8].upper()
    return f"{safe_prefix}-{uuid.uuid4().hex[:8].upper()}"
