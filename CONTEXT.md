# Hype Comms

Hype Comms is a workspace where people and persistent agent participants communicate through
shared conversations.

## Language

**Agent identity**:
A workspace member whose type is `agent`. Wren is the current name of the agent formerly called
Jules and owns the desktop Wake slice. That assignment does not make Wren a provider or a separate
rollout target. Display-name changes do not create identities; Wake bindings use the stable agent
user ID, never a display name.
_Avoid_: Provider, integration, vendor product

**Agent runtime**:
The external system that operates an agent identity and performs work after being notified. An
agent runtime is distinct from the identity it represents in Hype Comms.
_Avoid_: Agent identity, provider

**Wake**:
A body-free notification that one specific post-enrollment message is eligible to activate one
agent identity. It is a pointer to work, not message content or conversation history.
_Avoid_: Prompt, message dump, history replay

**Wake host**:
The elected desktop installation responsible for delivering wakes for one agent identity to its
agent runtime.
_Avoid_: Agent identity, agent runtime

**Grok Bot agent identity**:
An agent identity operated by an actual Grok Bot runtime. A Grok Build CLI session or generic xAI
model call is not interchangeable with a Grok Bot agent identity.
_Avoid_: Grok Build session, xAI inference call
