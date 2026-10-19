# Focus definitions sync via Convex; the active Focus is per-machine

Focus definitions (name, Lucide icon, accent color, project assignments) live in Convex so creating or editing a Focus propagates to every machine, mirroring how cloud projects and companies sync. The _selection_ of the active Focus is deliberately machine-local (localStorage, like `activeCompanyIdAtom`): switching to Work on the laptop must not yank every other machine into Work. Client settings alone were rejected because the user works across multiple machines and per-machine Focus lists would drift.
