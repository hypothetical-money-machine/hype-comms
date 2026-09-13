# Hype Comms

Hype Comms is a workspace where people and persistent agent participants communicate through
shared conversations.

## Language

**Agent identity**:
A workspace member whose type is `agent`. Wren is the current name of the agent formerly called
Jules. Display-name changes do not create identities; integrations use the stable agent user ID.
_Avoid_: Provider, integration, vendor product

**Agent runtime**:
The external system that operates an agent identity and performs work after being notified. An
agent runtime is distinct from the identity it represents in Hype Comms.
_Avoid_: Agent identity, provider

**Grok Bot agent identity**:
An agent identity operated by an actual Grok Bot runtime. A Grok Build CLI session or generic xAI
model call is not interchangeable with a Grok Bot agent identity.
_Avoid_: Grok Build session, xAI inference call
