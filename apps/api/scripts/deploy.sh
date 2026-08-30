#!/usr/bin/env bash
# One-command Docker deployment for Compendium.
# Usage: bash scripts/deploy.sh
set -euo pipefail

COMPOSE="docker compose"

echo "=== Building images ==="
$COMPOSE build

echo "=== Running database migrations ==="
$COMPOSE run --rm backend python -m backend.db.migrate

echo "=== Starting services ==="
$COMPOSE up -d

echo "=== Waiting for backend to be ready ==="
for i in $(seq 1 30); do
    if curl -sf http://localhost:8001/health > /dev/null 2>&1; then
        echo "Backend is healthy."
        break
    fi
    if [ "$i" -eq 30 ]; then
        echo "ERROR: Backend did not become healthy within 30 seconds."
        $COMPOSE logs backend --tail 20
        exit 1
    fi
    sleep 1
done

echo "=== Waiting for frontend to be ready ==="
# Dash boot is heavier than uvicorn (theme regen, font scan, transitive backend
# imports), so we allow 60s. Curling `/` catches both "container died on import"
# and "container is up but server isn't bound" -- the failure mode that bit us
# before this check existed (frontend crashed silently while deploy.sh declared
# success based on backend-only health).
for i in $(seq 1 60); do
    if curl -sf http://localhost:8050/ > /dev/null 2>&1; then
        echo "Frontend is healthy."
        break
    fi
    if [ "$i" -eq 60 ]; then
        echo "ERROR: Frontend did not become healthy within 60 seconds."
        $COMPOSE logs frontend --tail 30
        exit 1
    fi
    sleep 1
done

echo ""
echo "=== Deployment complete ==="
echo "  Backend API:  http://localhost:8001"
echo "  API docs:     http://localhost:8001/docs"
echo "  Frontend:     http://localhost:8050"
echo "  Health check: http://localhost:8001/health"
echo "  Metrics:      http://localhost:8001/metrics"
echo ""
echo "To view logs:   $COMPOSE logs -f"
echo "To stop:        $COMPOSE down"
