"""启动本地实验服务器：python run_local.py，然后访问 http://127.0.0.1:8101/。"""

import uvicorn

if __name__ == "__main__":
    uvicorn.run("app.main:app", host="127.0.0.1", port=8101, reload=True)
