.PHONY: help bootstrap sync-contracts lint test test-contract test-backend test-extension build-extension start-backend

PYTHON := backend/.venv/bin/python
UV := uv

help:
	@echo "Supervisely Hybrid QC Assistant — Targets:"
	@echo "  bootstrap        Create backend/.venv with uv and install Python + npm deps"
	@echo "  sync-contracts   Regenerate shared/schemas/qc-contract.schema.json & verify TS parity"
	@echo "  lint             Run ruff, mypy, and tsc typecheck"
	@echo "  test             Run contract, backend, and extension unit tests"
	@echo "  test-e2e         Build extension and run Playwright E2E suite"
	@echo "  build-extension  Build Chrome MV3 extension into extension/dist"
	@echo "  start-backend    Start FastAPI local server on 127.0.0.1:8765"

bootstrap:
	$(UV) sync --directory backend --frozen --extra dev
	npm ci

sync-contracts:
	$(PYTHON) scripts/sync_contracts.py

lint:
	backend/.venv/bin/ruff check backend scripts tests
	backend/.venv/bin/mypy backend/app
	npm run typecheck

test-contract:
	$(PYTHON) scripts/sync_contracts.py --check
	backend/.venv/bin/pytest tests/contract

test-backend:
	backend/.venv/bin/pytest tests/backend

test-extension:
	npm run test

test: test-contract test-backend test-extension

test-e2e: build-extension
	npm run test:e2e

build-extension:
	npm run build

start-backend:
	SLY_QC_ALLOW_UNPACKED_EXTENSIONS=true $(PYTHON) backend/main.py
