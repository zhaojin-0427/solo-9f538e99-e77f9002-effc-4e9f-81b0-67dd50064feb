"""Flask 入口：提供六键盲文练习页。"""
from flask import Flask, render_template

app = Flask(__name__)


@app.route("/")
def index():
    return render_template("index.html")


if __name__ == "__main__":
    # 容器内监听所有网卡；debug 关闭，避免重载器干扰
    app.run(host="0.0.0.0", port=8000)
