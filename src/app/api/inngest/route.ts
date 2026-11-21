import { serve } from 'inngest/next';
import { inngest } from '@/inngest/client';
import { reviewPullRequest } from '@/inngest/functions/review-pr';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Inngest endpoint for managing background functions and event ingestion.
 */
export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [reviewPullRequest],
});
