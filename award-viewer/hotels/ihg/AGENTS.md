# AGENTS.md — IHG hotel scope

## Structure
- Keep all IHG-specific logic and UI in this folder.
- If the extension needs an entry point (e.g., `contents/ihg.ts` or `contents/ihg-main.ts`), keep those files as thin re-exports that import from this folder for side effects.
- If background listeners are required, implement them here and have the root background file call into this folder.
