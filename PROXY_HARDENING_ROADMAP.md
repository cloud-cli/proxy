# Proxy Hardening Roadmap

This document tracks the security, resilience, and operational work required before using the proxy as the edge of a multi-tenant private cloud. Each item should be implemented and reviewed independently.

## Routing And Tenant Isolation

- Restrict routing to domains and hosts explicitly managed by configured proxy entries.
- Define which forwarding headers are trusted and only honor them from configured trusted proxies.
- Prevent host-header poisoning and ambiguous absolute-form request URLs.
- Validate tenant routes and upstream targets against explicit tenant-owned allowlists.
- Prevent tenant configuration from reaching unauthorized private networks, ports, or metadata endpoints.

## Identity And Access

- Add strong edge authentication such as mTLS, OIDC, JWT validation, or an external identity gateway.
- Add tenant-aware authorization for routes, upstreams, administrative actions, and configuration changes.
- Add configurable per-tenant CORS policies and security response headers.
- Keep an audit trail for authentication, authorization, routing, and configuration decisions.

## Resource And Abuse Controls

- Add maximum request body, header, URL, response, and WebSocket limits.
- Add per-tenant, identity, source-IP, route, and upstream rate limits.
- Add active connection, concurrent request, and WebSocket quotas.
- Protect against slow headers, slow bodies, connection hoarding, and protocol abuse.
- Define safe HTTP/2 and HTTP/3 support or explicitly disable unsupported protocols.

## TLS And Certificates

- Define a minimum TLS version and cipher policy.
- Reject unknown SNI names safely and monitor certificate expiry.
- Add certificate reload health reporting and alerting.
- Define certificate distribution and rotation for multiple proxy instances.

## Upstream Resilience

- Support upstream pools instead of a single target per route.
- Add active health checks and health-aware failover.
- Add circuit breakers with bounded recovery probing.
- Separate connect, TLS handshake, header, body, idle, and total request timeouts.
- Add retries only for safe idempotent requests, with bounded exponential backoff.

## Lifecycle And Availability

- Add graceful shutdown and connection draining with deadlines.
- Add liveness and readiness endpoints with meaningful dependency state.
- Deploy multiple proxy instances behind a load balancer or floating IP.
- Make route and configuration reloads fully validated and atomic.
- Define behavior during configuration, certificate, upstream, and dependency failures.

## Observability

- Add structured production access and security logs without relying on debug console output.
- Add metrics for traffic, latency, status, active connections, upstream failures, timeouts, retries, quotas, and circuit state.
- Generate and propagate correlation IDs.
- Propagate distributed tracing context.
- Alert on certificate expiry, reload failures, unhealthy upstreams, saturation, and elevated error rates.

## Current Increment

The first implementation increment restricts request routing to configured managed domains and validates the host values used for matching. It accepts `Host`, `X-Forwarded-Host`, and RFC 7239 `Forwarded: host=` candidates, and never treats `X-Forwarded-For` as a routing host. Trusted-proxy forwarding policy is tracked separately because it requires an explicit deployment boundary and configuration model.

The opaque proxy contract is implemented: `preserveHost: false` removes inherited routing and provenance headers and sends the target authority as `Host`; `preserveHost: true` explicitly sends the canonical matched host and forwarding metadata. `forwardClientIp` is an opt-in for opaque requests. Managed proxy-to-proxy hops use signed metadata from `proxyLoopSecret`; ordinary opaque origins receive no proxy routing metadata.
