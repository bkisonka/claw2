// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

/**
 * Docker API guard proxy entry point (compose: claw2 image, mounted
 * docker.sock, internal control network only).
 */
import { startDockerGuardFromEnv } from "./docker-guard.js";

startDockerGuardFromEnv();
