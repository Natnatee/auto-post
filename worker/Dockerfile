FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app
RUN groupadd --gid 10001 worker && useradd --uid 10001 --gid worker --no-create-home worker
COPY --chown=worker:worker worker/ /app/worker/
USER 10001:10001
CMD ["python", "-m", "worker.main"]
