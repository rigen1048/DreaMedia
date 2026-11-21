# DreaMedia Privacy Model

DreaMedia exists for a specific privacy goal:

> Keep the convenience of a personal media account without requiring a platform to own the user’s subscriptions, attention rules, watch history, or progress.

## The problem it addresses

A platform account is convenient because it remembers everything for you. It can also become a detailed behavioral profile:

- what you follow;
- what you watch;
- when you watch;
- what you abandon;
- what you search for;
- what recommendations you accept;
- which creators and subjects interest you.

DreaMedia moves the personal media graph into a user-controlled instance.

## What DreaMedia changes

A typical platform-centric relationship looks like:

```text
User → platform account → subscriptions, recommendations, history, progress
```

A DreaMedia relationship looks like:

```text
User → DreaMedia instance → subscriptions, policies, queues, progress
  │
  └── canonical links and supported public source data from external providers
```

DreaMedia does not need to become a replacement content platform. The user can use a hardened browser, reject unnecessary cookies, use a VPN, and remain signed out of Google while DreaMedia preserves personal continuity.

## Trust boundaries

DreaMedia does not remove trust. It changes where trust is placed.

### The self-hosted server

The server administrator can access the host, database files, logs, backups, and process memory. A self-hosted deployment must therefore protect the machine, filesystem, Docker access, and backup directory.

### External providers

YouTube, AniList, and other supported providers can observe requests made to them and control the availability or shape of public metadata. They remain source dependencies, not owners of the DreaMedia personal graph.

### VPN provider

A VPN provider can observe network metadata according to its own policy. A VPN is not a replacement for application privacy.

### Browser and extension

The browser and extension can observe pages where the extension is enabled. DreaMedia uses an extension token rather than the web session cookie and supports an explicit domain allowlist.

## Data protection controls

The implementation includes:

- Argon2id password hashing.
- HttpOnly, SameSite session cookies.
- Random session tokens.
- Per-user encryption keys derived at login.
- AEAD encryption for stored user content.
- Blind indexes for equality and uniqueness checks.
- Hashed, revocable extension tokens.
- A token-protected backend-to-bridge push lane.
- Session-authenticated browser reads from the bridge.
- Admin checks on GraphQL and REST admin operations.
- Validated restore filenames and upload archives.

## What is encrypted

User-controlled content such as names, links, titles, category labels, and notification payloads is designed to be stored encrypted at rest. PostgreSQL backups therefore contain ciphertext for those fields.

Encryption at rest does not protect a running, logged-in server from the server administrator or from a compromised application process. It primarily protects database contents at rest and reduces exposure from someone who can read the database without the user’s password-derived key.

## Portable exports

Portable exports are intentionally readable so they can survive schema changes and be migrated. Treat them as sensitive files. Anyone who can read a portable export may learn about the user’s subscriptions, queues, progress, and categories.

Recommended handling:

- store exports on encrypted storage;
- avoid sending them through unencrypted chat or email;
- delete temporary copies;
- keep database dumps and portable exports separate;
- use a strong host login and filesystem permissions.

## Deployment hardening

For a serious deployment:

1. Keep DreaMedia on localhost or a trusted LAN.
2. Use a reverse proxy with TLS for remote access.
3. Do not expose PostgreSQL directly to the internet.
4. Protect the backup directory.
5. Use a strong PostgreSQL password and DreaMedia password.
6. Rotate the extension token if it may have been exposed.
7. Keep the operating system, Docker, browser, and dependencies updated.
8. Store at least one verified backup offline or on separate storage.
9. Review which extension domains are enabled.
10. Do not use demo credentials in production.

## Privacy philosophy

DreaMedia does not require the user to hate YouTube or abandon creators. It separates the useful source relationship from the platform’s attention machinery.

The user can:

- follow creators directly;
- receive a deliberate, chronological feed;
- open canonical creator links;
- support creators through normal platform mechanisms;
- keep their own subscription memory and watch progress;
- avoid giving a hosted intermediary ownership of that personal graph.

Privacy here is not a request to tolerate a worse experience. It is an attempt to make the private path the more useful path.
