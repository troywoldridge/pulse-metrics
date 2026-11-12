/**
 * Phase 2E3C5D8 — UNMOUNTED enrollment HTTP contract.
 *
 * Never mount either route without independent review of the versioned
 * database migration, transport/TLS, pre-auth network rate limiting, actor
 * rate limiting, trusted WorkOS middleware and secret-delivery lifecycle.
 * These factories accept an explicitly injected service; there is no default
 * database adapter or hidden development bypass.
 */
import type { RequestHandler } from 'express';
import {
  EnrollmentNotAvailable,
  EnrollmentPermissionDenied,
  parseEnrollmentLabel,
  parseRedemptionBody,
  type AgentEnrollmentService,
  type VerifiedActor,
} from './agent-enrollment-service.js';
import { isCanonicalSecret, isValidOrganizationId, isVerifiedActor } from './agent-credential-policy.js';

/**
 * A separate, reviewed ingress middleware MUST set this after checking TLS,
 * network abuse limits and (for issuance) actor quotas. Absent by default.
 * Test-only middleware sets it solely on the isolated loopback server.
 */
function admitted(res: Parameters<RequestHandler>[1]): boolean {
  if (res.locals.agentEnrollmentIngressVerified !== true) {
    res.status(503).json({ error: 'agent_enrollment_disabled' });
    return false;
  }
  return true;
}

function noStore(res: Parameters<RequestHandler>[1]): void {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
}
function invalidMedia(req: Parameters<RequestHandler>[0]): boolean {
  return !req.is('application/json');
}
function errorUnavailable(res: Parameters<RequestHandler>[1]): void {
  res.setHeader('Retry-After', '5');
  res.status(503).json({ error: 'agent_enrollment_unavailable' });
}

/** Intended POST /api/organizations/:organizationId/agent-enrollments. */
export function createIssueAgentEnrollmentRoute(service: AgentEnrollmentService): RequestHandler {
  if (!service || typeof service.issue !== 'function') throw new TypeError('Explicit issue service required');
  return async (req, res) => {
    noStore(res);
    if (!admitted(res)) return;
    const identity: unknown = res.locals.authenticatedIdentity;
    if (!isVerifiedActor(identity)) {
      res.status(401).json({ error: 'authentication_required' });
      return;
    }
    const organizationId: unknown = req.params.organizationId;
    if (!isValidOrganizationId(organizationId)) {
      res.status(400).json({ error: 'invalid_organization_id' });
      return;
    }
    if (invalidMedia(req)) {
      res.status(415).json({ error: 'json_required' });
      return;
    }
    const label = parseEnrollmentLabel(req.body);
    if (label === null) {
      res.status(400).json({ error: 'invalid_enrollment_request' });
      return;
    }
    try {
      // Caller must mount a trusted WorkOS bearer verifier BEFORE this route.
      // PostgreSQL must independently recheck membership and allowed roles.
      const result = await service.issue(identity as VerifiedActor, organizationId, label);
      if (!result || result.organizationId !== organizationId ||
          !isValidOrganizationId(result.enrollmentId) ||
          typeof result.expiresAt !== 'string' ||
          !Number.isFinite(Date.parse(result.expiresAt)) ||
          !isCanonicalSecret(result.oneTimeToken)) {
        throw new Error('Unexpected issuance response');
      }
      res.status(201).json({
        enrollmentId: result.enrollmentId,
        organizationId,
        expiresAt: result.expiresAt,
        oneTimeToken: result.oneTimeToken,
      });
    } catch (error) {
      if (error instanceof EnrollmentPermissionDenied) {
        res.status(403).json({ error: 'organization_access_denied' });
      } else {
        errorUnavailable(res);
      }
    }
  };
}

/** Intended pre-auth POST /api/agent-enrollments/redeem; NOT mounted. */
export function createRedeemAgentEnrollmentRoute(service: AgentEnrollmentService): RequestHandler {
  if (!service || typeof service.redeem !== 'function') throw new TypeError('Explicit redeem service required');
  return async (req, res) => {
    noStore(res);
    if (!admitted(res)) return;
    // Production activation must add a pre-auth IP/network rate limiter at
    // the edge and verified TLS before any untrusted request reaches this route.
    if (invalidMedia(req)) {
      res.status(415).json({ error: 'json_required' });
      return;
    }
    const parsed = parseRedemptionBody(req.body);
    if (!parsed) {
      res.status(400).json({ error: 'invalid_enrollment_request' });
      return;
    }
    try {
      const result = await service.redeem(parsed.token, parsed.agent);
      if (!result || !isValidOrganizationId(result.organizationId) ||
          !isValidOrganizationId(result.agentId) ||
          !isCanonicalSecret(result.machineCredential)) {
        throw new Error('Unexpected machine credential response');
      }
      res.status(201).json({
        organizationId: result.organizationId,
        agentId: result.agentId,
        machineCredential: result.machineCredential,
      });
    } catch (error) {
      if (error instanceof EnrollmentNotAvailable) {
        // Uniform denial for unknown, used, expired and revoked enrollments.
        res.status(404).json({ error: 'enrollment_unavailable' });
      } else {
        errorUnavailable(res);
      }
    }
  };
}
