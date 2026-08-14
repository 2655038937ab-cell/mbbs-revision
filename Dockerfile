FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# Bind to all interfaces inside the container; the platform maps a port to it.
ENV HOST=0.0.0.0
ENV PORT=8756
EXPOSE 8756

# Persistent storage for config.json + data.db (mount this volume).
VOLUME ["/app/data"]

CMD ["python", "server.py"]
