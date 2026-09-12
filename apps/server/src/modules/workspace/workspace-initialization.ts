import type { Pool } from "pg";

/** Persist the one-way cutover before this process begins serving default-agency traffic. */
export async function enableDefaultAgentAgency(pool: Pool): Promise<void> {
  await pool.query(
    `UPDATE workspaces
          SET default_agent_agency_available = true
        WHERE default_agent_agency_available = false`,
  );
}
