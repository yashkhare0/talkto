/**
 * Auth middleware — resolves the current user and workspace for every request.
 *
 * Three auth paths (checked in order):
 * 1. Session cookie (`talkto_session`) → resolves human user + workspace
 * 2. API key (`Authorization: Bearer tk_...`) → resolves workspace (for agents)
 * 3. Localhost bypass → default workspace, auto-resolve local human
 *
 * After resolution, sets `c.set("auth", authContext)` for downstream handlers.
 */

import { createMiddleware } from "hono/factory";
import type { AppBindings, AuthContext } from "../types/index";
import {
  extractSessionToken,
  validateSession,
  validateApiKey,
  isLocalhost,
  getLocalhostAuth,
  API_KEY_PREFIX,
} from "../services/auth-service";
import { config } from "../lib/config";

/**
 * Paths that skip auth entirely (public endpoints).
 * Health check must always be accessible.
 */
const PUBLIC_PATHS = new Set([
  "/api/health",
  "/api/join", // Invite acceptance (has its own token validation)
]);

/**
 * Check if a path should skip auth.
 */
function isPublicPath(path: string): boolean {
  if (PUBLIC_PATHS.has(path)) return true;
  // /api/join/:token is public
  if (path.startsWith("/api/join/")) return true;
  return false;
}

/**
 * Auth middleware for REST API routes (`/api/*`).
 *
 * Sets `c.var.auth` (AuthContext) on every request.
 * Returns 401 if authentication fails for non-localhost requests.
 */
export const authMiddleware = createMiddleware<AppBindings>(
  async (c, next) => {
    // Skip auth for public paths
    if (isPublicPath(c.req.path)) {
      // Set a minimal auth context for public endpoints
      c.set("auth", {
        userId: null,
        workspaceId: "",
        role: "none",
        authMethod: "localhost",
      } as AuthContext);
      return next();
    }

    // --- Path 1: Session cookie ---
    const cookieHeader = c.req.header("Cookie");
    const sessionToken = extractSessionToken(cookieHeader);

    if (sessionToken) {
      const auth = await validateSession(sessionToken);
      if (auth) {
        c.set("auth", auth);
        return next();
      }
      // Invalid/expired session — fall through to other methods
    }

    // --- Path 2: API key (Authorization: Bearer tk_...) ---
    const authHeader = c.req.header("Authorization");
    if (authHeader?.startsWith("Bearer ")) {
      const token = authHeader.slice(7);
      if (token.startsWith(API_KEY_PREFIX)) {
        const result = await validateApiKey(token);
        if (result) {
          c.set("auth", {
            userId: null, // API keys don't identify a specific user
            workspaceId: result.workspaceId,
            role: "member", // API key grants member-level access
            authMethod: "apikey",
          } as AuthContext);
          return next();
        }
        return c.json({ error: "Invalid or revoked API key" }, 401);
      }
    }

    // --- Path 3: Localhost bypass ---
    // When not in network mode OR request is from localhost,
    // allow unauthenticated access to the default workspace.
    const remoteAddr = c.req.header("X-Forwarded-For") ?? c.req.header("X-Real-IP");

    // In non-network mode, all requests are assumed local
    // In network mode, check the actual remote address
    const isLocal = !config.network || isLocalhost(remoteAddr);

    if (isLocal) {
      const auth = await getLocalhostAuth();
      c.set("auth", auth);
      return next();
    }

    // --- No valid auth ---
    return c.json({ error: "Authentication required" }, 401);
  }
);

/**
 * MCP auth middleware — validates API key for agent MCP connections.
 *
 * For MCP, auth is simpler: either an API key or localhost bypass.
 * Session cookies are not used for MCP (agents don't have browser sessions).
 */
export const mcpAuthMiddleware = createMiddleware<AppBindings>(
  async (c, next) => {
    // --- Path 1: API key ---
    const authHeader = c.req.header("Authorization");
    if (authHeader?.startsWith("Bearer ")) {
      const token = authHeader.slice(7);
      if (token.startsWith(API_KEY_PREFIX)) {
        const result = await validateApiKey(token);
        if (result) {
          c.set("auth", {
            userId: null,
            workspaceId: result.workspaceId,
            role: "member",
            authMethod: "apikey",
          } as AuthContext);
          return next();
        }
        return c.json({ error: "Invalid or revoked API key" }, 401);
      }
    }

    // --- Path 2: Localhost bypass ---
    const remoteAddr = c.req.header("X-Forwarded-For") ?? c.req.header("X-Real-IP");
    const isLocal = !config.network || isLocalhost(remoteAddr);

    if (isLocal) {
      const auth = await getLocalhostAuth();
      c.set("auth", auth);
      return next();
    }

    return c.json({ error: "API key required for remote MCP access" }, 401);
  }
);

/**
 * Require admin role. Use after authMiddleware.
 */
export const requireAdmin = createMiddleware<AppBindings>(
  async (c, next) => {
    const auth = c.get("auth");
    if (!auth || auth.role !== "admin") {
      return c.json({ error: "Admin access required" }, 403);
    }
    return next();
  }
);

/**
 * Require an authenticated user (userId must be set).
 * Localhost access without onboarding has userId=null.
 */
export const requireUser = createMiddleware<AppBindings>(
  async (c, next) => {
    const auth = c.get("auth");
    if (!auth || !auth.userId) {
      return c.json({ error: "User identity required — please onboard first" }, 401);
    }
    return next();
  }
);
