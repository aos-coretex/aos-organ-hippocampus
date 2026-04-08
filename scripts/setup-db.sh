#!/bin/bash
# Hippocampus database setup — PostgreSQL 17 with pgvector
# Run once on each machine. Idempotent.

set -euo pipefail

DB_NAME="hippocampus"
DB_USER="graphheight_sys"
DB_HOST="localhost"
DB_PORT="5432"

echo "Creating database '$DB_NAME' if not exists..."
psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d postgres -tc \
  "SELECT 1 FROM pg_database WHERE datname = '$DB_NAME'" | grep -q 1 || \
  psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d postgres -c \
  "CREATE DATABASE $DB_NAME OWNER $DB_USER"

echo "Enabling pgvector extension..."
psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -c \
  "CREATE EXTENSION IF NOT EXISTS vector"

echo "Running migration..."
psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -f \
  "$(dirname "$0")/../server/db/migrations/001-initial-schema.sql"

echo "Hippocampus database setup complete."
