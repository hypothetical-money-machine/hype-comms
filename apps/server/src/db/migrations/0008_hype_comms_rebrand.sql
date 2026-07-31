UPDATE workspaces
   SET name = 'Hype Comms',
       updated_at = clock_timestamp()
 WHERE slug = 'hmm-chat'
   AND name = 'HMM Chat';
