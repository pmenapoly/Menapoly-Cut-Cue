# Menapoly Cue cloud (private remote access)

Use Menapoly Cue from your phone while your Intel Mac does the heavy work. Built and tested locally,
**not deployed**: deploying needs your approval ([blockers.md](blockers.md)).

| Document | |
|---|---|
| **[pilot/APPROVAL-CHECKLIST.md](pilot/APPROVAL-CHECKLIST.md)** | **private pilot on cue.menapoly-digital.com: the one approval checklist** (security gate, paid services, production changes) |
| [pilot/](pilot) | security gate, deployment plan, Mac worker, Android, acceptance test, exact charges |
| [architecture.md](architecture.md) | hosting architecture, flows, security model, Tailscale interim option |
| [costs.md](costs.md) | monthly cost estimate and budget controls |
| [accounts-and-secrets.md](accounts-and-secrets.md) | accounts, resources and secret names (no values) |
| [setup.md](setup.md) | local try-out, Mac worker install, deployment steps |
| [test-results.md](test-results.md) | security, end-to-end and mobile test results |
| [rollback.md](rollback.md) | rollback and emergency stops |
| [blockers.md](blockers.md) | what's still needed and what's unverified |
| [screenshots/](screenshots) | phone-size screenshots from the browser tests |

Code: `cloud/control-plane` (Worker), `cloud/web` (PWA), `backend/cutcue/agent.py` (Mac worker),
`deploy/macos` + `scripts/install_agent_launchd.sh` (launchd), `scripts/cloud_dev.py` (local stack).
