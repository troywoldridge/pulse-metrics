/**
 * D13 — UNMOUNTED preauthorization and redemption route factories.
 * Both require a separately reviewed ingress guard to set the marker after
 * trusted HTTPS origin, network quotas and (for issuance) actor quotas.
 * Neither factory is mounted in server.ts; no production activation exists.
 */
import type { RequestHandler, Response } from 'express';
import {
  isCanonicalSecret,
  isValidOrganizationId,
  isVerifiedActor,
} from './agent-credential-policy.js';
import {
  EnrollmentNotAvailable,
  EnrollmentPermissionDenied,
  parseRedemptionBody,
  type VerifiedActor,
} from './agent-enrollment-service.js';
import {
  parsePreauthorizationBody,
  type PreauthorizedEnrollmentService,
} from './agent-preauthorization.js';

function noStore(res: Response): void {
  res.setHeader('Cache-Control','no-store');
  res.setHeader('Pragma','no-cache');
  res.setHeader('Referrer-Policy','no-referrer');
  res.setHeader('X-Content-Type-Options','nosniff');
}
function admitted(res: Response): boolean {
  if (res.locals.agentEnrollmentIngressVerified !== true) {
    res.status(503).json({error:'agent_enrollment_disabled'});
    return false;
  }
  return true;
}
function unavailable(res: Response): void {
  res.setHeader('Retry-After','5');
  res.status(503).json({error:'agent_enrollment_unavailable'});
}

/** Intended POST /api/organizations/:organizationId/agent-enrollments/preauthorize. */
export function createIssuePreallocatedEnrollmentRoute(service: PreauthorizedEnrollmentService): RequestHandler {
  if (!service || typeof service.issue !== 'function') throw new TypeError('Explicit service required');
  return async (req, res) => {
    noStore(res);
    if (!admitted(res)) return;
    const verified: unknown = res.locals.authenticatedIdentity;
    if (!isVerifiedActor(verified)) {
      res.status(401).json({error:'authentication_required'}); return;
    }
    const organizationId: unknown = req.params.organizationId;
    if (!isValidOrganizationId(organizationId)) {
      res.status(400).json({error:'invalid_organization_id'}); return;
    }
    if (!req.is('application/json')) {
      res.status(415).json({error:'json_required'}); return;
    }
    const parsed = parsePreauthorizationBody(req.body);
    if (!parsed) { res.status(400).json({error:'invalid_enrollment_request'}); return; }
    try {
      const data = await service.issue(verified as VerifiedActor,
        organizationId,parsed.label,parsed.agent);
      if (!data || data.organizationId !== organizationId ||
          !isValidOrganizationId(data.agentId) ||
          !isValidOrganizationId(data.enrollmentId) ||
          !Number.isFinite(Date.parse(data.expiresAt)) ||
          !isCanonicalSecret(data.oneTimeToken)) {
        throw new Error('Unexpected response');
      }
      res.status(201).json(data);
    } catch (error) {
      if (error instanceof EnrollmentPermissionDenied) {
        res.status(403).json({error:'organization_access_denied'});
      } else { unavailable(res); }
    }
  };
}

/** Intended pre-auth POST /api/agent-enrollments/redeem, versioned D13 handler. */
export function createRedeemPreallocatedEnrollmentRoute(service: PreauthorizedEnrollmentService): RequestHandler {
  if (!service || typeof service.redeem !== 'function') throw new TypeError('Explicit service required');
  return async (req,res) => {
    noStore(res);
    if (!admitted(res)) return;
    // The pre-auth network limiter and trusted TLS must have already run.
    if (!req.is('application/json')) {
      res.status(415).json({error:'json_required'}); return;
    }
    const body = parseRedemptionBody(req.body);
    if (!body) { res.status(400).json({error:'invalid_enrollment_request'}); return; }
    try {
      const data = await service.redeem(body.token,body.agent);
      if (!data || !isValidOrganizationId(data.organizationId) ||
          !isValidOrganizationId(data.agentId) ||
          !isCanonicalSecret(data.machineCredential)) {
        throw new Error('Unexpected response');
      }
      res.status(201).json(data);
    } catch (error) {
      if (error instanceof EnrollmentNotAvailable) {
        res.status(404).json({error:'enrollment_unavailable'});
      } else { unavailable(res); }
    }
  };
}
