import { Inngest } from 'inngest';

/**
 * Payload interface for the 'vigilpr/pr.review.requested' event.
 */
export interface PRReviewRequestedEventData {
  installationId: number;
  owner: string;
  repo: string;
  pullNumber: number;
  commitSha: string;
  prTitle: string;
  prBody: string | null;
  prAuthor: string;
  action: string;
  prKey: string;
}

/**
 * Strongly-typed event map for VigilPR Inngest events.
 */
export type VigilPREvents = {
  'vigilpr/pr.review.requested': {
    data: PRReviewRequestedEventData;
  };
};

/**
 * Global Inngest client for VigilPR background task orchestration.
 */
export const inngest = new Inngest({
  id: 'vigilpr',
});
