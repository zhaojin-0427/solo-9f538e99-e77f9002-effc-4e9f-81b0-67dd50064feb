FROM python:3.12-slim

WORKDIR /app

# 构建上下文为仓库根（见 docker-compose.yml 的 build: .），
# 依赖清单与应用代码都在 app/ 子目录中。
COPY app/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

# 只把运行所需的 app/ 内容放进镜像（app.py、templates、static）
COPY app/ ./

EXPOSE 8000

# 非 root 运行
RUN useradd --create-home --uid 10001 braille
USER braille

CMD ["python", "app.py"]
