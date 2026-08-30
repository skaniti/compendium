#!/usr/bin/env bash
# Auto-create the test database when the postgres container starts.
# Mounted as a docker-entrypoint-initdb.d script — runs on first start only.
set -e

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
    CREATE DATABASE traversal_discovery_test;
EOSQL

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "traversal_discovery_test" <<-EOSQL
    CREATE EXTENSION IF NOT EXISTS vector;
EOSQL

echo "Test database 'traversal_discovery_test' created with pgvector extension."
