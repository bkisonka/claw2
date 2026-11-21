// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_URL?: string;
  readonly VITE_API_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
