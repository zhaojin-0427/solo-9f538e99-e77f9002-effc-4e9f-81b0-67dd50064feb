FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

EXPOSE 8000

# 非 root 运行
RUN useradd --create-home --uid 10001 braille
USER braille

CMD ["python", "app.py"]
