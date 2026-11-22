# DreaMedia Documentation

DreaMedia uses several focused documents instead of putting product philosophy, installation, feature details, privacy, architecture, and contribution guidance into one very long README. The main [README](README.md) links these guides, while the installation and feature guides cross-reference each other with stable Markdown reference links.

## Start here

- [Main README](README.md) — product identity, HydraWatch lineage, philosophy, quick start, and documentation map.
- [Features](FEATURES.md) — detailed feature inventory and user workflows.
- [Installation](INSTALL.md) — setup, configuration, extension installation, backups, updates, and troubleshooting.
- [Privacy model](PRIVACY.md) — threat model, trust boundaries, encryption, and hardening.
- [Architecture](ARCHITECTURE.md) — backend, frontend, extension, workers, data flow, restore design, and current internal diagrams.
- [Contributing](CONTRIBUTING.md) — product principles, development setup, testing, and contribution expectations.

## Existing project documentation

- [Frontend UX specification](docs/frontend_ux.md)
- [Extension README](Extension/README.md)
- [Extension design record](Extension/Docs/extension-design.md)
- [Backend notes](BACKEND_TODO.md)
- [QA browser flow](qa/e2e.py)

## HydraWatch predecessor

DreaMedia continues the ideas introduced by [HydraWatch](https://github.com/rigen1048/HydraWatch):

- algorithm-free chronological source feeds;
- user-defined category trees;
- official-source polling;
- local-first privacy;
- hardened-browser compatibility;
- creator-respecting canonical links;
- CSV portability.

DreaMedia expands those ideas into a broader personal media memory system for YouTube, anime, watch progress, queues, browser tracking, and recoverable administration.

It also formalizes the backend around extensible media-source boundaries and fault-tolerant workers. The successor is therefore not only a feature expansion; it is a more general platform for adding new kinds of media without sacrificing durable state, recovery, privacy, or notification semantics.
