---
version: 1
slug: "src-app-tsx"
primary_target: "src/App.tsx"
related_targets: ["src/workspace.css","src/BrainLibrary.tsx","src/NativeCodexChat.tsx","src/ResizablePanes.tsx","src/AgentPicker.tsx","src/CodexControls.tsx"]
---

# Workspace điều phối cá nhân

Mode: Operate. Preserve the existing green-charcoal and amber identity. User-pinned layout: https://capture.avada.io/i/g4MUCONkt8Ra (10/11/2026).

## Direction contract

THESIS: A personal workspace with tasks beside agent instructions and files in reach.

OWN-WORLD: Existing dark green panels, amber selection, thin dividers, sans working text and monospace paths. Extend the existing identity without new decoration.

STORY: Choose the workspace, see verified agent connections, maintain a local checklist, chat with the selected native Codex agent and see its public reply/activity, and inspect project files. Preserve the original Brain library as a secondary view.

FIRST VIEWPORT: A narrow workspace rail at left; agent strip across the top; two central columns for checklist and agent chat, initially equal with a draggable separator; a folder/file tree at the far right. On small screens use task/chat/file tabs and a workspace drawer. Signature interaction: a checklist item can move into the instruction draft while the selected file stays visible.

FORM: The user's annotated five-region reference is the composition authority; code-led implementation, seed: none (unavailable). No invented agents, messages, tasks or completion status.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

## Boundaries

Project files and the personal Brain stay read-only. Checklist state is app-local. No automatic agent prompts, startup, hidden delegation or merchant actions. The user-selected Codex chat streams only public messages/activity from its verified native session; private reasoning, system/developer messages and tool logs stay excluded. Explicit instruction submission must bind a fresh terminal identity to the selected workspace and report acceptance separately from completion. Screenshots use synthetic fixtures only.

## Scoped refinement — 10/11/2026

Reference `https://capture.avada.io/i/Zmug4QPQxAnS`: make the task field focus frame match its complete boundary, and permit left/right resizing between checklist and chat. Preserve the five-region composition, palette, native chat binding and checklist data. The separator supports pointer and keyboard input, clamps pane widths on smaller desktop windows and is hidden on mobile. No transcript or model request is triggered by resizing.

## Task deletion — 10/11/2026

Reference `https://capture.avada.io/i/k0YZwFY8LdiF`: add a visible task delete button beside the task-to-chat action at the row's right edge. Operate extension using existing Lucide icons, focus and error colors. Delete only after an explicit user click and successful local API response; retain the row on error, update counts and announce success, preserve keyboard focus. No real user task is deleted during testing.

## Session controls — 10/11/2026

Pinned references: `https://capture.avada.io/i/s1l4IFt4gGmF` and `https://capture.avada.io/i/y7qaXtU3zxZq`. Add Edit/pencil for the agent display name synchronized to Orca. Context used/total belongs between conversation and composer. Permission, model and Fast controls belong below the textarea next to Send and wrap on mobile. Preserve current native session, draft, public activity and panel layout. Controls send only explicit typed choices; observe actual settings and pending confirmation, never infer success from input acceptance. Native approval UI is handled by the user, never auto-confirmed by the bridge. No real agent settings are changed for tests.
